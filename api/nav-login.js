const {
  verifyNavPassword,
  signNavToken,
  getCookie,
} = require('../lib/nav-auth');

const COOKIE = 'defilabs_nav';
const COOKIE_MAX_AGE = 60 * 24 * 60 * 60;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method' });
    return;
  }

  const secret = process.env.NAVIGATOR_JWT_SECRET;
  if (!secret || secret.length < 16) {
    res.status(500).json({ ok: false, error: 'config' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }

  const password = body && body.password != null ? String(body.password).trim() : '';
  if (!password) {
    res.status(400).json({ ok: false, error: 'password_required' });
    return;
  }

  try {
    const result = await verifyNavPassword(password);
    if (!result.ok) {
      res.status(401).json({ ok: false, error: result.reason || 'denied' });
      return;
    }
    const token = signNavToken(
      {
        clientId: result.clientId,
        codeVersion: result.codeVersion,
        validUntil: result.validUntil,
      },
      secret
    );
    const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`
    );
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('nav-login', e);
    res.status(500).json({ ok: false, error: 'server' });
  }
};
