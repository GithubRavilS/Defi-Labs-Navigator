const { verifyNavToken, assertNavSession, getCookie } = require('../lib/nav-auth');

const COOKIE = 'defilabs_nav';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false });
    return;
  }

  const secret = process.env.NAVIGATOR_JWT_SECRET;
  if (!secret) {
    res.status(500).json({ ok: false, error: 'config' });
    return;
  }

  const raw = getCookie(req, COOKIE);
  if (!raw) {
    res.status(401).json({ ok: false });
    return;
  }

  const decoded = verifyNavToken(raw, secret);
  if (!decoded) {
    res.status(401).json({ ok: false });
    return;
  }

  try {
    const ok = await assertNavSession(decoded);
    if (!ok) {
      res.status(401).json({ ok: false });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('nav-session', e);
    res.status(500).json({ ok: false });
  }
};
