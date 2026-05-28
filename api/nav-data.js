const { verifyNavToken, assertNavSession, getCookie, fetchJsonpAsJson } = require('../lib/nav-auth');
const { getNavigatorDataFromSheets } = require('../lib/sheet-get-data');

const COOKIE = 'defilabs_nav';

function readAuthToken(req) {
  let raw = getCookie(req, COOKIE);
  if (raw) return raw;
  if (req.method !== 'POST') return '';
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  if (body && body.token) return String(body.token).trim();
  return '';
}

async function loadNavigatorData() {
  try {
    const direct = await getNavigatorDataFromSheets();
    if (direct && direct.tools && direct.tools.length) return direct;
  } catch (e) {
    console.warn('nav-data sheets-direct', e.message || e);
  }

  const sheetUrl =
    process.env.NAVIGATOR_SHEETS_JSONP_URL ||
    'https://script.google.com/macros/s/AKfycbzyLXhoOxNmJS6TQNPkWvYRV33aAVFFC1QDp5Whn2iIE7C94rkRes_8qp_yWrY9Z69uFA/exec';
  return fetchJsonpAsJson(sheetUrl);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method' });
    return;
  }

  const secret = process.env.NAVIGATOR_JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'config' });
    return;
  }

  const raw = readAuthToken(req);
  if (!raw) {
    res.status(401).json({ error: 'auth' });
    return;
  }

  const decoded = verifyNavToken(raw, secret);
  if (!decoded) {
    res.status(401).json({ error: 'auth' });
    return;
  }

  try {
    const ok = await assertNavSession(decoded);
    if (!ok) {
      res.status(401).json({ error: 'auth' });
      return;
    }
  } catch (e) {
    console.error('nav-data session', e);
    res.status(500).json({ error: 'server' });
    return;
  }

  try {
    const data = await loadNavigatorData();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(JSON.stringify(data));
  } catch (e) {
    console.error('nav-data fetch', e);
    res.status(502).json({ error: 'upstream', categories: [], tools: [] });
  }
};
