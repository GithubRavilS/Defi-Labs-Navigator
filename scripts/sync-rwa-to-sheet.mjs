/**
 * Синхронизация RWA: Jupiter → лист «БИТВА ПУЛОВ RWA» (как Apps Script).
 * node scripts/sync-rwa-to-sheet.mjs
 * Опционально: JUPITER_API_KEY=... в окружении (бесплатный ключ portal.jup.ag).
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
const SHEET = 'БИТВА ПУЛОВ RWA';
const JUPITER = 'https://api.jup.ag/portfolio/v1';

function parseWallet(v) {
  const s = String(v || '').trim();
  const m = s.match(/portfolio\/([1-9A-HJ-NP-Za-km-z]{32,44})/i) || s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? m[1] : '';
}

function isLiq(el) {
  if (!el || el.networkId !== 'solana') return false;
  if (el.type === 'borrowlend' || el.label === 'Lending') return false;
  const pid = String(el.platformId || '').toLowerCase();
  if (pid.includes('kamino') && (el.type === 'borrowlend' || el.label === 'Lending')) return false;
  if (el.type === 'liquidity' || el.label === 'LiquidityPool') return true;
  if (el.type === 'multiple' && el.label === 'LiquidityPool') return true;
  return false;
}

function apyPct(el, liq) {
  let f = el?.netApy;
  if (f == null && liq?.yields?.[0]) f = liq.yields[0].apy ?? liq.yields[0].apr;
  if (f == null) return '0';
  const n = Number(f);
  const pct = n <= 1 && n >= -1 ? n * 100 : n;
  return String(Math.round(pct * 10) / 10);
}

function sym(asset, tokenInfo) {
  const a = asset?.data?.address;
  if (tokenInfo?.solana?.[a]?.symbol) return tokenInfo.solana[a].symbol;
  return asset?.data?.symbol || '';
}

async function fetchJupiter(wallet) {
  const headers = { Accept: 'application/json' };
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
  await new Promise((r) => setTimeout(r, 2200));
  const res = await fetch(`${JUPITER}/positions/${wallet}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jupiter ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function toRows(payload, wallet) {
  const tokenInfo = payload.tokenInfo || {};
  const rows = [];
  const seen = new Set();
  for (const el of payload.elements || []) {
    if (!isLiq(el)) continue;
    const liqs = el.type === 'liquidity' && el.data?.liquidities?.length ? el.data.liquidities : [null];
    for (const liq of liqs) {
      const platform = /raydium/i.test(el.platformId || '') ? 'Raydium' : /orca/i.test(el.platformId || '') ? 'Orca' : (el.name || el.platformId || 'RWA');
      const pair = (liq?.assets || []).map((a) => sym(a, tokenInfo)).filter(Boolean).join(' / ') || (liq?.name || '');
      const link = liq?.link || el.data?.link || `https://jup.ag/portfolio/${wallet}`;
      const key = link + '|' + platform;
      if (seen.has(key)) continue;
      seen.add(key);
      const feeM = String(liq?.name || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
      const fee = feeM ? feeM[1].replace(',', '.') : '';
      rows.push({ platform, apy: apyPct(el, liq), pair, link, fee });
    }
  }
  return rows.sort((a, b) => parseFloat(b.apy) - parseFloat(a.apy));
}

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '..', 'pusher-490008-bf7c384ba372.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const q = `'${SHEET.replace(/'/g, "''")}'`;

const bCol = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${q}!B1:B25` });
let wallet = '';
for (const row of bCol.data.values || []) {
  wallet = parseWallet(row[0]);
  if (wallet) break;
}
if (!wallet) {
  console.error('Кошелёк не найден в B1:B25. Вставьте ссылку jup.ag/portfolio/… в B6.');
  process.exit(1);
}
console.log('Wallet:', wallet);

const payload = await fetchJupiter(wallet);
const rows = toRows(payload, wallet);
console.log('Positions to write:', rows.length);

const headerRow = 7;
const dataStart = headerRow + 1;
await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${q}!A${dataStart}:U200` });

if (!rows.length) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${q}!D2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[`0 поз. · ${new Date().toISOString()}`]] },
  });
  process.exit(0);
}

const primary = rows.map((r) => [r.platform, r.apy, '0 дн', 'active', r.link, r.fee ? `solana ${r.fee}%` : 'solana', r.pair]);
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A${dataStart}`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: primary },
});

const auxHeaders = [
  '', '', '', '', '', '', '',
  'Платформа', 'Мин диапазона', 'Макс диапазон', 'Дата открытия норм',
  'Заработано стейблов', 'Заработано BTC', 'Заработано CAKE', 'Заработано AERO',
  'Итого комс доход', 'валютка', 'Блокчейн', 'fee_tier', 'APR', 'APY', 'ссылка',
];
const auxHeaderRow = dataStart + primary.length + 2;
const today = new Date().toLocaleDateString('ru-RU');
const aux = rows.map((r) => {
  const line = new Array(auxHeaders.length).fill('');
  line[7] = r.platform;
  line[10] = today;
  line[15] = r.pair;
  line[16] = 'solana';
  line[17] = r.fee ? `${r.fee}%` : '';
  line[18] = r.apy;
  line[19] = r.apy;
  line[20] = r.link;
  return line;
});

await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A${auxHeaderRow}`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: [auxHeaders, ...aux] },
});

await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!D2`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: [[`OK · ${rows.length} поз.`]] },
});

console.log('Done. Rows written:', rows.length);
