/**
 * Stables APY must match sheet column B display (not fraction ×100).
 * node scripts/test-stables-apy.mjs
 */
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";

function normalizeApyValue(value) {
  if (value == null || value === "") return "0";
  const s = String(value).trim();
  if (s.includes("%")) {
    const pct = parseFloat(s.replace(/%/g, "").replace(",", "."));
    return Number.isFinite(pct) ? String(Math.round(pct * 10) / 10) : "0";
  }
  const n = parseFloat(s.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return "0";
  if (n > 1.5) return String(Math.round(n * 10) / 10);
  if (n >= 0.2 && n <= 1.5) return String(Math.round(n * 1000) / 10);
  return String(Math.round(n * 10) / 10);
}

function apyFromStablesSheetCell(cell) {
  if (!cell) return "0";
  const disp = cell.f != null && String(cell.f).trim() !== "" ? String(cell.f).trim() : "";
  if (disp && disp.includes("%")) return normalizeApyValue(disp);
  if (disp) {
    const dn = parseFloat(disp.replace(",", ".").replace(/\s/g, ""));
    if (Number.isFinite(dn)) return String(Math.round(dn * 10) / 10);
  }
  const raw = cell.v;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1.5) return String(Math.round(raw * 10) / 10);
    if (raw >= 0.2 && raw <= 1.5) return String(Math.round(raw * 1000) / 10);
    return String(Math.round(raw * 100) / 100);
  }
  return normalizeApyValue(raw);
}

function expectedFromDisplay(cell) {
  const disp = cell?.f != null ? String(cell.f).trim() : "";
  if (!disp) return null;
  const n = parseFloat(disp.replace(",", ".").replace(/%/g, ""));
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=stables`;
const text = await fetch(url).then((r) => r.text());
const payload = JSON.parse(text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1"));
let failed = false;

for (const row of payload.table.rows || []) {
  const c = row.c || [];
  const name = String(c[0]?.f ?? c[0]?.v ?? "").trim();
  if (!name || /^name$/i.test(name)) continue;
  const got = parseFloat(apyFromStablesSheetCell(c[1]));
  const want = expectedFromDisplay(c[1]);
  if (want == null || !Number.isFinite(got)) continue;
  if (Math.abs(got - want) > 0.15) {
    console.error(`FAIL ${name}: sheet ${c[1]?.f} want ${want}% got ${got}%`);
    failed = true;
  }
}

// Regression: 0,18% must not become ~17.6%
const low = (payload.table.rows || []).find((row) => {
  const f = row.c?.[1]?.f;
  return f === "0,18";
});
if (low) {
  const apy = parseFloat(apyFromStablesSheetCell(low.c[1]));
  if (apy > 2) {
    console.error("FAIL 0,18% inflated to", apy);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("stables APY checks passed");
