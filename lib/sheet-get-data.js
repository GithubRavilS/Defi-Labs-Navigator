/**
 * Чтение навигатора из Google Sheets (единая таблица A1 для ETH/BTC/RWA).
 * Используется Vercel /api/nav-data и локальный server.js.
 */
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";
const API_VERSION = 4;
const RWA_RANGE_MIN_LABEL = "-10%";
const RWA_RANGE_MAX_LABEL = "+10%";

function normalizePairKey(pair) {
  return String(pair || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·•]/g, "/");
}

function pairContainsEthOrBtc(pair, name, platform) {
  const blob = `${normalizePairKey(pair)}|${normalizePairKey(name)}|${normalizePairKey(platform)}`;
  if (!blob || blob === "||") return false;
  if (/\b(weth|ethereum)\b/.test(blob)) return true;
  if (/\b(wbtc|cbbtc|bitcoin)\b/.test(blob)) return true;
  if (/cbbtc|wbtc|\/eth\b|\beth\/|\bbtc\b/.test(blob)) return true;
  return false;
}

function isExcludedBitcoinUsdcCbbtc(pair, platform) {
  const p = normalizePairKey(pair);
  if (p !== "usdc/cbbtc") return false;
  return /orca/i.test(String(platform || ""));
}

function shouldSkipToolRow(catId, pair, name, platform) {
  if (catId === "rwa" && pairContainsEthOrBtc(pair, name, platform)) return true;
  if (catId === "bitcoin" && isExcludedBitcoinUsdcCbbtc(pair, platform)) return true;
  return false;
}

function sheetNameToCategoryId(name) {
  if (!name || typeof name !== "string") return "";
  const raw = name.trim();
  if (/\brwa\b/i.test(raw) || /real\s*world/i.test(raw)) return "rwa";
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function isRwaPoolBattleSheet(title) {
  const n = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ё/g, "е");
  if (/битва/.test(n) && /пулл?ов/.test(n) && /\brwa\b/.test(n)) return true;
  return false;
}

function normalizeHeaderCell(h) {
  return String(h || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u200b/g, "")
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ");
}

function findHeaderColumn(headers, startIdx, patterns, fallbackIdx) {
  for (let i = startIdx; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    for (const re of patterns) {
      if (re.test(h)) return i;
    }
  }
  return fallbackIdx >= 0 ? fallbackIdx : -1;
}

function isUnifiedPoolBattleHeaderRow(headers) {
  if (!headers || !headers.length) return false;
  let hasPlatform = false;
  let hasMin = false;
  for (const h of headers) {
    if (/^(платформа|platform|dex|protocol|протокол)$/.test(h)) hasPlatform = true;
    if (/мин.*диапаз|min.*range|min_price|price_min/.test(h)) hasMin = true;
  }
  return hasPlatform && hasMin;
}

function findUnifiedHeaderRowIndex(data) {
  for (let r = 0; r < Math.min(data.length, 40); r++) {
    const headers = (data[r] || []).map(normalizeHeaderCell);
    if (isUnifiedPoolBattleHeaderRow(headers)) return r;
  }
  return -1;
}

function detectToolHeaderRow(rows) {
  const unified = findUnifiedHeaderRowIndex(rows);
  if (unified >= 0) return unified;
  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const headers = (rows[r] || []).map(normalizeHeaderCell);
    const hasName = headers.some((h) => /^(name|название|instrument|инструмент)$/.test(h));
    const hasApy = headers.some((h) => /^(apy|доходность|доход|yield|rate|apr)$/.test(h));
    if (hasName && hasApy) return r;
  }
  return 0;
}

function mapUnifiedToolColumns(headers) {
  return {
    platformCol: findHeaderColumn(headers, 0, [/^(платформа|platform|dex|protocol|протокол)$/], 0),
    minPriceCol: findHeaderColumn(headers, 0, [/мин.*диапаз|min.*range|min_price|price_min/], 1),
    maxPriceCol: findHeaderColumn(headers, 0, [/макс.*диапаз|max.*range|max_price|price_max/], 2),
    openDateCol: findHeaderColumn(headers, 0, [/дата.*открыт|open.*date/], 3),
    pairCol: findHeaderColumn(headers, 0, [/^(пара|pair)$/], -1),
    chainCol: findHeaderColumn(headers, 0, [/^(блокчейн|chain|blockchain|network|сеть)$/], -1),
    feeCol: findHeaderColumn(
      headers,
      0,
      [/^(fee_tier|fitier|fi tier|fee tier|fee|комиссия|tier|уровень)$/],
      -1,
    ),
    apyCol: findHeaderColumn(headers, 0, [/^(apy)$/], -1),
    linkCol: findHeaderColumn(headers, 0, [/ссылка|link|url/], -1),
    periodCol: findHeaderColumn(headers, 0, [/^(period|период|term|срок)$/], -1),
    statusCol: findHeaderColumn(headers, 0, [/^(status|статус)$/], -1),
    descCol: findHeaderColumn(headers, 0, [/^(description|desc|описание)$/], -1),
    nameCol: findHeaderColumn(headers, 0, [/^(name|название|instrument|инструмент)$/], -1),
  };
}

function findApyColumnIndex(headers) {
  const idx = findHeaderColumn(headers, 0, [/^(apy)$/], -1);
  if (idx >= 0) return idx;
  return findHeaderColumn(headers, 0, [/^(доходность|доход|yield)$/], -1);
}

/** APY (не APR): ETH/RWA col M=12, BTC col N=13. */
function resolveUnifiedApyColumnIndex(headers, categoryId) {
  const apyIdx = findHeaderColumn(headers, 0, [/^(apy)$/], -1);
  const aprIdx = findHeaderColumn(headers, 0, [/^(apr)$/], -1);
  if (apyIdx >= 0 && apyIdx !== aprIdx) return apyIdx;
  const fallbacks = { ethereum: 12, bitcoin: 13, rwa: 12 };
  if (categoryId && fallbacks[categoryId] != null) {
    const fb = fallbacks[categoryId];
    if (aprIdx >= 0 && fb === aprIdx && headers[fb + 1] === "apy") return fb + 1;
    return fb;
  }
  return findApyColumnIndex(headers);
}

function normalizeApyFromCell(val) {
  if (val instanceof Date) {
    const d = val.getDate();
    const m = val.getMonth() + 1;
    return `${d}.${m}`;
  }
  return String(val == null ? "" : val)
    .replace(/%/g, "")
    .trim();
}

function formatApyForApi(rawVal, displayVal) {
  const disp = displayVal != null ? String(displayVal).trim() : "";
  if (disp && disp.includes("%")) return normalizeApyFromCell(disp);
  if (typeof rawVal === "number" && !isNaN(rawVal)) {
    if (rawVal > 0 && rawVal <= 1.5) return String(Math.round(rawVal * 1000) / 10);
    if (rawVal > 1.5) return String(Math.round(rawVal * 10) / 10);
  }
  const s = normalizeApyFromCell(rawVal) || normalizeApyFromCell(disp);
  if (s) {
    const n = parseFloat(String(s).replace(",", "."));
    if (!isNaN(n) && n > 0 && n <= 1.5) return String(Math.round(n * 1000) / 10);
  }
  return s || "0";
}

function normalizeFeeValue(value) {
  return String(value || "")
    .replace(",", ".")
    .replace(/%/g, "")
    .trim();
}

function formatFeeForApi(rawVal, displayVal) {
  const disp = displayVal != null ? String(displayVal).trim() : "";
  if (disp && disp.includes("%")) return normalizeFeeValue(disp);
  if (typeof rawVal === "number" && !isNaN(rawVal) && rawVal > 0 && rawVal < 0.5) {
    return String(Math.round(rawVal * 10000) / 100);
  }
  return normalizeFeeValue(rawVal || disp);
}

function formatSheetNumber(n, decimals) {
  if (n == null || isNaN(Number(n))) return "";
  const d = decimals == null ? 6 : decimals;
  return String(Math.round(Number(n) * 10 ** d) / 10 ** d);
}

function sanitizeRangeCell(val) {
  const s = String(val || "").trim();
  const m = s.match(/^([\d\s\u00a0.,]+)\s*дн\s*$/i);
  if (m) return m[1].trim();
  return s;
}

function pickRangeValue(r, idx, rw, displayRows) {
  if (idx < 0) return "";
  const raw = rw[idx];
  if (typeof raw === "number" && !isNaN(raw)) return formatSheetNumber(raw, 4);
  const disp = displayRows && displayRows[r] ? displayRows[r][idx] : "";
  if (disp !== undefined && disp !== null && disp !== "")
    return sanitizeRangeCell(String(disp).trim());
  return sanitizeRangeCell(String(raw || "").trim());
}

function periodFromOpenDateString(dateStr) {
  const s = String(dateStr || "").trim();
  const m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (!m) return "";
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const opened = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  if (isNaN(opened.getTime())) return "";
  return `${Math.max(0, Math.floor((Date.now() - opened.getTime()) / 86400000))} дн`;
}

function periodFromOpenDateCell(rawVal, displayVal) {
  const fromDisp = periodFromOpenDateString(displayVal);
  if (fromDisp) return fromDisp;
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    return `${Math.max(0, Math.floor((Date.now() - rawVal.getTime()) / 86400000))} дн`;
  }
  if (typeof rawVal === "number" && !isNaN(rawVal) && rawVal > 20000 && rawVal < 80000) {
    const base = new Date(Date.UTC(1899, 11, 30));
    const opened = new Date(base.getTime() + Math.round(rawVal) * 86400000);
    if (!isNaN(opened.getTime())) {
      return `${Math.max(0, Math.floor((Date.now() - opened.getTime()) / 86400000))} дн`;
    }
  }
  return periodFromOpenDateString(String(rawVal || ""));
}

function buildSolanaDesc(chain, fee) {
  const c = String(chain || "solana").trim() || "solana";
  const f = String(fee || "").trim();
  return f ? `${c} ${f}${f.includes("%") ? "" : "%"}` : c;
}

function parsePoolMetaFromDesc(desc) {
  const text = String(desc || "").trim();
  if (!text) return { chain: "", fee: "" };
  const withFee = text.match(/^([A-Za-z0-9]+)\s+([\d.,]+)\s*%$/);
  if (withFee) return { chain: withFee[1], fee: normalizeFeeValue(withFee[2]) };
  if (/^[A-Za-z0-9]+$/.test(text)) return { chain: text, fee: "" };
  return { chain: "", fee: "" };
}

function enrichPoolBattleFields(name, desc, platform, chain, fee) {
  if (!platform && name) platform = String(name).trim();
  const meta = parsePoolMetaFromDesc(desc);
  if (!chain && meta.chain) chain = meta.chain;
  if (!fee && meta.fee !== "") fee = meta.fee;
  return { platform: platform || "", chain: chain || "", fee: fee || "" };
}

function findCol(row, names) {
  for (const name of names) {
    const n = name.toLowerCase();
    for (let i = 0; i < row.length; i++) {
      if (
        String(row[i] || "")
          .toLowerCase()
          .trim() === n
      )
        return i;
    }
  }
  return -1;
}

function getCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  const p = path.join(__dirname, "..", "pusher-490008-bf7c384ba372.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return null;
}

async function getSheetsClient() {
  const cred = getCredentials();
  if (!cred) throw new Error("No Google service account credentials");
  const auth = new google.auth.GoogleAuth({
    credentials: cred,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

function parseToolsFromSheet(rows, displayRows, categoryId, startToolId) {
  const tools = [];
  let toolId = startToolId;
  const headerRow = detectToolHeaderRow(rows);
  const headers = (rows[headerRow] || []).map(normalizeHeaderCell);
  const unified = isUnifiedPoolBattleHeaderRow(headers);
  const umap = unified ? mapUnifiedToolColumns(headers) : null;

  function colIndex(allowedNames) {
    for (let i = 0; i < headers.length; i++) {
      if (allowedNames.includes(headers[i])) return i;
    }
    return -1;
  }

  const nameCol = unified
    ? umap.nameCol >= 0
      ? umap.nameCol
      : umap.platformCol
    : colIndex(["name", "название", "instrument", "инструмент"]);
  const apyCol = unified
    ? resolveUnifiedApyColumnIndex(headers, categoryId)
    : findApyColumnIndex(headers);
  const periodCol = unified ? umap.periodCol : colIndex(["period", "период", "term"]);
  const statusCol = unified ? umap.statusCol : colIndex(["status", "статус"]);
  const linkCol = unified ? umap.linkCol : colIndex(["link", "url", "ссылка"]);
  let descCol = unified ? umap.descCol : colIndex(["description", "desc", "описание"]);
  if (descCol < 0) descCol = headers.findIndex((h) => h.includes("описание"));
  const pairCol = unified ? umap.pairCol : headers.findIndex((h) => h === "pair" || h === "пара");
  const platformCol = unified
    ? umap.platformCol
    : colIndex(["platform", "платформа", "dex", "protocol", "протокол"]);
  const feeCol = unified
    ? umap.feeCol
    : colIndex(["fee", "fee tier", "fee_tier", "fitier", "fi tier", "комиссия", "tier", "уровень"]);
  const chainCol = unified
    ? umap.chainCol
    : colIndex(["chain", "blockchain", "network", "сеть", "блокчейн"]);
  const typeCol = colIndex(["type", "тип", "position type", "pool type", "тип позиции"]);
  const minPriceCol = unified
    ? umap.minPriceCol
    : findHeaderColumn(headers, 0, [/мин.*диапаз|min.*range/], -1);
  const maxPriceCol = unified
    ? umap.maxPriceCol
    : findHeaderColumn(headers, 0, [/макс.*диапаз|max.*range/], -1);
  const openDateCol = unified ? umap.openDateCol : -1;

  const pick = (row, idx, def = "") =>
    idx >= 0 && row[idx] !== undefined && row[idx] !== null && row[idx] !== ""
      ? String(row[idx]).trim()
      : def;
  const pickDisplay = (r, idx, rowVals) => {
    if (idx < 0) return "";
    if (
      displayRows[r] &&
      displayRows[r][idx] !== undefined &&
      displayRows[r][idx] !== null &&
      displayRows[r][idx] !== ""
    ) {
      return String(displayRows[r][idx]).trim();
    }
    return pick(rowVals, idx, "");
  };

  for (let r = headerRow + 1; r < rows.length; r++) {
    const rw = rows[r];
    let name = pickDisplay(r, nameCol, rw) || pick(rw, nameCol);
    if (!name && unified && platformCol >= 0)
      name = pickDisplay(r, platformCol, rw) || pick(rw, platformCol);
    if (!name) continue;

    const apyDisp = apyCol >= 0 && displayRows[r] ? displayRows[r][apyCol] : "";
    const apyRaw = apyCol >= 0 ? rw[apyCol] : "";
    const apy = formatApyForApi(apyRaw, apyDisp);

    let period = "";
    if (periodCol >= 0 && !unified) period = pickDisplay(r, periodCol, rw) || pick(rw, periodCol);
    if ((!period || unified) && openDateCol >= 0) {
      period = periodFromOpenDateCell(
        rw[openDateCol],
        pickDisplay(r, openDateCol, rw) || pick(rw, openDateCol),
      );
    }
    if (!period) period = "7d";

    let status = statusCol >= 0 ? (pick(rw, statusCol) || "active").toLowerCase() : "active";
    if (status !== "warning" && status !== "внимание") status = "active";
    else status = "warning";

    const link = pickDisplay(r, linkCol, rw) || pick(rw, linkCol) || "#";
    let desc = descCol >= 0 ? pick(rw, descCol) : "";
    const pair = pairCol >= 0 ? pickDisplay(r, pairCol, rw) || pick(rw, pairCol, "") : "";
    let platform = platformCol >= 0 ? pickDisplay(r, platformCol, rw) || pick(rw, platformCol) : "";
    if (!platform) platform = name;
    if (shouldSkipToolRow(categoryId, pair, name, platform)) continue;
    const feeDisp = feeCol >= 0 && displayRows[r] ? displayRows[r][feeCol] : "";
    const feeRaw = feeCol >= 0 ? rw[feeCol] : "";
    let fee = formatFeeForApi(feeRaw, feeDisp);
    let chain = chainCol >= 0 ? pickDisplay(r, chainCol, rw) || pick(rw, chainCol) : "";
    const type = typeCol >= 0 ? pick(rw, typeCol) : "";
    let priceMin = unified
      ? pickRangeValue(r, minPriceCol, rw, displayRows)
      : pickDisplay(r, minPriceCol, rw) || pick(rw, minPriceCol);
    let priceMax = unified
      ? pickRangeValue(r, maxPriceCol, rw, displayRows)
      : pickDisplay(r, maxPriceCol, rw) || pick(rw, maxPriceCol);
    if (categoryId === "rwa") {
      priceMin = RWA_RANGE_MIN_LABEL;
      priceMax = RWA_RANGE_MAX_LABEL;
    }

    if (!desc && (chain || fee)) desc = buildSolanaDesc(chain, fee);
    const enriched = enrichPoolBattleFields(name, desc, platform, chain, fee);
    platform = enriched.platform;
    chain = enriched.chain;
    fee = enriched.fee;

    tools.push({
      id: toolId++,
      categoryId,
      name,
      pair,
      platform,
      fee,
      chain,
      type,
      priceMin,
      priceMax,
      apy,
      period,
      status,
      link,
      desc,
      descEn: desc,
    });
  }
  return { tools, nextToolId: toolId };
}

async function getNavigatorDataFromSheets() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets(properties(title))",
  });
  const sheetList = meta.data.sheets || [];
  if (!sheetList.length)
    return { categories: [], tools: [], apiVersion: API_VERSION, source: "sheets-direct" };

  const firstTitle = sheetList[0].properties.title;
  const firstRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${firstTitle.replace(/'/g, "''")}'!A:E`,
  });
  const firstRows = firstRes.data.values || [];
  const catHeaders = firstRows[0] || [];
  const idI = findCol(catHeaders, ["id"]) >= 0 ? findCol(catHeaders, ["id"]) : 0;
  const nameI = findCol(catHeaders, ["name"]) >= 0 ? findCol(catHeaders, ["name"]) : 1;
  const iconI = findCol(catHeaders, ["icon"]) >= 0 ? findCol(catHeaders, ["icon"]) : 2;
  const descI =
    findCol(catHeaders, ["description"]) >= 0 ? findCol(catHeaders, ["description"]) : 3;
  const colorI = findCol(catHeaders, ["color"]) >= 0 ? findCol(catHeaders, ["color"]) : 4;

  const categories = [];
  for (let i = 1; i < firstRows.length; i++) {
    const row = firstRows[i];
    const id = String(row[idI] || "").trim();
    if (!id) continue;
    categories.push({
      id,
      name: String(row[nameI] || "").trim() || id,
      icon: String(row[iconI] || "").trim(),
      description: String(row[descI] || "").trim(),
      color: String(row[colorI] || "").trim(),
    });
  }

  const categoryIdSet = new Set(categories.map((c) => c.id));
  const categoryOrder = categories.map((c) => c.id);
  const allTools = [];
  let toolId = 1;

  for (let s = 1; s < sheetList.length; s++) {
    const title = sheetList[s].properties.title || "";
    let categoryId = "";
    if (isRwaPoolBattleSheet(title)) categoryId = "rwa";
    else {
      const fromSheetName = sheetNameToCategoryId(title);
      const fromOrder = categoryOrder[s - 1] || "";
      if (fromSheetName && categoryIdSet.has(fromSheetName)) categoryId = fromSheetName;
      else if (fromOrder) categoryId = fromOrder;
      else if (fromSheetName) categoryId = fromSheetName;
      else categoryId = String(s);
    }

    const q = `'${title.replace(/'/g, "''")}'!A:ZZ`;
    let rows;
    let displayRows;
    try {
      const [rawRes, fmtRes] = await Promise.all([
        sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: q,
          valueRenderOption: "UNFORMATTED_VALUE",
        }),
        sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: q,
          valueRenderOption: "FORMATTED_VALUE",
        }),
      ]);
      rows = rawRes.data.values || [];
      displayRows = fmtRes.data.values || [];
    } catch {
      continue;
    }

    const parsed = parseToolsFromSheet(rows, displayRows, categoryId, toolId);
    allTools.push(...parsed.tools);
    toolId = parsed.nextToolId;
  }

  return {
    categories,
    tools: allTools,
    apiVersion: API_VERSION,
    source: "sheets-direct",
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getNavigatorDataFromSheets,
  API_VERSION,
  SPREADSHEET_ID,
};
