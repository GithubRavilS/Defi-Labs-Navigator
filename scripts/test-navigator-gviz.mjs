/**
 * Test gviz parsing for RWA / ETH / BTC — APY + period from openDate.
 * node scripts/test-navigator-gviz.mjs
 */
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";

const POOL_BATTLE_COL_BY_CAT = {
  rwa: {
    platform: 0,
    minPrice: 1,
    maxPrice: 2,
    openDate: 3,
    pair: 9,
    chain: 10,
    fee: 11,
    apy: 12,
    link: 13,
  },
  ethereum: {
    platform: 0,
    minPrice: 1,
    maxPrice: 2,
    openDate: 3,
    pair: 8,
    chain: 9,
    fee: 10,
    apy: 12,
    link: 13,
    liquidityStatus: 15,
  },
  bitcoin: {
    platform: 0,
    minPrice: 1,
    maxPrice: 2,
    openDate: 3,
    pair: 9,
    chain: 10,
    fee: 11,
    apy: 13,
    link: 14,
  },
};

function gvizCellValue(cell) {
  if (!cell) return "";
  if (cell.v != null && cell.v !== "") return cell.v;
  if (cell.f != null && cell.f !== "") return cell.f;
  return "";
}

function gvizCellFeeValue(cell) {
  if (!cell) return "";
  const f = cell.f != null && String(cell.f).trim() !== "" ? String(cell.f).trim() : "";
  if (f) return f;
  if (cell.v != null && cell.v !== "") return cell.v;
  return "";
}

function feeDecimalPlaces(n) {
  const s = String(n);
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  return s.length - dot - 1;
}

function feeToPercentNumber(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return NaN;
  const hadPct = raw.includes("%");
  const compact = raw.replace(",", ".").replace(/%/g, "");
  const n = parseFloat(compact);
  if (!Number.isFinite(n)) return NaN;
  if (hadPct) return Math.round(n * 1000) / 1000;
  if (n >= 1 && n <= 100) return Math.round(n * 1000) / 1000;
  if (n > 0 && n < 1) {
    if (/^0\.0{2,}\d/.test(compact) || n <= 0.001) {
      return Math.round(n * 10000) / 100;
    }
    if (n === 0.01 && /^0\.01$/.test(compact)) return 1;
    if (n >= 0.02 && feeDecimalPlaces(n) >= 3) {
      return Math.round(n * 10000) / 100;
    }
    if (n < 0.02 && feeDecimalPlaces(n) >= 3) {
      return Math.round(n * 10000) / 100;
    }
    return Math.round(n * 1000) / 1000;
  }
  return NaN;
}

function normalizeFeeValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const n = feeToPercentNumber(value);
  if (!Number.isFinite(n)) return raw.replace(/%/g, "");
  if (n > 0 && n < 0.1) return n.toFixed(3);
  return String(n);
}

function formatFeeLabel(fee) {
  const f = String(fee || "").trim();
  if (!f) return "";
  if (f.includes("%")) return f;
  const n = parseFloat(f.replace(",", "."));
  let label = f;
  if (Number.isFinite(n) && n > 0 && n < 0.1) {
    label = String(n.toFixed(3)).replace(/\.?0+$/, "");
  }
  return `${label}%`;
}

function expectedFeeLabel(cell) {
  const disp = cell?.f != null ? String(cell.f).trim() : "";
  if (disp && disp.includes("%")) {
    return disp.replace(",", ".");
  }
  const norm = normalizeFeeValue(gvizCellFeeValue(cell));
  return formatFeeLabel(norm);
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

function isSheetErrorCellValue(val) {
  const s = String(val == null ? "" : val).trim();
  return s.length > 0 && s.charAt(0) === "#";
}

function isEthereumLiquidityStatusClosedText(text) {
  const s = String(text || "")
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (s.charAt(0) === "#") return true;
  if (/error|ошибк|invalid|fail/i.test(s)) return true;
  if (s === "false" || s === "0" || s === "no" || s === "нет") return true;
  if (s === "inactive" || s === "неактив" || s === "not open" || s === "not_open") return true;
  if (s === "close" || s === "closed" || s === "закрыт" || s === "закрыта" || s === "закрыто")
    return true;
  if (/close|closed|закрыт/i.test(s)) return true;
  return false;
}

function isEthereumLiquidityStatusOpenText(text) {
  const s = String(text || "")
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (s === "true" || s === "1" || s === "yes" || s === "да") return true;
  if (
    s === "open" ||
    s === "opened" ||
    s === "active" ||
    s === "актив" ||
    s === "открыт" ||
    s === "открыта" ||
    s === "открыто"
  )
    return true;
  return false;
}

function isEthereumLiquidityStatusOpen(rawVal, displayVal) {
  const disp =
    displayVal != null && String(displayVal).trim() !== "" ? String(displayVal).trim() : "";
  if (disp) {
    if (isEthereumLiquidityStatusClosedText(disp)) return false;
    if (isEthereumLiquidityStatusOpenText(disp)) return true;
    return false;
  }
  const rawStr =
    rawVal != null && rawVal !== "" && typeof rawVal !== "boolean" && typeof rawVal !== "number"
      ? String(rawVal).trim()
      : "";
  if (rawStr) {
    if (isEthereumLiquidityStatusClosedText(rawStr)) return false;
    if (isEthereumLiquidityStatusOpenText(rawStr)) return true;
    return false;
  }
  if (rawVal === false || rawVal === 0) return false;
  if (rawVal === true || rawVal === 1) return true;
  return false;
}

function isEthereumLiquidityStatusOpenFromGvizCell(cell) {
  if (!cell) return false;
  const f = cell.f != null && String(cell.f).trim() !== "" ? String(cell.f).trim() : "";
  return isEthereumLiquidityStatusOpen(cell.v, f);
}

function isEthereumLiquidityStatusCellEmpty(cell) {
  if (!cell) return true;
  const f = cell.f != null && String(cell.f).trim() !== "" ? String(cell.f).trim() : "";
  if (f) return false;
  if (cell.v === false || cell.v === 0) return false;
  if (cell.v === true || cell.v === 1) return false;
  return cell.v == null || cell.v === "";
}

function isEthereumKrystalPositionLink(link) {
  return /cloud-ui\.krystal\.app/i.test(String(link || ""));
}

function isEthereumLiquidityStatusVisible(cell, link) {
  if (isEthereumLiquidityStatusOpenFromGvizCell(cell)) return true;
  if (!isEthereumLiquidityStatusCellEmpty(cell)) return false;
  return isEthereumKrystalPositionLink(link);
}

function parseRows(payload, categoryId) {
  const cols = POOL_BATTLE_COL_BY_CAT[categoryId];
  const rows = payload?.table?.rows || [];
  const out = [];
  for (const row of rows) {
    const cells = row.c || [];
    const platform = String(gvizCellValue(cells[cols.platform]) || "").trim();
    if (!platform || /^платформа$/i.test(platform)) continue;
    if (categoryId === "ethereum") {
      if (isSheetErrorCellValue(platform)) continue;
      const linkProbe = String(gvizCellValue(cells[cols.link]) || "").trim();
      if (isSheetErrorCellValue(linkProbe)) continue;
      if (
        cols.liquidityStatus != null &&
        !isEthereumLiquidityStatusVisible(cells[cols.liquidityStatus], linkProbe)
      )
        continue;
    }
    const openDate = parseGvizDateTimeValue(gvizCellValue(cells[cols.openDate]));
    out.push({
      categoryId,
      platform,
      pair: String(gvizCellValue(cells[cols.pair]) || ""),
      apy: String(gvizCellValue(cells[cols.apy]) || ""),
      link: String(gvizCellValue(cells[cols.link]) || ""),
      fee: normalizeFeeValue(gvizCellFeeValue(cells[cols.fee])),
      feeLabel: formatFeeLabel(normalizeFeeValue(gvizCellFeeValue(cells[cols.fee]))),
      chain: String(gvizCellValue(cells[cols.chain]) || ""),
      openDate,
      period: openDate ? periodFromOpenDateString(openDate) : "",
    });
  }
  return out;
}

const rwaPayload = await fetchGviz("БИТВА ПУЛОВ RWA");
const rwa = parseRows(rwaPayload, "rwa");
console.log(`\n=== БИТВА ПУЛОВ RWA (${rwa.length}) ===`);
rwa.slice(0, 3).forEach((r) => console.log(JSON.stringify(r)));

const ethPayload = await fetchGviz("ethereum");
const eth = parseRows(ethPayload, "ethereum");
console.log(`\n=== ethereum (${eth.length}) ===`);
eth.slice(0, 3).forEach((r) => console.log(JSON.stringify(r)));

let failed = false;
for (const r of rwa.slice(0, 3)) {
  if (!r.apy || r.period === "0 ч") {
    console.error("RWA period should not be 0 ч after sync-stamp fix:", r);
    failed = true;
  }
}
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
const opt = eth.filter((r) => /optimism/i.test(String(r.chain)));
const optApys = opt.map((r) => Number(r.apy)).filter((n) => Number.isFinite(n));
const uniqueOpt = new Set(optApys.map((n) => n.toFixed(4)));
if (opt.length >= 2 && uniqueOpt.size < 2) {
  console.error("Optimism rows must have distinct APY from column M:", optApys);
  failed = true;
}

// PancakeSwap Base: две строки, одна ссылка — APY разный (0.05% vs 0.01% fee)
const pancake = eth.filter((r) => /pancake/i.test(r.platform) && /base/i.test(String(r.chain)));
const fee005 = pancake.find((r) => Math.abs(Number(r.apy) - 0.22386401073923556) < 0.001);
const fee001 = pancake.find((r) => Math.abs(Number(r.apy) - 0.25618399614418097) < 0.001);
if (!fee005 || !fee001) {
  console.error("Expected two PancakeSwap Base rows with distinct APY from column M");
  failed = true;
} else if (Math.abs(Number(fee005.apy) - Number(fee001.apy)) < 0.01) {
  console.error("PancakeSwap rows must not share the same APY");
  failed = true;
}

function assertFeeMatchesSheet(rows, payload, categoryId) {
  const cols = POOL_BATTLE_COL_BY_CAT[categoryId];
  const tableRows = payload?.table?.rows || [];
  let rowIdx = 0;
  for (const row of tableRows) {
    const cells = row.c || [];
    const platform = String(gvizCellValue(cells[cols.platform]) || "").trim();
    if (!platform || /^платформа$/i.test(platform)) continue;
    const wantN = feeToPercentNumber(gvizCellFeeValue(cells[cols.fee]));
    const storedFee = rows[rowIdx]?.fee || "";
    const gotN = parseFloat(String(storedFee).replace(",", "."));
    rowIdx++;
    if (!Number.isFinite(wantN) || !Number.isFinite(gotN)) continue;
    if (Math.abs(wantN - gotN) > 1e-6) {
      console.error(`[${categoryId}] fee mismatch ${platform}: sheet=${wantN}% ui=${gotN}%`, {
        raw: cells[cols.fee]?.v,
        f: cells[cols.fee]?.f,
      });
      return false;
    }
  }
  return true;
}

const btcPayload = await fetchGviz("bitcoin");
const btc = parseRows(btcPayload, "bitcoin");
console.log(`\n=== bitcoin (${btc.length}) ===`);
btc.slice(0, 3).forEach((r) => console.log(JSON.stringify(r)));

const feeCases = [
  [0.003, "0.3%"],
  [0.0001, "0.01%"],
  [0.01, "1%"],
  [0.034, "3.4%"],
  ["0,30%", "0.3%"],
  ["0.25%", "0.25%"],
];
for (const [input, label] of feeCases) {
  const norm = normalizeFeeValue(input);
  if (formatFeeLabel(norm) !== label) {
    console.error("fee unit test failed:", input, "→", formatFeeLabel(norm), "expected", label);
    failed = true;
  }
}
for (const [input, label] of feeCases) {
  const once = normalizeFeeValue(input);
  const twice = normalizeFeeValue(once);
  if (twice !== once) {
    console.error("fee idempotent failed:", input, once, "→", twice);
    failed = true;
  }
  if (formatFeeLabel(twice) !== label) {
    console.error("fee idempotent label failed:", input, formatFeeLabel(twice), label);
    failed = true;
  }
}

if (!assertFeeMatchesSheet(eth, ethPayload, "ethereum")) failed = true;
if (!assertFeeMatchesSheet(btc, btcPayload, "bitcoin")) failed = true;
if (!assertFeeMatchesSheet(rwa, rwaPayload, "rwa")) failed = true;

const statusCases = [
  ["Closed", false, null],
  ["closed", false, null],
  ["Close", false, null],
  ["inactive", false, null],
  ["FALSE", false, false],
  [true, true, "TRUE"],
  [false, false, "FALSE"],
  ["Open", true, null],
  ["open", true, null],
  ["", false, null],
  [null, false, null],
  [true, false, "Closed"],
];
for (const [v, wantOpen, f] of statusCases) {
  const got = isEthereumLiquidityStatusOpen(v, f);
  if (got !== wantOpen) {
    console.error("ETH status unit failed:", { v, f, got, wantOpen });
    failed = true;
  }
}
if (isEthereumLiquidityStatusOpenFromGvizCell(null)) {
  console.error("ETH status: empty/missing cell must stay hidden");
  failed = true;
}
const krystalLink =
  "https://cloud-ui.krystal.app/positions/8453/0x7c5f5a4bbd8fd63184577525326123b519429bdc-2224594";
if (!isEthereumLiquidityStatusVisible(null, krystalLink)) {
  console.error("ETH status: empty P + Krystal link should be visible");
  failed = true;
}
if (isEthereumLiquidityStatusVisible({ v: false, f: "FALSE" }, krystalLink)) {
  console.error("ETH status: FALSE Krystal row must stay hidden");
  failed = true;
}
const v4 = eth.filter((r) => /uniswap\s*v4/i.test(r.platform));
if (v4.length < 2) {
  console.error("ETH: expected 2 Uniswap V4 rows, got", v4.length);
  failed = true;
}
if (!isEthereumLiquidityStatusOpenText("inactive")) {
  // inactive must not count as open
} else {
  console.error("ETH status: inactive must not be open");
  failed = true;
}
console.log(`\n=== ethereum open-only (${eth.length}) ===`);

if (failed) process.exit(1);
console.log("\nAll gviz checks passed");
