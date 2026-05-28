/**
 * Создаёт лист «Битва пуллов RWA» и строку rwa в metadata (если ещё нет).
 * Запуск: node scripts/setup-rwa-sheet.mjs
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
const RWA_SHEET_TITLE = 'Битва пуллов RWA';

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '..', 'pusher-490008-bf7c384ba372.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
const titles = meta.data.sheets.map((s) => s.properties.title);

if (!titles.includes(RWA_SHEET_TITLE)) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: RWA_SHEET_TITLE } } }],
    },
  });
  console.log('Created sheet:', RWA_SHEET_TITLE);
} else {
  console.log('Sheet exists:', RWA_SHEET_TITLE);
}

const md = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: 'metadata!A:A',
});
const ids = (md.data.values || []).map((r) => r[0]);
if (!ids.includes('rwa')) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'metadata!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        [
          'rwa',
          'RWA · Solana',
          '🏛️',
          'Liquidity pool на Solana (Jupiter Portfolio)',
          '#C9A227',
        ],
      ],
    },
  });
  console.log('Added metadata row: rwa');
}

const template = [
  ['DeFi Labs Navigator — RWA (Solana)', '', '', '', '', ''],
  ['Кошелёк Jupiter (ссылка или адрес):', '', '', '', '', ''],
  ['', '', '', '', '', ''],
  ['', '', '', '', '', ''],
  ['', '', '', '', '', ''],
  ['', '', '', '', '', ''],
  ['name', 'apy', 'period', 'status', 'link', 'description', 'pair'],
];

const q = `'${RWA_SHEET_TITLE.replace(/'/g, "''")}'!A1:G7`;
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: q,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: template },
});

console.log('Template written. Put wallet URL in cell B6 on sheet «' + RWA_SHEET_TITLE + '».');
console.log('Share spreadsheet with editor access for:', (await auth.getClient()).email || 'service account');
