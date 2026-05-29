/**
 * Test gviz parsing for RWA / ETH — APY col 12, period from openDate.
 * node scripts/test-navigator-gviz.mjs
 */
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";
const POOL_BATTLE_COL = { platform: 0, openDate: 3, pair: 9, apy: 12, link: 13, fee: 11 };

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

function periodFromOpenDateString(dateStr) {
  const m = String(dateStr || "").match(
    /(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/,
  );
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

function normalizeFeeValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hadPct = raw.includes("%");
  const s = raw.replace(",", ".").replace(/%/g, "").trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  if (hadPct || n >= 1) return String(Math.round(n * 100) / 100);
  if (n > 0 && n < 0.5) return String(Math.round(n * 10000) / 100);
  return s;
}

async function fetchGviz(sheet) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheet)}`;
  const text = await fetch(url).then((r) => r.text());
  const json = JSON.parse(text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1"));
  return json;
}

function parseRows(payload, categoryId) {
  const rows = payload?.table?.rows || [];
  const out = [];
  for (const row of rows) {
    const cells = row.c || [];
    const platform = String(gvizCellValue(cells[POOL_BATTLE_COL.platform]) || "").trim();
    if (!platform || /^платформа$/i.test(platform)) continue;
    const openDate = parseGvizDateTimeValue(gvizCellValue(cells[POOL_BATTLE_COL.openDate]));
    out.push({
      categoryId,
      platform,
      pair: String(gvizCellValue(cells[POOL_BATTLE_COL.pair]) || ""),
      apy: String(gvizCellValue(cells[POOL_BATTLE_COL.apy]) || ""),
      link: String(gvizCellValue(cells[POOL_BATTLE_COL.link]) || ""),
      fee: normalizeFeeValue(gvizCellValue(cells[POOL_BATTLE_COL.fee])),
      openDate,
      period: openDate ? periodFromOpenDateString(openDate) : "",
    });
  }
  return out;
}

let failed = 0;
for (const [sheet, cat] of [
  ["БИТВА ПУЛОВ RWA", "rwa"],
  ["ethereum", "ethereum"],
]) {
  const payload = await fetchGviz(sheet);
  const rows = parseRows(payload, cat);
  console.log(`\n=== ${sheet} (${rows.length}) ===`);
  for (const r of rows.slice(0, 3)) {
    console.log(JSON.stringify(r));
    if (!r.apy || r.apy === r.link) {
      console.error("FAIL: bad APY for", r.platform);
      failed++;
    }
    if (cat === "rwa" && r.fee === "25") {
      console.error("FAIL: fee should not be 25 for", r.platform);
      failed++;
    }
  }
}
if (failed) process.exit(1);
console.log("\nAll gviz checks passed");
