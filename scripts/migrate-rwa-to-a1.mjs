/**
 * Перенос блока H30 → единая таблица A1 на листе «БИТВА ПУЛОВ RWA».
 * node scripts/migrate-rwa-to-a1.mjs
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
const SHEET = 'БИТВА ПУЛОВ RWA';
const WALLET = 'GFVsoeaHSFYaXXxMdYqYPMvkD3wJH6xmR6umLceWzXxs';
const LABELS = [
  'Платформа', 'Мин диапазона', 'Макс диапазон', 'Дата открытия норм',
  'Заработано стейблов USD', 'Заработано актива', 'Символ актива', 'Заработано AERO',
  'Итого комс доход USD', 'Пара', 'Блокчейн', 'fee_tier', 'APR', 'APY', 'Ссылка', 'Инвестировано USD',
];

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '..', 'pusher-490008-bf7c384ba372.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const q = `'${SHEET.replace(/'/g, "''")}'`;

const all = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A1:W120`,
});
const data = all.data.values || [];

function norm(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

let headerRow = -1;
let startCol = 0;
for (let r = 0; r < data.length; r++) {
  const row = data[r] || [];
  const h0 = norm(row[0]);
  const h7 = norm(row[7]);
  if (h0 === 'платформа' || h7 === 'платформа') {
    headerRow = r;
    startCol = h0 === 'платформа' ? 0 : 7;
    break;
  }
}
if (headerRow < 0) {
  console.error('Блок «Платформа» не найден');
  process.exit(1);
}

const lines = [];
for (let r = headerRow + 1; r < data.length; r++) {
  const row = data[r] || [];
  if (!String(row[startCol] || '').trim()) {
    if (lines.length) break;
    continue;
  }
  lines.push(row.slice(startCol, startCol + LABELS.length));
}

const block = [LABELS, ...lines];
while (block.length < 2) block.push(LABELS.map(() => ''));

await sheets.spreadsheets.values.clear({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A1:W120`,
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A1`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: block },
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!Z1:Z2`,
  valueInputOption: 'USER_ENTERED',
  requestBody: {
    values: [
      ['Кошелёк Jupiter'],
      [`https://jup.ag/portfolio/${WALLET}`],
    ],
  },
});

console.log(`OK: ${lines.length} строк RWA → A1, кошелёк Z2`);
