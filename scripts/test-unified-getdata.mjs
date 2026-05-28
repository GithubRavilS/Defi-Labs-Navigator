/**
 * Локальная проверка парсинга единой таблицы A1 (как getData в Apps Script).
 * node scripts/test-unified-getdata.mjs
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
const SHEETS = ['ethereum', 'bitcoin', 'БИТВА ПУЛОВ RWA'];

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '..', 'pusher-490008-bf7c384ba372.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const api = google.sheets({ version: 'v4', auth });

function norm(h) {
  return String(h || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isUnified(headers) {
  let hasPlatform = false;
  let hasMin = false;
  for (const h of headers) {
    if (/^(платформа|platform)$/.test(h)) hasPlatform = true;
    if (/мин.*диапаз/.test(h)) hasMin = true;
  }
  return hasPlatform && hasMin;
}

function findCol(headers, patterns, fallback = -1) {
  for (let i = 0; i < headers.length; i++) {
    for (const p of patterns) {
      if (p.test(headers[i])) return i;
    }
  }
  return fallback;
}

function parseSheet(name, values, display) {
  let headerRow = -1;
  for (let r = 0; r < Math.min(values.length, 20); r++) {
    const headers = (values[r] || []).map(norm);
    if (isUnified(headers)) {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) return { error: 'no unified header', count: 0 };

  const headers = (values[headerRow] || []).map(norm);
  const cols = {
    platform: findCol(headers, [/^(платформа|platform)$/], 0),
    min: findCol(headers, [/мин.*диапаз/], 1),
    max: findCol(headers, [/макс.*диапаз/], 2),
    pair: findCol(headers, [/^(пара|pair)$/]),
    chain: findCol(headers, [/^(блокчейн|chain)$/]),
    fee: findCol(headers, [/fee_tier|fee tier|fee/]),
    apy: findCol(headers, [/^(apy)$/]),
    link: findCol(headers, [/ссылка|link|url/]),
  };

  const tools = [];
  for (let r = headerRow + 1; r < values.length; r++) {
    const row = values[r] || [];
    const disp = display[r] || row;
    const platform = String(disp[cols.platform] ?? row[cols.platform] ?? '').trim();
    if (!platform) continue;
    const rawApy = cols.apy >= 0 ? row[cols.apy] : '';
    const dispApy = cols.apy >= 0 ? disp[cols.apy] : '';
    let apy = '';
    if (String(dispApy).includes('%')) apy = String(dispApy).replace('%', '').trim();
    else if (typeof rawApy === 'number' && rawApy > 0 && rawApy <= 1.5) apy = String(Math.round(rawApy * 1000) / 10);
    else apy = String(dispApy || rawApy || '').trim();

    const fmtRange = (idx) => {
      const raw = row[idx];
      if (typeof raw === 'number' && !isNaN(raw)) return String(Math.round(raw * 10000) / 10000);
      return String(disp[idx] ?? raw ?? '').replace(/\s*дн\s*$/i, '').trim();
    };

    tools.push({
      name: platform,
      pair: cols.pair >= 0 ? String(disp[cols.pair] ?? '').trim() : '',
      chain: cols.chain >= 0 ? String(disp[cols.chain] ?? '').trim() : '',
      fee: cols.fee >= 0 ? String(disp[cols.fee] ?? '').trim() : '',
      apy,
      priceMin: cols.min >= 0 ? fmtRange(cols.min) : '',
      priceMax: cols.max >= 0 ? fmtRange(cols.max) : '',
      link: cols.link >= 0 ? String(disp[cols.link] ?? row[cols.link] ?? '').trim() : '',
    });
  }
  return { count: tools.length, sample: tools[0], last: tools[tools.length - 1] };
}

for (const sheet of SHEETS) {
  const q = `'${sheet.replace(/'/g, "''")}'`;
  const [v, d] = await Promise.all([
    api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${q}!A1:Q80` }),
    api.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${q}!A1:Q80`,
      valueRenderOption: 'FORMATTED_VALUE',
    }),
  ]);
  const res = parseSheet(sheet, v.data.values || [], d.data.values || []);
  console.log(`\n=== ${sheet} ===`, JSON.stringify(res, null, 2));
}
