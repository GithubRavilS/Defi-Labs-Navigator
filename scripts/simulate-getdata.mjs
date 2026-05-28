/**
 * Полная симуляция getData() для unified A1 — проверка APY/fee/period/RWA.
 * node scripts/simulate-getdata.mjs
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '..', 'pusher-490008-bf7c384ba372.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const api = google.sheets({ version: 'v4', auth });

function norm(h) {
  return String(h || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isUnified(headers) {
  let hp = false, hm = false;
  for (const h of headers) {
    if (/^(платформа|platform)$/.test(h)) hp = true;
    if (/мин.*диапаз/.test(h)) hm = true;
  }
  return hp && hm;
}

function findCol(headers, patterns, fb = -1) {
  for (let i = 0; i < headers.length; i++) {
    for (const p of patterns) if (p.test(headers[i])) return i;
  }
  return fb;
}

function normalizeApyFromCell(val) {
  return String(val == null ? '' : val).replace(/%/g, '').trim();
}

function formatApyForApi(rawVal, displayVal) {
  const disp = displayVal != null ? String(displayVal).trim() : '';
  if (disp && disp.includes('%')) return normalizeApyFromCell(disp);
  if (typeof rawVal === 'number' && !isNaN(rawVal)) {
    if (rawVal > 0 && rawVal <= 1.5) return String(Math.round(rawVal * 1000) / 10);
    if (rawVal > 1.5) return String(Math.round(rawVal * 10) / 10);
  }
  return normalizeApyFromCell(rawVal) || normalizeApyFromCell(disp) || '0';
}

function formatFeeForApi(rawVal, displayVal) {
  const disp = displayVal != null ? String(displayVal).trim() : '';
  if (disp && disp.includes('%')) return disp.replace(/%/g, '').replace(',', '.').trim();
  if (typeof rawVal === 'number' && !isNaN(rawVal) && rawVal > 0 && rawVal < 0.5) {
    return String(Math.round(rawVal * 10000) / 100);
  }
  return String(rawVal || disp || '').replace(/%/g, '').replace(',', '.').trim();
}

function periodFromOpenDateCell(rawVal, displayVal) {
  const s = String(displayVal || '').trim();
  let m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const opened = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    if (!isNaN(opened.getTime())) {
      return Math.max(0, Math.floor((Date.now() - opened.getTime()) / 86400000)) + ' дн';
    }
  }
  if (typeof rawVal === 'number' && rawVal > 20000 && rawVal < 80000) {
    const base = new Date(Date.UTC(1899, 11, 30));
    const opened = new Date(base.getTime() + Math.round(rawVal) * 86400000);
    if (!isNaN(opened.getTime())) {
      return Math.max(0, Math.floor((Date.now() - opened.getTime()) / 86400000)) + ' дн';
    }
  }
  return '';
}

function parseSheet(sheetName, values, display) {
  let hr = -1;
  for (let r = 0; r < Math.min(values.length, 20); r++) {
    if (isUnified((values[r] || []).map(norm))) { hr = r; break; }
  }
  if (hr < 0) return { error: 'no header', count: 0 };

  const headers = (values[hr] || []).map(norm);
  const cols = {
    platform: findCol(headers, [/^(платформа|platform)$/], 0),
    min: findCol(headers, [/мин.*диапаз/], 1),
    max: findCol(headers, [/макс.*диапаз/], 2),
    open: findCol(headers, [/дата.*открыт/], 3),
    pair: findCol(headers, [/^(пара|pair)$/]),
    chain: findCol(headers, [/^(блокчейн|chain)$/]),
    fee: findCol(headers, [/fee_tier|fee tier|fee/]),
    apy: findCol(headers, [/^(apy)$/]),
    link: findCol(headers, [/ссылка|link|url/]),
  };

  const tools = [];
  for (let r = hr + 1; r < values.length; r++) {
    const row = values[r] || [];
    const disp = display[r] || row;
    const name = String(disp[cols.platform] ?? row[cols.platform] ?? '').trim();
    if (!name) continue;
    tools.push({
      name,
      apy: formatApyForApi(row[cols.apy], disp[cols.apy]),
      fee: formatFeeForApi(row[cols.fee], disp[cols.fee]),
      period: periodFromOpenDateCell(row[cols.open], disp[cols.open]),
      priceMin: typeof row[cols.min] === 'number' ? row[cols.min] : disp[cols.min],
      priceMax: typeof row[cols.max] === 'number' ? row[cols.max] : disp[cols.max],
      pair: disp[cols.pair],
    });
  }
  return { count: tools.length, sample: tools[0], tools };
}

for (const sheet of ['ethereum', 'bitcoin', 'БИТВА ПУЛОВ RWA']) {
  const q = `'${sheet.replace(/'/g, "''")}'`;
  const [v, d] = await Promise.all([
    api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${q}!A1:O80`, valueRenderOption: 'UNFORMATTED_VALUE' }),
    api.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${q}!A1:O80`, valueRenderOption: 'FORMATTED_VALUE' }),
  ]);
  const res = parseSheet(sheet, v.data.values || [], d.data.values || []);
  console.log(`\n=== ${sheet} (${res.count}) ===`);
  console.log(JSON.stringify(res.sample, null, 2));
}
