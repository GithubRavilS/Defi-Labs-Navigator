/**
 * Заполнение листа «БИТВА ПУЛОВ RWA» — единая таблица с A1.
 * node scripts/fill-rwa-positions.mjs
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BATTLE_SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
const SHEET = 'БИТВА ПУЛОВ RWA';
const WALLET = 'GFVsoeaHSFYaXXxMdYqYPMvkD3wJH6xmR6umLceWzXxs';
const PORTFOLIO_LINK = `https://jup.ag/portfolio/${WALLET}`;
const LABELS = [
  'Платформа', 'Мин диапазона', 'Макс диапазон', 'Дата открытия норм',
  'Заработано стейблов USD', 'Заработано актива', 'Символ актива', 'Заработано AERO',
  'Итого комс доход USD', 'Пара', 'Блокчейн', 'fee_tier', 'APR', 'APY', 'Ссылка', 'Инвестировано USD',
];

const POOLS = [
  { platform: 'Raydium', pair: 'USDC / TSLAx', apr: '45.1%', apy: '56.8%', invested: 7.49, feeTotal: 0.5812, stableFee: 0.2812, assetAmt: 0.000684, assetSym: 'TSLAx', priceMin: '380', priceMax: '420' },
  { platform: 'Raydium', pair: 'USDC / MSFTx', apr: '32.0%', apy: '37.1%', invested: 1.01, feeTotal: 0.000443, stableFee: 0.000443, assetAmt: 4.4e-7, assetSym: 'MSFTx', priceMin: '480', priceMax: '520' },
  { platform: 'Raydium', pair: 'USDC / AMZNx', apr: '29.3%', apy: '33.8%', invested: 1.0, feeTotal: 0.000141, stableFee: 0.000141, assetAmt: 6e-7, assetSym: 'AMZNx', priceMin: '220', priceMax: '240' },
  { platform: 'Raydium', pair: 'USDC / AAPLx', apr: '19.8%', apy: '21.7%', invested: 1.0, feeTotal: 0.000107, stableFee: 0.000107, assetAmt: 3.1e-7, assetSym: 'AAPLx', priceMin: '230', priceMax: '250' },
  { platform: 'Raydium', pair: 'METAx / USDC', apr: '56.0%', apy: '71.2%', invested: 0.99, feeTotal: 0.000167, stableFee: 0.000167, assetAmt: 4.4e-7, assetSym: 'METAx', priceMin: '680', priceMax: '720' },
  { platform: 'Raydium', pair: 'USDC / NVDAx', apr: '374.4%', apy: '520.0%', invested: 0.92, feeTotal: 0.001751, stableFee: 0.001751, assetAmt: 7.28e-6, assetSym: 'NVDAx', priceMin: '130', priceMax: '150' },
  { platform: 'Orca', pair: 'USDC / cbBTC', apr: '30.7%', apy: '35.6%', invested: 9.32, feeTotal: 0.1114, stableFee: 0.05714, assetAmt: 7.5e-7, assetSym: 'cbBTC', priceMin: '105000', priceMax: '115000' },
  { platform: 'Orca', pair: 'USDC / TSLAx', apr: '21.3%', apy: '23.5%', invested: 0.98, feeTotal: 0.000182, stableFee: 0.000182, assetAmt: 3.5e-7, assetSym: 'TSLAx', priceMin: '380', priceMax: '420' },
];

const today = (() => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
})();

function poolLink(p) {
  const slug = `${p.platform}-${p.pair}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${PORTFOLIO_LINK}#${slug}`;
}

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '..', 'pusher-490008-bf7c384ba372.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const q = `'${SHEET.replace(/'/g, "''")}'`;

const rows = POOLS.map((p) => [
  p.platform,
  p.priceMin,
  p.priceMax,
  today,
  p.stableFee,
  p.assetAmt,
  p.assetSym,
  '',
  p.feeTotal,
  p.pair,
  'solana',
  '',
  p.apr,
  p.apy,
  poolLink(p),
  p.invested,
]);

await sheets.spreadsheets.values.clear({
  spreadsheetId: BATTLE_SPREADSHEET_ID,
  range: `${q}!A1:W120`,
});
await sheets.spreadsheets.values.update({
  spreadsheetId: BATTLE_SPREADSHEET_ID,
  range: `${q}!A1`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: [LABELS, ...rows] },
});
await sheets.spreadsheets.values.update({
  spreadsheetId: BATTLE_SPREADSHEET_ID,
  range: `${q}!Z1:Z2`,
  valueInputOption: 'USER_ENTERED',
  requestBody: {
    values: [['Кошелёк Jupiter'], [PORTFOLIO_LINK]],
  },
});

console.log(`Записано ${rows.length} пулов RWA в A1`);
