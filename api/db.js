const { Pool } = require('pg');

// Neon Database ga ulanish kodi
const connectionString = process.env.DATABASE_URL || "postgresql://neondb_owner:npg_zAs6HaRkhcf1@ep-summer-feather-b3q6g326-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const pool = new Pool({
  connectionString,
});

// Jadval (table) yaratilganligini kuzatuvchi o'zgaruvchi
let tableInitialized = false;

async function initTable() {
  if (tableInitialized) return;
  const client = await pool.connect();
  try {
    // Loyiha uchun universal NoSQL kabi ishlaydigan bitta jadval yaratamiz
    await client.query(`
      CREATE TABLE IF NOT EXISTS provik_docs (
        id VARCHAR(50) PRIMARY KEY,
        collection VARCHAR(50) NOT NULL,
        doc_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Tez ishlashi uchun index qo'shamiz
    await client.query(`CREATE INDEX IF NOT EXISTS idx_collection ON provik_docs(collection)`);
    tableInitialized = true;
  } finally {
    client.release();
  }
}

module.exports = async function handler(req, res) {
  try {
    await initTable();
    const { method, query, body } = req;
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
      return res.status(200).json({ id: newId });
    }
    
    if (method === 'PUT' && id) {
      // Birinchi navbatda eski ma'lumotni olib, yangisiga qo'shamiz (Update logic)
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
