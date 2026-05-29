/**
 * RWA → Sheet через Solana RPC + Raydium/Orca (обход Jupiter Portfolio API).
 * node scripts/scrape-jupiter-portfolio-to-sheet.mjs [wallet]
 */
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";
import {
  fetchRwaPositionsOnchain,
  rowsToUnifiedSheetLines,
} from "../lib/rwa-onchain-positions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";
const SHEET = "БИТВА ПУЛОВ RWA";
const DEFAULT_WALLET = "GFVsoeaHSFYaXXxMdYqYPMvkD3wJH6xmR6umLceWzXxs";

const HEADERS = [
  "Платформа",
  "Мин диапазона",
  "Макс диапазон",
  "Дата открытия норм",
  "Заработано стейблов USD",
  "Заработано актива",
  "Символ актива",
  "Заработано AERO",
  "Итого комс доход USD",
  "Пара",
  "Блокчейн",
  "fee_tier",
  "APY",
  "Ссылка",
  "Инвестировано USD",
];

const wallet = process.argv[2] || DEFAULT_WALLET;
console.log("On-chain RWA sync:", wallet.slice(0, 8) + "…");
const result = await fetchRwaPositionsOnchain(wallet);
console.log("Найдено LP:", result.rows.length, `(${result.source})`);
for (const r of result.rows) {
  console.log(`  ${r.platform} | ${r.pair} | APY ${r.apy} | $${r.investedUsd}`);
}
if (!result.rows.length) {
  console.error("0 позиций");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "..", "pusher-490008-bf7c384ba372.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const q = `'${SHEET.replace(/'/g, "''")}'`;
const lines = rowsToUnifiedSheetLines(result.rows);

await sheets.spreadsheets.values.clear({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A1:W120`,
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A1`,
  valueInputOption: "USER_ENTERED",
  requestBody: { values: [HEADERS, ...lines] },
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!Z1:Z3`,
  valueInputOption: "USER_ENTERED",
  requestBody: {
    values: [
      ["Кошелёк Jupiter"],
      [`https://jup.ag/portfolio/${wallet}`],
      [`OK · ${result.rows.length} LP · on-chain · ${new Date().toISOString()}`],
    ],
  },
});
console.log("Таблица обновлена:", SPREADSHEET_ID);
