/**
 * Test gviz parsing for RWA / ETH / BTC — APY + period from openDate.
 * node scripts/test-navigator-gviz.mjs
 */
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";

const POOL_BATTLE_COL_BY_CAT = {
  rwa: { platform: 0, openDate: 3, pair: 9, chain: 10, fee: 11, apy: 12, link: 13 },
  ethereum: { platform: 0, openDate: 3, pair: 8, chain: 9, fee: 10, apr: 11, apy: 12, link: 13 },
  bitcoin: { platform: 0, openDate: 3, pair: 9, chain: 10, fee: 11, apr: 12, apy: 13, link: 14 },
};

function gvizCellValue(cell) {
  if (!cell) return "";
  if (cell.v != null && cell.v !== "") return cell.v;
  if (cell.f != null && cell.f !== "") return cell.f;
  return "";
}

function parseGvizDateTimeValue(v) {
  if (v == null || v === "") return "";
  const s = String(v);
  const m = s.match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+)(?:,(\d+))?)?\)/);
  if (!m) return s;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) + 1;
  const d = parseInt(m[3], 10);
  const hh = m[4] != null ? parseInt(m[4], 10) : 0;
  const mm = m[5] != null ? parseInt(m[5], 10) : 0;
  return `${d < 10 ? "0" : ""}${d}.${mo < 10 ? "0" : ""}${mo}.${y}${m[4] != null ? ` ${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}` : ""}`;
}

function isLikelySyncStampOpenDate(dateStr) {
  const m = String(dateStr || "").match(
    /(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/,
  );
  if (!m) return false;
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const opened = new Date(
    y,
    parseInt(m[2], 10) - 1,
    parseInt(m[1], 10),
    m[4] ? parseInt(m[4], 10) : 0,
    m[5] ? parseInt(m[5], 10) : 0,
  );
  return Date.now() - opened.getTime() < 4 * 3600000;
}

function periodFromOpenDateString(dateStr) {
  let s = String(dateStr || "").trim();
  if (isLikelySyncStampOpenDate(s)) {
    const d = new Date(Date.now() - 86400000);
    s = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()} 16:00`;
  }
  const m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return "";
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const opened = new Date(
    y,
    parseInt(m[2], 10) - 1,
    parseInt(m[1], 10),
    m[4] ? parseInt(m[4], 10) : 0,
    m[5] ? parseInt(m[5], 10) : 0,
  );
  const hours = Math.max(0, Math.floor((Date.now() - opened.getTime()) / 3600000));
  if (hours < 72) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}

async function fetchGviz(sheet) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheet)}`;
  const text = await fetch(url).then((r) => r.text());
  return JSON.parse(text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1"));
}

function parseRows(payload, categoryId) {
  const cols = POOL_BATTLE_COL_BY_CAT[categoryId];
  const rows = payload?.table?.rows || [];
  const out = [];
  for (const row of rows) {
    const cells = row.c || [];
    const platform = String(gvizCellValue(cells[cols.platform]) || "").trim();
    if (!platform || /^платформа$/i.test(platform)) continue;
    const openDate = parseGvizDateTimeValue(gvizCellValue(cells[cols.openDate]));
    out.push({
      categoryId,
      platform,
      pair: String(gvizCellValue(cells[cols.pair]) || ""),
      apy: String(gvizCellValue(cells[cols.apy]) || ""),
      link: String(gvizCellValue(cells[cols.link]) || ""),
      fee: String(gvizCellValue(cells[cols.fee]) || ""),
      chain: String(gvizCellValue(cells[cols.chain]) || ""),
      openDate,
      period: openDate ? periodFromOpenDateString(openDate) : "",
    });
  }
  return out;
}

const rwa = parseRows(await fetchGviz("БИТВА ПУЛОВ RWA"), "rwa");
console.log(`\n=== БИТВА ПУЛОВ RWA (${rwa.length}) ===`);
rwa.slice(0, 3).forEach((r) => console.log(JSON.stringify(r)));

const eth = parseRows(await fetchGviz("ethereum"), "ethereum");
console.log(`\n=== ethereum (${eth.length}) ===`);
eth.slice(0, 3).forEach((r) => console.log(JSON.stringify(r)));

let failed = false;
for (const r of rwa.slice(0, 3)) {
  if (!r.apy || r.period === "0 ч") {
    console.error("RWA period should not be 0 ч after sync-stamp fix:", r);
    failed = true;
  }
}
const ethPayload = await fetchGviz("ethereum");
const ethCells = ethPayload?.table?.rows?.[0]?.c || [];
const ethApr = Number(gvizCellValue(ethCells[11]));
const ethApy = Number(gvizCellValue(ethCells[12]));
if (!(ethApy > ethApr && ethApy > 0)) {
  console.error("ETH sheet: APY (M) should be > APR (L)", { ethApr, ethApy });
  failed = true;
}

for (const r of eth.slice(0, 3)) {
  if (!r.period || r.period === "0 ч") {
    console.error("ETH missing period:", r);
    failed = true;
  }
  if (r.pair === r.chain) {
    console.error("ETH pair should not equal chain:", r);
    failed = true;
  }
  const parsedApy = parseFloat(String(r.apy).replace("%", ""));
  if (Math.abs(parsedApy - ethApr) < 1e-6 && Math.abs(parsedApy - ethApy) > 1e-4) {
    console.error("ETH gviz must use APY column (M), not APR (L):", r);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("\nAll gviz checks passed");
