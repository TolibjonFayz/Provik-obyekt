const { Pool } = require('pg');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is not set!');
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
});

// Deterministic secret derived from AUTH_SECRET or DATABASE_URL so sessions survive cold starts
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update(String(connectionString || 'provik-fallback-secret')).digest('hex');
const COOKIE_NAME = 'provik_session';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let tablesInitialized = false;

async function initTables() {
  if (tablesInitialized) return;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS provik_docs (
        id VARCHAR(50) PRIMARY KEY,
        collection VARCHAR(50) NOT NULL,
        doc_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_collection ON provik_docs(collection)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS provik_auth (
        id VARCHAR(50) PRIMARY KEY,
        password_hash TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS provik_backups (
        backup_date VARCHAR(20) PRIMARY KEY,
        snapshot JSONB NOT NULL,
        record_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    tablesInitialized = true;
  } finally {
    client.release();
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const derived = crypto.scryptSync(String(password), salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

async function ensureAdminPassword() {
  await initTables();
  const res = await pool.query('SELECT password_hash FROM provik_auth WHERE id = $1', ['admin']);
  if (res.rows.length > 0) {
    return res.rows[0].password_hash;
  }
  const initialPassword = process.env.ADMIN_PASSWORD || 'provik2026';
  const hash = hashPassword(initialPassword);
  await pool.query(
    'INSERT INTO provik_auth (id, password_hash) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    ['admin', hash]
  );
  const check = await pool.query('SELECT password_hash FROM provik_auth WHERE id = $1', ['admin']);
  return check.rows[0].password_hash;
}

function signToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function getSessionFromReq(req) {
  const cookies = parseCookies(req);
  let token = cookies[COOKIE_NAME];
  if (!token && req.headers && req.headers.authorization) {
    const m = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
    if (m) token = m[1];
  }
  return verifyToken(token);
}

function setSessionCookie(res, req, token) {
  const isHttps = (req.headers['x-forwarded-proto'] === 'https') || (req.connection && req.connection.encrypted);
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAge}`
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, req) {
  const isHttps = (req.headers['x-forwarded-proto'] === 'https') || (req.connection && req.connection.encrypted);
  const parts = [
    `${COOKIE_NAME}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=0`
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

module.exports = {
  pool,
  TOKEN_TTL_MS,
  initTables,
  hashPassword,
  verifyPassword,
  ensureAdminPassword,
  signToken,
  getSessionFromReq,
  setSessionCookie,
  clearSessionCookie
};
