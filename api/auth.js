const {
  pool,
  TOKEN_TTL_MS,
  hashPassword,
  verifyPassword,
  ensureAdminPassword,
  signToken,
  getSessionFromReq,
  setSessionCookie,
  clearSessionCookie
} = require('./_lib');

module.exports = async function handler(req, res) {
  try {
    const { method, body } = req;

    if (method === 'GET') {
      const session = getSessionFromReq(req);
      if (!session) {
        return res.status(401).json({ authenticated: false });
      }
      return res.status(200).json({ authenticated: true, role: session.role || 'admin' });
    }

    if (method === 'POST') {
      const action = (body && body.action) || (req.query && req.query.action) || 'login';

      if (action === 'logout') {
        clearSessionCookie(res, req);
        return res.status(200).json({ ok: true });
      }

      if (action === 'login') {
        const password = body && body.password;
        if (!password || typeof password !== 'string') {
          return res.status(400).json({ error: 'Parol kiritilmagan' });
        }
        const storedHash = await ensureAdminPassword();
        if (!verifyPassword(password, storedHash)) {
          return res.status(401).json({ error: "Parol noto'g'ri" });
        }
        const token = signToken({ role: 'admin', iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
        setSessionCookie(res, req, token);
        return res.status(200).json({ ok: true, token });
      }

      if (action === 'change-password') {
        const session = getSessionFromReq(req);
        if (!session) {
          return res.status(401).json({ error: 'Avval tizimga kiring' });
        }
        const { currentPassword, newPassword } = body || {};
        if (!currentPassword || !newPassword || typeof newPassword !== 'string') {
          return res.status(400).json({ error: 'Joriy va yangi parolni kiriting' });
        }
        if (newPassword.length < 4) {
          return res.status(400).json({ error: 'Yangi parol kamida 4 ta belgidan iborat bo‘lishi kerak' });
        }
        const storedHash = await ensureAdminPassword();
        if (!verifyPassword(currentPassword, storedHash)) {
          return res.status(401).json({ error: "Joriy parol noto'g'ri" });
        }
        const newHash = hashPassword(newPassword);
        await pool.query(
          'UPDATE provik_auth SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [newHash, 'admin']
        );
        const token = signToken({ role: 'admin', iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
        setSessionCookie(res, req, token);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).end(`Method ${method} Not Allowed`);
  } catch (error) {
    console.error('Auth Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
