const { pool, initTables, getSessionFromReq } = require('./_lib');

function getTashkentDateStr() {
  // Asia/Tashkent is UTC+5
  const now = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

async function createDailyBackupSnapshot(dateStr) {
  const rowsRes = await pool.query('SELECT id, collection, doc_data FROM provik_docs');
  const snapshot = { objects: {}, entries: {}, payments: {}, workers: {} };
  let count = 0;
  rowsRes.rows.forEach(r => {
    if (!snapshot[r.collection]) snapshot[r.collection] = {};
    snapshot[r.collection][r.id] = r.doc_data;
    count++;
  });
  await pool.query(
    `INSERT INTO provik_backups (backup_date, snapshot, record_count, created_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (backup_date)
     DO UPDATE SET snapshot = EXCLUDED.snapshot, record_count = EXCLUDED.record_count, created_at = CURRENT_TIMESTAMP`,
    [dateStr, snapshot, count]
  );
  // Keep only last 30 daily backups
  await pool.query(
    `DELETE FROM provik_backups WHERE backup_date NOT IN (
       SELECT backup_date FROM provik_backups ORDER BY backup_date DESC LIMIT 30
     )`
  );
  return { backup_date: dateStr, record_count: count };
}

let lastAutoBackupDate = '';

async function maybeAutoDailyBackup() {
  const today = getTashkentDateStr();
  if (lastAutoBackupDate === today) return;
  try {
    const existing = await pool.query('SELECT backup_date FROM provik_backups WHERE backup_date = $1', [today]);
    if (existing.rows.length === 0) {
      const cntRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM provik_docs');
      if (cntRes.rows[0] && cntRes.rows[0].cnt > 0) {
        await createDailyBackupSnapshot(today);
      }
    }
    lastAutoBackupDate = today;
  } catch (e) {
    console.error('Auto backup check error:', e.message);
  }
}

module.exports = async function handler(req, res) {
  try {
    // Require valid authenticated session for all DB operations
    const session = getSessionFromReq(req);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await initTables();
    const { method, query, body } = req;
    const action = query.action;

    // Daily backup endpoints
    if (action === 'backups' && method === 'GET') {
      const list = await pool.query(
        'SELECT backup_date, record_count, created_at FROM provik_backups ORDER BY backup_date DESC LIMIT 30'
      );
      return res.status(200).json({ backups: list.rows });
    }

    if (action === 'backup-data' && method === 'GET') {
      const date = query.date;
      if (!date) return res.status(400).json({ error: 'Date is required' });
      const row = await pool.query('SELECT snapshot FROM provik_backups WHERE backup_date = $1', [date]);
      if (row.rows.length === 0) return res.status(404).json({ error: 'Backup not found' });
      return res.status(200).json(row.rows[0].snapshot);
    }

    if (action === 'backup-now' && method === 'POST') {
      const today = getTashkentDateStr();
      const info = await createDailyBackupSnapshot(today);
      lastAutoBackupDate = today;
      return res.status(200).json({ ok: true, ...info });
    }

    if (action === 'restore-backup' && method === 'POST') {
      const date = (body && body.date) || query.date;
      if (!date) return res.status(400).json({ error: 'Date is required' });
      const row = await pool.query('SELECT snapshot FROM provik_backups WHERE backup_date = $1', [date]);
      if (row.rows.length === 0) return res.status(404).json({ error: 'Backup not found' });
      const snap = row.rows[0].snapshot || {};
      let restored = 0;
      for (const colName of ['objects', 'entries', 'payments', 'workers']) {
        const col = snap[colName];
        if (!col || typeof col !== 'object') continue;
        for (const [docId, docData] of Object.entries(col)) {
          await pool.query(
            `INSERT INTO provik_docs (id, collection, doc_data)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET collection = EXCLUDED.collection, doc_data = EXCLUDED.doc_data`,
            [docId, colName, docData]
          );
          restored++;
        }
      }
      return res.status(200).json({ ok: true, restored });
    }

    // Standard collection CRUD
    const collection = query.collection;
    const id = query.id;

    if (!collection) {
      return res.status(400).json({ error: 'Collection is required' });
    }

    if (method === 'GET') {
      const result = await pool.query('SELECT id, doc_data FROM provik_docs WHERE collection = $1', [collection]);
      const data = {};
      result.rows.forEach(row => {
        data[row.id] = row.doc_data;
      });
      if (collection === 'objects') {
        await maybeAutoDailyBackup();
      }
      return res.status(200).json(data);
    }

    if (method === 'POST') {
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const docData = body || {};
      docData.createdAt = docData.createdAt || Date.now();

      await pool.query(
        'INSERT INTO provik_docs (id, collection, doc_data) VALUES ($1, $2, $3)',
        [newId, collection, docData]
      );
      lastAutoBackupDate = ''; // mark so today's backup refreshes on next check if needed
      return res.status(200).json({ id: newId });
    }

    if (method === 'PUT' && id) {
      const existing = await pool.query('SELECT doc_data FROM provik_docs WHERE id = $1 AND collection = $2', [id, collection]);
      let docData = body || {};

      if (existing.rows.length > 0) {
        docData = { ...existing.rows[0].doc_data, ...docData };
        await pool.query(
          'UPDATE provik_docs SET doc_data = $1 WHERE id = $2 AND collection = $3',
          [docData, id, collection]
        );
      } else {
        await pool.query(
          'INSERT INTO provik_docs (id, collection, doc_data) VALUES ($1, $2, $3)',
          [id, collection, docData]
        );
      }
      return res.status(200).json({ success: true });
    }

    if (method === 'DELETE' && id) {
      await pool.query('DELETE FROM provik_docs WHERE id = $1 AND collection = $2', [id, collection]);
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    return res.status(405).end(`Method ${method} Not Allowed`);
  } catch (error) {
    console.error('Database Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
