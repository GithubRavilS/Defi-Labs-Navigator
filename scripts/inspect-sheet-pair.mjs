/**
 * Читает таблицу через Google API: выводит заголовки и колонку pair на листах с инструментами.
 * node scripts/inspect-sheet-pair.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SPREADSHEET_ID = '1NjN5ELRjNVlFSVfJLCQsho32Kod5HRA4JWakZ7KVsJY';
const CRED = path.join(ROOT, 'pusher-490008-bf7c384ba372.json');

function norm(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
}

async function main() {
  if (!fs.existsSync(CRED)) {
    console.error('No credentials file:', CRED);
    process.exit(1);
  }
  const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: cred,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(title))',
  });
  const list = meta.data.sheets || [];
  console.log('Sheets:', list.map((s) => s.properties.title).join(' | '));
  console.log('---');

  for (let s = 1; s < list.length; s++) {
    const title = list[s].properties.title;
    const range = `'${String(title).replace(/'/g, "''")}'!A:ZZ`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const rows = res.data.values || [];
    if (!rows.length) {
      console.log(`[${title}] empty`);
      continue;
    }
    const headers = (rows[0] || []).map(norm);
    const pairIdx = headers.findIndex((h) => h === 'pair');
    const pairIdxLoose = headers.findIndex((h) => h === 'pair' || h.startsWith('pair'));
    console.log(`\n[${title}]`);
    console.log('  headers count:', headers.length);
    console.log('  pair column index (exact "pair"):', pairIdx);
    console.log('  pair column index (startsWith pair):', pairIdxLoose);
    console.log('  all headers:', JSON.stringify(headers));
    if (rows[1]) {
      const r1 = rows[1];
      const pExact = pairIdx >= 0 ? r1[pairIdx] : '(n/a)';
      console.log('  row1 pair @exact:', pExact);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
