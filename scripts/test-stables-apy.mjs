/**
 * APY: display from sheet as-is (0,90 → 0.9%, not 90%; 13,91% → 13.9%).
 * node scripts/test-stables-apy.mjs
 */
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";

function normalizeApyValue(value) {
  if (value == null || value === "") return "0";
  const n = parseFloat(String(value).trim().replace(/%/g, "").replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 10) / 10);
}

function apyPercentFromSheetCell(cell) {
  if (!cell) return "0";
  const disp = cell.f != null && String(cell.f).trim() !== "" ? String(cell.f).trim() : "";
  if (disp) {
    const dn = parseFloat(disp.replace(/%/g, "").replace(",", ".").replace(/\s/g, ""));
    if (Number.isFinite(dn)) return String(Math.round(dn * 10) / 10);
  }
  const raw = cell.v;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1.5) return String(Math.round(raw * 10) / 10);
    if (raw > 0 && raw <= 1.5) return String(Math.round(raw * 1000) / 10);
  }
  return normalizeApyValue(raw);
}

function afterNormalizeTool(apy) {
  return normalizeApyValue(apy);
}

let failed = false;

const stUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=stables`;
const st = await fetch(stUrl).then((r) => r.text());
const stPayload = JSON.parse(st.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1"));
for (const row of stPayload.table.rows || []) {
  const c = row.c || [];
  const name = String(c[0]?.f ?? c[0]?.v ?? "").trim();
  if (!name || /^name$/i.test(name)) continue;
  const got = parseFloat(afterNormalizeTool(apyPercentFromSheetCell(c[1])));
  const disp = c[1]?.f != null ? String(c[1].f).trim() : "";
  const want = parseFloat(disp.replace(",", ".").replace(/%/g, ""));
  if (!Number.isFinite(want)) continue;
  if (Math.abs(got - want) > 0.2 || got > want * 5) {
    console.error(`STABLES ${name}: sheet ${disp} → ${got}% (want ~${want}%)`);
    failed = true;
  }
}

const btcUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=bitcoin`;
const btc = await fetch(btcUrl).then((r) => r.text());
const btcPayload = JSON.parse(btc.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1"));
for (const row of btcPayload.table.rows || []) {
  const c = row.c || [];
  const plat = String(c[0]?.v ?? "").trim();
  if (!plat || /^платформа$/i.test(plat)) continue;
  const got = parseFloat(afterNormalizeTool(apyPercentFromSheetCell(c[13])));
  const disp = c[13]?.f != null ? String(c[13].f).trim() : "";
  if (!disp || !disp.includes("%")) continue;
  const want = parseFloat(disp.replace(",", ".").replace(/%/g, ""));
  if (got < want * 0.5) {
    console.error(`BTC ${plat}: sheet ${disp} → ${got}% (want ~${want}%)`);
    failed = true;
  }
}

const low = (stPayload.table.rows || []).find((r) => String(r.c?.[1]?.f || "") === "0,90");
if (low) {
  const apy = parseFloat(afterNormalizeTool(apyPercentFromSheetCell(low.c[1])));
  if (apy > 2) {
    console.error("FAIL 0,90 inflated to", apy);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("APY display-first checks passed");
