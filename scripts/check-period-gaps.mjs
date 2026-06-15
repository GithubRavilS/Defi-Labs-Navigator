/**
 * Найти строки ethereum/bitcoin без period при gviz (до и после patch).
 */
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";

const COLS = {
  ethereum: { platform: 0, openDate: 3, link: 13 },
  bitcoin: { platform: 0, openDate: 3, link: 14 },
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
  const m = s.match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+))?/);
  if (!m) return s;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) + 1;
  const d = parseInt(m[3], 10);
  return `${d < 10 ? "0" : ""}${d}.${mo < 10 ? "0" : ""}${mo}.${y}`;
}

function periodFromOpenDateString(dateStr) {
  const s = String(dateStr || "").trim();
  const m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (!m) return "";
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const opened = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  if (isNaN(opened.getTime())) return "";
  const hours = Math.max(0, Math.floor((Date.now() - opened.getTime()) / 3600000));
  if (hours < 72) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}

async function fetchGviz(sheet, range) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=` +
    encodeURIComponent(sheet) +
    (range ? `&range=${range}` : "");
  const t = await fetch(url).then((r) => r.text());
  return JSON.parse(t.match(/google\.visualization\.Query\.setResponse\((.*)\);/s)[1]);
}

function countBad(payload, sheet) {
  const cols = COLS[sheet];
  let bad = [];
  for (const row of payload.table?.rows || []) {
    const c = row.c || [];
    const plat = String(gvizCellValue(c[cols.platform]) || "").trim();
    if (!plat || /^платформа$/i.test(plat)) continue;
    const openDate = parseGvizDateTimeValue(gvizCellValue(c[cols.openDate]));
    const period = openDate ? periodFromOpenDateString(openDate) : "";
    if (!period)
      bad.push({
        plat,
        openRaw: c[cols.openDate],
        link: String(gvizCellValue(c[cols.link])).slice(-28),
      });
  }
  return bad;
}

for (const sheet of ["ethereum", "bitcoin"]) {
  const payload = await fetchGviz(sheet);
  const bad = countBad(payload, sheet);
  console.log(`\n${sheet} bulk без period: ${bad.length}`);
  bad.forEach((b) => console.log(JSON.stringify(b)));
}
