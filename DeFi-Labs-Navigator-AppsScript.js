/**
 * DeFi Labs Navigator — скрипт для Google Apps Script
 * Читает данные из таблицы и отдаёт их в формате JSON (для сайта на GitHub Pages).
 *
 * КАК ПОДКЛЮЧИТЬ:
 * 1. Открой https://script.google.com
 * 2. Новый проект → удали весь код в редакторе и вставь сюда ВЕСЬ этот файл.
 * 3. Сохрани (Ctrl+S). SPREADSHEET_ID — сайт; ETH/BTC/RWA — одна таблица с A1 (без блоков H30).
 *    RWA: в «Свойства скрипта» задай JUPITER_API_KEY (portal.jup.ag, Free) — без ключа Jupiter отдаёт 0 позиций.
 * 4. Меню «Развёртывание» → «Новое развёртывание» → тип «Веб-приложение».
 * 5. Описание: например «DeFi Navigator API». Выполнять от имени: «Я». Доступ: «Все».
 * 6. Нажми «Развернуть», скопируй URL (он вида …/exec).
 * 7. В HTML-файле сайта вставь этот URL в переменную DATA_API_URL (см. README).
 */

/** Таблица «Defi LABS Navigator» — сайт (getData) и RWA (лист «БИТВА ПУЛОВ RWA», кошелёк Z2). */
var SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";
/**
 * RWA пишется в ЭТУ ЖЕ таблицу (файл в браузере: «Defi LABS Navigator»).
 * Старый ID 1NjN5… — другой файл; если синхронизация «ничего не меняла» — была эта путаница.
 */
var RWA_POOL_BATTLE_SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";

function sheetNameToCategoryId(name) {
  if (!name || typeof name !== "string") return "";
  var raw = String(name).trim();
  if (/\brwa\b/i.test(raw) || /real\s*world/i.test(raw)) return "rwa";
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Лист RWA: ссылка jup.ag/portfolio/… или адрес (Z2; B6 — старый формат). */
var RWA_WALLET_CELLS = ["Z2", "B6", "B2"];
var RWA_SYNC_MIN_INTERVAL_MS = 50 * 60 * 1000;
var JUPITER_PORTFOLIO_API_BASE = "https://api.jup.ag/portfolio/v1";
/** Fallback: UI scrape на Vercel, когда api.jup.ag/portfolio/v1 отдаёт elements=[]. */
var RWA_UI_SYNC_URL_DEFAULT = "https://defilabsvipnavigator.vercel.app/api/rwa-jupiter-sync";
/** Запас: вставь ключ здесь в редакторе Apps Script (в GitHub остаётся пустым). */
var JUPITER_API_KEY_CODE = "";
var RWA_JUPITER_KEY_CELL = "Z4";

function normalizeJupiterApiKey_(key) {
  return String(key || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/^["']+|["']+$/g, "");
}

function getJupiterApiKeyFromProperties_() {
  var propKeys = ["JUPITER_API_KEY", "JUPITER_API", "JUPITER_KEY", "jupiter_api_key"];
  var stores = [PropertiesService.getScriptProperties(), PropertiesService.getUserProperties()];
  try {
    stores.push(PropertiesService.getDocumentProperties());
  } catch (e) {}
  var s;
  var i;
  var v;
  for (s = 0; s < stores.length; s++) {
    for (i = 0; i < propKeys.length; i++) {
      v = normalizeJupiterApiKey_(stores[s].getProperty(propKeys[i]));
      if (v) return v;
    }
  }
  return "";
}

function getRwaJupiterApiKeyFromSheet_(sh) {
  if (!sh) return "";
  try {
    var v = String(sh.getRange(RWA_JUPITER_KEY_CELL).getDisplayValue() || "").trim();
    if (!v || /^jupiter\s*api/i.test(v) || /^ключ/i.test(v)) return "";
    if (v.length < 12) return "";
    return v;
  } catch (e) {
    return "";
  }
}

function persistJupiterApiKeyIfNeeded_(key) {
  var k = String(key || "").trim();
  if (!k) return;
  if (getJupiterApiKeyFromProperties_()) return;
  PropertiesService.getScriptProperties().setProperty("JUPITER_API_KEY", k);
}

function ensureRwaJupiterConfigLabels_(sh) {
  if (!sh) return;
  if (!String(sh.getRange("Z1").getValue() || "").trim()) {
    sh.getRange("Z1").setValue("Кошелёк Jupiter");
  }
  if (!String(sh.getRange("Z4").getValue() || "").trim()) {
    sh.getRange("Z4").setValue("Jupiter API key (portal.jup.ag)");
  }
}

function getJupiterApiKey_() {
  var key = getJupiterApiKeyFromProperties_();
  if (key) return key;
  key = normalizeJupiterApiKey_(JUPITER_API_KEY_CODE);
  if (key) return key;
  try {
    var sh = findRwaSheet_(openRwaSourceSpreadsheet_());
    key = getRwaJupiterApiKeyFromSheet_(sh);
    if (key) persistJupiterApiKeyIfNeeded_(key);
  } catch (e) {}
  return normalizeJupiterApiKey_(key);
}

function parseSolanaWalletFromCell_(value) {
  var s = String(value || "").trim();
  if (!s) return "";
  var m = s.match(/portfolio\/([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (m) return m[1];
  m = s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? m[1] : "";
}

/** Кошелёк с листа RWA (Z2 или legacy B6 / поиск по листу). */
function getRwaWalletFromSheet_(sh) {
  var i;
  for (i = 0; i < RWA_WALLET_CELLS.length; i++) {
    var rng = sh.getRange(RWA_WALLET_CELLS[i]);
    var w = parseSolanaWalletFromCell_(rng.getDisplayValue());
    if (!w) w = parseSolanaWalletFromCell_(rng.getValue());
    if (!w) {
      try {
        w = parseSolanaWalletFromCell_(rng.getFormula());
      } catch (e1) {}
    }
    if (!w) {
      try {
        w = parseSolanaWalletFromCell_(rng.getRichTextValue().getLinkUrl());
      } catch (e2) {}
    }
    if (w) return w;
  }
  var data = sh.getDataRange().getDisplayValues();
  var r;
  for (r = 0; r < Math.min(data.length, 40); r++) {
    var row = data[r] || [];
    var c;
    for (c = 0; c < row.length; c++) {
      var w2 = parseSolanaWalletFromCell_(row[c]);
      if (w2) return w2;
    }
  }
  var saved = String(
    PropertiesService.getScriptProperties().getProperty("RWA_WALLET") || "",
  ).trim();
  if (saved && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(saved)) return saved;
  return "";
}

/** Кошелёк только из листа «DeFi Labs Navigator» (битва пуллов), ячейка B6. */
function getRwaWalletForSync_(sourceSh) {
  return getRwaWalletFromSheet_(sourceSh);
}

function jupiterPortfolioSummary_(payload) {
  var n = payload && payload.elements && payload.elements.length ? payload.elements.length : 0;
  var reports = payload && payload.fetcherReports ? payload.fetcherReports : [];
  var parts = [];
  var i;
  for (i = 0; i < reports.length; i++) {
    var r = reports[i] || {};
    parts.push(String(r.id || "?") + ":" + String(r.status || "?"));
  }
  return {
    elements: n,
    fetcherReports: parts.length
      ? parts.join(", ")
      : "(пусто — индексация Jupiter не отдала данные)",
  };
}

function fetchJupiterApi_(pathAndQuery, apiKey) {
  var url = JUPITER_PORTFOLIO_API_BASE + pathAndQuery;
  var headers = { Accept: "application/json" };
  var key = normalizeJupiterApiKey_(apiKey);
  if (key) headers["x-api-key"] = key;
  var res = UrlFetchApp.fetch(url, {
    method: "get",
    muteHttpExceptions: true,
    headers: headers,
    followRedirects: true,
  });
  return {
    code: res.getResponseCode(),
    text: res.getContentText(),
    url: url,
  };
}

function fetchJupiterPositionsOnce_(wallet, querySuffix, apiKey) {
  return fetchJupiterApi_("/positions/" + encodeURIComponent(wallet) + (querySuffix || ""), apiKey);
}

function fetchJupiterPlatformsList_(apiKey) {
  var res = fetchJupiterApi_("/platforms", apiKey);
  if (res.code === 401) return [];
  if (res.code < 200 || res.code >= 300) return [];
  try {
    var data = JSON.parse(res.text);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function liquidityPlatformIdsForRwa_(platforms) {
  var ids = [];
  var seen = {};
  var want = ["raydium", "orca", "meteora"];
  var i;
  var p;
  var id;
  var w;
  var blob;
  for (i = 0; i < (platforms || []).length; i++) {
    p = platforms[i] || {};
    id = String(p.id || "").trim();
    if (!id || seen[id]) continue;
    blob = (id + " " + String(p.name || "") + " " + String(p.defiLlamaId || "")).toLowerCase();
    for (w = 0; w < want.length; w++) {
      if (blob.indexOf(want[w]) !== -1) {
        seen[id] = true;
        ids.push(id);
        break;
      }
    }
  }
  return ids;
}

function parseJupiterPortfolioResponse_(res) {
  if (res.code === 401) {
    throw new Error(
      "Jupiter API 401: ключ не принят. JUPITER_API_KEY в свойствах скрипта — без кавычек, с portal.jup.ag (Free).",
    );
  }
  if (res.code < 200 || res.code >= 300) {
    throw new Error("Jupiter API HTTP " + res.code + ": " + res.text.slice(0, 280));
  }
  return JSON.parse(res.text);
}

function jupiterSyncFailureMessage_(payload, wallet, apiKey) {
  var fr = payload && payload.fetcherReports ? payload.fetcherReports.length : 0;
  var keyLen = apiKey ? apiKey.length : 0;
  var msg =
    "Jupiter 0 LP: elements=0, fetcherReports=" +
    fr +
    ", ключ=" +
    (keyLen ? keyLen + " симв." : "НЕТ") +
    ", кошелёк=" +
    String(wallet || "").slice(0, 8) +
    "…";
  if (keyLen && fr === 0) {
    msg +=
      " Известный сбой Jupiter Portfolio API (#828): on-chain fallback Raydium/Orca через Vercel API.";
  } else if (!keyLen) {
    msg += " Нет JUPITER_API_KEY в свойствах скрипта.";
  }
  return msg;
}

function countRwaDataRowsOnSheet_(sh) {
  var data = sh.getDataRange().getValues();
  var hr = getRwaToolHeaderRowIndex_(data);
  var n = 0;
  var r;
  for (r = hr + 1; r < data.length; r++) {
    if (String(data[r][0] || "").trim()) n++;
  }
  return n;
}

function openRwaSourceSpreadsheet_() {
  return SpreadsheetApp.openById(RWA_POOL_BATTLE_SPREADSHEET_ID);
}

/** Показать в Z3, в какой файл реально пишет скрипт (проверка после деплоя). */
function verifyRwaSpreadsheetTarget() {
  var ss = openRwaSourceSpreadsheet_();
  var sh = findRwaSheet_(ss);
  if (!sh) throw new Error("Нет листа «" + RWA_SHEET_TITLE_CANONICAL + "»");
  var id = ss.getId();
  var keyOk = !!getJupiterApiKey_();
  var msg =
    "OK · «" +
    ss.getName() +
    "» · ID " +
    id +
    (keyOk ? " · Jupiter key ✓" : " · НЕТ JUPITER_API_KEY в свойствах скрипта!");
  writeRwaSyncStatus_(sh, msg.slice(0, 240));
  return {
    spreadsheetTitle: ss.getName(),
    spreadsheetId: id,
    sheet: sh.getName(),
    jupiterApiKey: keyOk,
  };
}

function isUnifiedPoolBattleHeaderRow_(headers) {
  if (!headers || !headers.length) return false;
  var hasPlatform = false;
  var hasMin = false;
  var i;
  for (i = 0; i < headers.length; i++) {
    var h = headers[i];
    if (/^(платформа|platform|dex|protocol|протокол)$/.test(h)) hasPlatform = true;
    if (/мин.*диапаз|min.*range|min_price|price_min/.test(h)) hasMin = true;
  }
  return hasPlatform && hasMin;
}

function rowToNormalizedHeaders_(row) {
  var headers = [];
  var c;
  for (c = 0; c < (row || []).length; c++) headers.push(normalizeHeaderCell(row[c]));
  return headers;
}

function findUnifiedHeaderRowIndex_(data) {
  var r;
  for (r = 0; r < Math.min(data.length, 40); r++) {
    if (isUnifiedPoolBattleHeaderRow_(rowToNormalizedHeaders_(data[r]))) return r;
  }
  return -1;
}

/** Перенос блока H30 (или уже A1) → единая таблица с A1. */
function relayoutRwaSheetToA1() {
  var ss = openRwaSourceSpreadsheet_();
  var sh = findRwaSheet_(ss);
  if (!sh) throw new Error("Нет листа «" + RWA_SHEET_TITLE_CANONICAL + "»");

  var data = sh.getDataRange().getValues();
  var unifiedAt = findUnifiedHeaderRowIndex_(data);
  if (unifiedAt === 0) {
    writeRwaSyncStatus_(sh, "RWA: таблица уже с A1");
    return { moved: 0, headerRow: 1 };
  }

  var headerRow1 = 0;
  var auxCol = 8;
  var auxCols = POOL_BATTLE_UNIFIED_LABELS.length;
  var r;
  for (r = 0; r < data.length; r++) {
    var row = data[r] || [];
    var h0 = normalizeHeaderCell(row[0]);
    var h7 = row.length > 7 ? normalizeHeaderCell(row[7]) : "";
    if (/^(платформа|platform)$/.test(h0) || /^(платформа|platform)$/.test(h7)) {
      if (!headerRow1 || r + 1 < headerRow1) headerRow1 = r + 1;
    }
  }
  if (!headerRow1) throw new Error("Не найден блок «Платформа» (A1 или H30)");

  var startCol = normalizeHeaderCell((data[headerRow1 - 1] || [])[0]) === "платформа" ? 1 : auxCol;
  var last = sh.getLastRow();
  var lines = [];
  for (r = headerRow1; r <= last; r++) {
    var row = data[r - 1] || [];
    if (!String(row[startCol - 1] || "").trim()) {
      if (lines.length) break;
      continue;
    }
    lines.push(row.slice(startCol - 1, startCol - 1 + auxCols));
  }
  if (!lines.length) throw new Error("Нет строк данных под шапкой (строка " + headerRow1 + ")");

  var wallet = getRwaWalletFromSheet_(sh);
  sh.getRange("A1:W120").clearContent();
  sh.getRange(1, 1, 1, POOL_BATTLE_UNIFIED_LABELS.length).setValues([POOL_BATTLE_UNIFIED_LABELS]);
  sh.getRange(2, 1, lines.length, POOL_BATTLE_UNIFIED_LABELS.length).setValues(lines);
  if (wallet) {
    sh.getRange("Z1").setValue("Кошелёк Jupiter");
    sh.getRange("Z2").setValue("https://jup.ag/portfolio/" + wallet);
  }

  var ts = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone() || "GMT",
    "dd.MM.yyyy HH:mm",
  );
  writeRwaSyncStatus_(sh, "A1: " + lines.length + " строк · " + ts);
  return { moved: lines.length, fromRow: headerRow1 };
}

/** @deprecated Используйте relayoutRwaSheetToA1 */
function relayoutRwaBlockToH30() {
  return relayoutRwaSheetToA1();
}

function openSiteSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function rwaSheetHasDataRows_(sh) {
  var data = sh.getDataRange().getValues();
  var hr = getRwaToolHeaderRowIndex_(data);
  var r;
  for (r = hr + 1; r < data.length; r++) {
    if (String(data[r][0] || "").trim()) return true;
  }
  return false;
}

function writeRwaSyncStatus_(sh, message) {
  try {
    sh.getRange("Z3").setValue(String(message || "").slice(0, 240));
  } catch (e) {}
}

/** Истинное имя листа в таблице (регистр не важен; «пулов» и «пуллов» — оба варианта). */
var RWA_SHEET_TITLE_CANONICAL = "БИТВА ПУЛОВ RWA";

function normalizeRwaSheetTitle_(title) {
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ё/g, "е");
}

function isRwaPoolBattleSheet_(title) {
  var n = normalizeRwaSheetTitle_(title);
  if (n === normalizeRwaSheetTitle_(RWA_SHEET_TITLE_CANONICAL)) return true;
  if (/битва/.test(n) && /пулл?ов/.test(n) && /\brwa\b/.test(n)) return true;
  if (/bitv/.test(n) && /pool/.test(n) && /\brwa\b/.test(n)) return true;
  if (/\brwa\b/.test(n) && /real\s*world/.test(n)) return true;
  return false;
}

function findRwaSheet_(ss) {
  var sheets = ss.getSheets();
  var fallback = null;
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var title = sh.getName();
    if (normalizeRwaSheetTitle_(title) === normalizeRwaSheetTitle_(RWA_SHEET_TITLE_CANONICAL)) {
      return sh;
    }
    if (isRwaPoolBattleSheet_(title) && !fallback) fallback = sh;
  }
  return fallback;
}

/** Единая таблица «битва пуллов» с A1 (ETH, BTC, RWA). */
var POOL_BATTLE_UNIFIED_LABELS = [
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
var RWA_DAILY_LOG_SHEET = "RWA_DAILY_LOG";
/** Одна строка на позицию в календарный день (для графиков по дням). */
var RWA_INCOME_DAILY_SHEET = "RWA_INCOME_DAILY";
var RWA_DISPLAY_TZ = "Europe/Warsaw";
/** RWA на сайте: фиксированный «диапазон» ±10% (в лист не пишем цены). */
var RWA_RANGE_MIN_LABEL = "-10%";
var RWA_RANGE_MAX_LABEL = "+10%";

function normalizePairKey_(pair) {
  return String(pair || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\u00a0/g, "")
    .replace(/[·•]/g, "/");
}

/** RWA: отсекаем пулы с ETH/WETH/BTC/WBTC/cbBTC и т.п. */
function pairContainsEthOrBtc_(pair, name, platform) {
  var blob =
    normalizePairKey_(pair) + "|" + normalizePairKey_(name) + "|" + normalizePairKey_(platform);
  if (!blob || blob === "||") return false;
  if (/\b(weth|ethereum)\b/.test(blob)) return true;
  if (/\b(eth)\b/.test(blob) && !/\bether/.test(blob)) return true;
  if (/\b(wbtc|cbbtc|bitcoin)\b/.test(blob)) return true;
  if (/\b(btc)\b/.test(blob)) return true;
  if (/cbbtc|wbtc|\/eth\b|\beth\/|\bbtc\b/.test(blob)) return true;
  return false;
}

/** Bitcoin: только лишняя позиция Orca USDC/cbBTC (не все пары с cbBTC). */
function isExcludedBitcoinUsdcCbbtc_(pair, platform) {
  var p = normalizePairKey_(pair);
  if (p !== "usdc/cbbtc") return false;
  return /orca/i.test(String(platform || ""));
}

function shouldSkipToolRow_(catId, pair, name, platform) {
  if (catId === "rwa" && pairContainsEthOrBtc_(pair, name, platform)) return true;
  if (catId === "bitcoin" && isExcludedBitcoinUsdcCbbtc_(pair, platform)) return true;
  return false;
}

function getRwaToolHeaderRowIndex_(data) {
  var unified = findUnifiedHeaderRowIndex_(data);
  if (unified >= 0) return unified;
  for (var r = 0; r < Math.min(data.length, 20); r++) {
    var headers = rowToNormalizedHeaders_(data[r]);
    var hasName = false;
    var hasApy = false;
    for (var hi = 0; hi < headers.length; hi++) {
      if (/^(name|название|instrument|инструмент)$/.test(headers[hi])) hasName = true;
      if (/^(apy|доходность|доход|yield|rate|apr)$/.test(headers[hi])) hasApy = true;
    }
    if (hasName && hasApy) return r;
  }
  return 0;
}

function buildSolanaDesc_(chain, fee) {
  var c = String(chain || "solana").trim() || "solana";
  var f = String(fee || "").trim();
  return f ? c + " " + f : c;
}

function formatPlatformDisplay_(platformId, fallbackName) {
  var pid = String(platformId || "").toLowerCase();
  if (pid.indexOf("raydium") !== -1) return "Raydium";
  if (pid.indexOf("orca") !== -1) return "Orca";
  if (pid.indexOf("meteora") !== -1) return "Meteora";
  if (pid.indexOf("kamino") !== -1) return "Kamino";
  if (fallbackName) return String(fallbackName).trim();
  if (!pid) return "Solana";
  return pid.charAt(0).toUpperCase() + pid.slice(1);
}

function isNavigatorLiquidityElement_(el) {
  if (!el) return false;
  if (String(el.networkId || "") !== "solana") return false;
  var type = String(el.type || "");
  var label = String(el.label || "");
  var pid = String(el.platformId || "").toLowerCase();

  if (type === "borrowlend") return false;
  if (label === "Lending") return false;
  if (pid.indexOf("kamino") !== -1 && (type === "borrowlend" || label === "Lending")) return false;
  if (type === "liquidity") return true;
  if (label === "LiquidityPool") return true;
  if (type === "multiple" && label === "LiquidityPool") return true;
  if (el.data && el.data.liquidities && el.data.liquidities.length) return true;
  if (
    pid.indexOf("raydium") !== -1 ||
    pid.indexOf("orca") !== -1 ||
    pid.indexOf("meteora") !== -1
  ) {
    return true;
  }
  return false;
}

function extractFeePercent_(text) {
  var s = String(text || "");
  var m = s.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return "";
  return String(m[1]).replace(",", ".");
}

/** APY с Jupiter (как в UI): только apy / netApy, без пересчёта APR→APY. */
function apyPercentNumberFromJupiter_(el, liq) {
  var frac = null;
  if (liq && liq.yields && liq.yields.length) {
    var y0 = liq.yields[0];
    if (y0 && y0.apy != null && !isNaN(Number(y0.apy))) frac = Number(y0.apy);
  }
  if (frac == null && liq && liq.netApy != null && !isNaN(Number(liq.netApy)))
    frac = Number(liq.netApy);
  if (frac == null && el && el.netApy != null && !isNaN(Number(el.netApy)))
    frac = Number(el.netApy);
  if (frac == null && liq && liq.yields && liq.yields.length) {
    var y1 = liq.yields[0];
    if (y1 && y1.apr != null && !isNaN(Number(y1.apr))) frac = Number(y1.apr);
  }
  if (frac == null) return 0;
  return frac <= 1 && frac >= -1 ? frac * 100 : frac;
}

function apyPercentFromJupiter_(el, liq) {
  var n = apyPercentNumberFromJupiter_(el, liq);
  return String(Math.round(n * 100) / 100) + "%";
}

function formatDateTimeWarsaw_(ms) {
  if (!ms || isNaN(ms)) return "";
  return Utilities.formatDate(new Date(ms), RWA_DISPLAY_TZ, "dd.MM.yyyy HH:mm");
}

function hoursElapsedSinceMs_(ms) {
  if (!ms || isNaN(ms)) return 24;
  return Math.max(1, (Date.now() - Number(ms)) / 3600000);
}

/** Суммарный доход комиссий в USD: стейблы + RWA-токен (как в Jupiter, без ручного пересчёта). */
function rwaTotalFeeIncomeUsd_(rewards, liq, tokenInfo) {
  var rew = rewards || splitRewardAssets_(liq, tokenInfo);
  var sum = (Number(rew.stableUsd) || 0) + (Number(rew.assetUsd) || 0);
  if (sum > 0) return sum;
  return extractFeeIncomeUsd_(liq, tokenInfo);
}

/** Строка APY для ячеек таблицы — без авто-даты (20.07 → 20 июля). */
function formatApyForSheet_(apy) {
  var s = String(apy == null ? "" : apy)
    .replace(/%/g, "")
    .trim();
  if (!s || s === "0") return "0%";
  return s.indexOf("%") !== -1 ? s : s + "%";
}

/** APY из ячейки: Google Sheets иногда превращает 20.07 в дату 20.07.2026. */
function normalizeApyFromCell_(val) {
  if (val instanceof Date) {
    var d = val.getDate();
    var m = val.getMonth() + 1;
    return String(d) + "." + String(m);
  }
  return String(val == null ? "" : val)
    .replace(/%/g, "")
    .trim();
}

function tokenSymbolFromAsset_(asset, tokenInfo) {
  if (!asset || asset.type !== "token" || !asset.data) return "";
  var addr = asset.data.address;
  if (tokenInfo && tokenInfo.solana && addr && tokenInfo.solana[addr]) {
    return String(tokenInfo.solana[addr].symbol || "").trim();
  }
  if (asset.data.symbol) return String(asset.data.symbol).trim();
  return addr ? String(addr).slice(0, 6) : "";
}

function pairFromLiquidityAssets_(liq, tokenInfo) {
  var assets = liq && liq.assets ? liq.assets : [];
  var syms = [];
  for (var i = 0; i < assets.length; i++) {
    var sym = tokenSymbolFromAsset_(assets[i], tokenInfo);
    if (sym) syms.push(sym);
  }
  return syms.length ? syms.join(" / ") : "";
}

function isStableSymbol_(sym) {
  return /^(USDC|USDT|USD1|PYUSD|USDS|DAI|CASH|USDC\.e|UXD)$/i.test(String(sym || "").trim());
}

function tokenValueUsd_(asset) {
  if (!asset) return 0;
  if (asset.value != null && !isNaN(Number(asset.value))) return Number(asset.value);
  if (asset.type === "token" && asset.data) {
    var amt = Number(asset.data.amount) || 0;
    var pr = Number(asset.data.price) || 0;
    return amt * pr;
  }
  return 0;
}

function splitRewardAssets_(liq, tokenInfo) {
  var stableUsd = 0;
  var assetAmt = 0;
  var assetSym = "";
  var assetUsd = 0;
  var rewards = liq && liq.rewardAssets ? liq.rewardAssets : [];
  var i;
  for (i = 0; i < rewards.length; i++) {
    var sym = tokenSymbolFromAsset_(rewards[i], tokenInfo);
    var val = tokenValueUsd_(rewards[i]);
    var amt =
      rewards[i] && rewards[i].data && rewards[i].data.amount != null
        ? Number(rewards[i].data.amount)
        : 0;
    if (isStableSymbol_(sym)) {
      stableUsd += val;
    } else if (sym) {
      if (!assetSym) assetSym = sym;
      assetAmt += amt;
      assetUsd += val;
    }
  }
  return {
    stableUsd: stableUsd,
    assetAmount: assetAmt,
    assetSymbol: assetSym,
    assetUsd: assetUsd,
    totalUsd: stableUsd + assetUsd,
  };
}

function parseRangeFromPoolName_(text) {
  var s = String(text || "");
  var m = s.match(/(\d[\d\s.,]*)\s*[-–—]\s*(\d[\d\s.,]*)/);
  if (!m) return { min: "", max: "" };
  return {
    min: String(m[1]).replace(/\s/g, "").replace(",", "."),
    max: String(m[2]).replace(/\s/g, "").replace(",", "."),
  };
}

function enrichRangeFromLiquidity_(liq) {
  var r = parseRangeFromPoolName_((liq && liq.name) || "");
  if (r.min && r.max) return r;
  if (!liq) return r;
  var low =
    liq.priceMin != null ? liq.priceMin : liq.priceLower != null ? liq.priceLower : liq.lowerPrice;
  var high =
    liq.priceMax != null ? liq.priceMax : liq.priceUpper != null ? liq.priceUpper : liq.upperPrice;
  if (low != null && high != null && !isNaN(Number(low)) && !isNaN(Number(high))) {
    return { min: String(low), max: String(high) };
  }
  if (liq.range && liq.range.min != null && liq.range.max != null) {
    return { min: String(liq.range.min), max: String(liq.range.max) };
  }
  return r;
}

function extractFeeIncomeUsd_(liq, tokenInfo) {
  var rew = splitRewardAssets_(liq, tokenInfo);
  var total = rew.totalUsd;
  if (!liq) return total;
  var keys = [
    "feesUsd",
    "feeValue",
    "unclaimedFees",
    "claimableFees",
    "pendingFees",
    "totalFees",
    "accruedFees",
  ];
  var i;
  for (i = 0; i < keys.length; i++) {
    if (liq[keys[i]] != null && !isNaN(Number(liq[keys[i]]))) {
      total = Math.max(total, Number(liq[keys[i]]));
    }
  }
  if (liq.fees && liq.fees.total != null && !isNaN(Number(liq.fees.total))) {
    total = Math.max(total, Number(liq.fees.total));
  }
  if (liq.fees && liq.fees.usd != null && !isNaN(Number(liq.fees.usd))) {
    total = Math.max(total, Number(liq.fees.usd));
  }
  return total;
}

function formatSheetNumber_(n, decimals) {
  if (n == null || isNaN(Number(n))) return "";
  var d = decimals == null ? 6 : decimals;
  return String(Math.round(Number(n) * Math.pow(10, d)) / Math.pow(10, d));
}

/** USD/кол-во с мелкими значениями (не округлять до 0,01). */
function formatPreciseAmount_(n, decimals) {
  if (n == null || isNaN(Number(n))) return "";
  var v = Number(n);
  if (v === 0) return "0";
  var d = decimals == null ? 8 : decimals;
  if (Math.abs(v) < Math.pow(10, -d)) return v.toExponential(3);
  return String(Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
}

function openTimestampMsFromElement_(el, liq) {
  var ms = null;
  if (liq && liq.createdAt != null) ms = Number(liq.createdAt);
  if ((!ms || isNaN(ms)) && liq && liq.openedAt != null) ms = Number(liq.openedAt);
  if ((!ms || isNaN(ms)) && el && el.data && el.data.createdAt != null)
    ms = Number(el.data.createdAt);
  if ((!ms || isNaN(ms)) && el && el.updatedAt != null) ms = Number(el.updatedAt);
  return !ms || isNaN(ms) ? null : ms;
}

function parseOpenDateWarsawToMs_(dateStr) {
  var s = String(dateStr || "").trim();
  if (!s) return null;
  try {
    if (/\d{1,2}:\d{2}/.test(s)) {
      return Utilities.parseDate(s, RWA_DISPLAY_TZ, "dd.MM.yyyy HH:mm").getTime();
    }
    return Utilities.parseDate(s, RWA_DISPLAY_TZ, "dd.MM.yyyy").getTime();
  } catch (e) {
    return null;
  }
}

function persistRwaOpenMs_(linkKey, ms) {
  if (!linkKey || !ms || isNaN(ms)) return;
  var props = PropertiesService.getScriptProperties();
  var k = "RWA_OPEN_MS_" + linkKey;
  var stored = props.getProperty(k);
  if (!stored || Number(stored) > ms) props.setProperty(k, String(ms));
}

function resolveRwaOpenMs_(link, el, liq) {
  var linkKey = normalizeLinkKey(link);
  var apiMs = openTimestampMsFromElement_(el, liq);
  if (!linkKey) return apiMs;
  var props = PropertiesService.getScriptProperties();
  var k = "RWA_OPEN_MS_" + linkKey;
  var stored = props.getProperty(k);
  if (stored) {
    var sMs = Number(stored);
    if (apiMs && apiMs < sMs) {
      props.setProperty(k, String(apiMs));
      return apiMs;
    }
    return sMs;
  }
  if (apiMs) {
    props.setProperty(k, String(apiMs));
    return apiMs;
  }
  return null;
}

/** Перед перезаписью листа — сохранить дату открытия из ячеек (с часами). */
function harvestRwaOpenDatesFromSheet_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var openDisp = sh.getRange(2, 4, last, 4).getDisplayValues();
  var links = sh.getRange(2, 13, last, 13).getDisplayValues();
  var i;
  for (i = 0; i < openDisp.length; i++) {
    var ms = parseOpenDateWarsawToMs_(openDisp[i][0]);
    var lk = normalizeLinkKey(links[i][0]);
    if (ms && lk) persistRwaOpenMs_(lk, ms);
  }
}

function periodFromTimestampMs_(ms) {
  if (!ms || isNaN(Number(ms))) return "0 ч";
  var hours = Math.max(0, Math.floor((Date.now() - Number(ms)) / 3600000));
  if (hours < 72) return hours + " ч";
  return Math.floor(hours / 24) + " дн";
}

function periodFromOpenDateString_(dateStr) {
  var s = String(dateStr || "").trim();
  var m = s.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return "";
  var y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  var hh = m[4] != null ? parseInt(m[4], 10) : 0;
  var mm = m[5] != null ? parseInt(m[5], 10) : 0;
  var opened = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10), hh, mm);
  if (isNaN(opened.getTime())) return "";
  var hours = Math.max(0, Math.floor((Date.now() - opened.getTime()) / 3600000));
  if (hours < 72) return hours + " ч";
  return Math.floor(hours / 24) + " дн";
}

/** Период из ячейки «Дата открытия»: display dd.mm.yyyy HH:mm (Варшава) или serial Sheets. */
function periodFromOpenDateCell_(rawVal, displayVal) {
  var fromDisp = periodFromOpenDateString_(displayVal);
  if (fromDisp) return fromDisp;
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    return periodFromTimestampMs_(rawVal.getTime());
  }
  if (typeof rawVal === "number" && !isNaN(rawVal) && rawVal > 20000 && rawVal < 80000) {
    var base = new Date(Date.UTC(1899, 11, 30));
    var opened = new Date(base.getTime() + Math.round(rawVal) * 86400000);
    if (!isNaN(opened.getTime())) return periodFromTimestampMs_(opened.getTime());
  }
  return periodFromOpenDateString_(String(rawVal || ""));
}

function openDateFromElement_(el, liq) {
  var ms = null;
  if (el && el.updatedAt) ms = Number(el.updatedAt);
  if (!ms && el && el.data && el.data.createdAt) ms = Number(el.data.createdAt);
  if (!ms && liq && liq.createdAt) ms = Number(liq.createdAt);
  if (!ms || isNaN(ms)) {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT", "dd.MM.yyyy");
  }
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone() || "GMT", "dd.MM.yyyy");
}

function mapLiquidityToRow_(el, liq, tokenInfo, wallet) {
  var platform = formatPlatformDisplay_(el.platformId, el.name);
  var poolName = liq && liq.name ? String(liq.name).trim() : "";
  var pair = pairFromLiquidityAssets_(liq, tokenInfo);
  if (!pair && poolName && poolName.indexOf("/") !== -1) pair = poolName;
  var link = liq && liq.link ? String(liq.link).trim() : "";
  if (!link && el.data && el.data.link) link = String(el.data.link).trim();
  if (!link && wallet) {
    var slug = (platform + "-" + (pair || poolName)).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    link = "https://jup.ag/portfolio/" + wallet + "#" + slug;
  }
  var fee = extractFeePercent_(poolName) || extractFeePercent_(el.name) || "";
  var chain = "solana";
  var rewards = splitRewardAssets_(liq, tokenInfo);
  var feeTotalUsd = rwaTotalFeeIncomeUsd_(rewards, liq, tokenInfo);
  var invested =
    liq && liq.value != null
      ? Number(liq.value)
      : liq && liq.assetsValue != null
        ? Number(liq.assetsValue)
        : 0;
  if (isNaN(invested)) invested = 0;
  var openMs = resolveRwaOpenMs_(link, el, liq);
  var openDate = openMs ? formatDateTimeWarsaw_(openMs) : openDateFromElement_(el, liq);
  var period = openMs ? periodFromTimestampMs_(openMs) : periodFromOpenDateString_(openDate);
  var apy = apyPercentFromJupiter_(el, liq);
  var hours = hoursElapsedSinceMs_(openMs);
  return {
    name: platform,
    apy: apy,
    period: period,
    status: "active",
    link: link || "#",
    desc: buildSolanaDesc_(chain, fee),
    pair: pair,
    platform: platform,
    fee: fee,
    chain: chain,
    type: "Liquidity Pool",
    priceMin: "",
    priceMax: "",
    openDate: openDate,
    openMs: openMs || "",
    earnedStables: rewards.stableUsd,
    earnedAsset: rewards.assetAmount,
    earnedAssetUsd: rewards.assetUsd,
    earnedAssetSymbol: rewards.assetSymbol,
    totalFeeIncome: feeTotalUsd,
    investedUsd: invested,
    hoursOpen: hours,
  };
}

function jupiterElementsToRows_(payload, wallet) {
  var elements = payload && payload.elements ? payload.elements : [];
  var tokenInfo = payload && payload.tokenInfo ? payload.tokenInfo : {};
  var rows = [];
  var seen = {};
  for (var e = 0; e < elements.length; e++) {
    var el = elements[e];
    if (!isNavigatorLiquidityElement_(el)) continue;
    var chunk = [];
    if (el.type === "liquidity" && el.data && el.data.liquidities && el.data.liquidities.length) {
      for (var l = 0; l < el.data.liquidities.length; l++) {
        chunk.push(mapLiquidityToRow_(el, el.data.liquidities[l], tokenInfo, wallet));
      }
    } else {
      chunk.push(mapLiquidityToRow_(el, null, tokenInfo, wallet));
    }
    for (var c = 0; c < chunk.length; c++) {
      var row = chunk[c];
      if (pairContainsEthOrBtc_(row.pair, row.name, row.platform)) continue;
      var key = normalizeLinkKey(row.link) + "|" + String(row.name).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      rows.push(row);
    }
  }
  rows.sort(function (a, b) {
    return parseFloat(String(b.apy)) - parseFloat(String(a.apy));
  });
  return rows;
}

/** Fallback: on-chain Raydium/Orca через Vercel API (когда Jupiter REST пустой). */
function fetchRwaPositionsViaUiProxy_(wallet) {
  var base =
    PropertiesService.getScriptProperties().getProperty("RWA_UI_SYNC_URL") ||
    RWA_UI_SYNC_URL_DEFAULT;
  var secret = PropertiesService.getScriptProperties().getProperty("RWA_UI_SYNC_SECRET") || "";
  var url = base + "?wallet=" + encodeURIComponent(wallet);
  if (secret) url += "&secret=" + encodeURIComponent(secret);
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      muteHttpExceptions: true,
      followRedirects: true,
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(
        "RWA UI proxy HTTP " + res.getResponseCode() + ": " + res.getContentText().slice(0, 200),
      );
      return null;
    }
    var data = JSON.parse(res.getContentText());
    if (!data || !data.ok || !data.rows || !data.rows.length) return null;
    var ts = Utilities.formatDate(new Date(), RWA_DISPLAY_TZ, "dd.MM.yyyy HH:mm");
    return data.rows.map(function (r) {
      return {
        name: r.platform,
        platform: r.platform,
        pair: r.pair,
        apy: r.apy,
        link: r.link,
        investedUsd: r.investedUsd,
        earnedStables: r.earnedStables,
        earnedAsset: r.earnedAsset,
        earnedAssetSymbol: r.earnedAssetSymbol,
        totalFeeIncome: r.totalFeeIncome,
        chain: r.chain || "solana",
        fee: r.fee || "",
        openDate: ts,
        period: "",
        status: "active",
        desc: "",
        type: "Liquidity Pool",
        priceMin: "",
        priceMax: "",
        hoursOpen: "",
      };
    });
  } catch (e) {
    Logger.log("RWA UI proxy: " + e);
    return null;
  }
}

function fetchJupiterPositions_(wallet, fastMode) {
  var apiKey = getJupiterApiKey_();
  var attempts = fastMode ? 3 : 6;
  var bestPayload = null;
  var bestN = -1;
  var lastPayload = null;
  var platforms = apiKey ? fetchJupiterPlatformsList_(apiKey) : [];
  var liqIds = liquidityPlatformIdsForRwa_(platforms);
  var queryPlan = [""];
  if (liqIds.length) {
    queryPlan.push("?platforms=" + encodeURIComponent(liqIds.join(",")));
  }
  var attempt;
  var q;
  var res;
  var payload;
  var n;

  for (attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) Utilities.sleep(fastMode ? 3000 : 5000);
    for (q = 0; q < queryPlan.length; q++) {
      if (attempt > 0 || q > 0) Utilities.sleep(fastMode ? 1500 : 2500);
      res = fetchJupiterPositionsOnce_(wallet, queryPlan[q], apiKey);
      payload = parseJupiterPortfolioResponse_(res);
      lastPayload = payload;
      n = payload.elements && payload.elements.length ? payload.elements.length : 0;
      if (n > bestN) {
        bestN = n;
        bestPayload = payload;
      }
      if (n > 0) return payload;
    }
  }

  if (!apiKey) {
    throw new Error(
      "Jupiter 0 позиций: API-ключ не найден (свойства скрипта / Z4 / JUPITER_API_KEY_CODE).",
    );
  }
  return lastPayload || bestPayload || { elements: [], fetcherReports: [], tokenInfo: {} };
}

function rwaRowToUnifiedLine_(row) {
  var feeLabel = row.fee ? (String(row.fee).indexOf("%") !== -1 ? row.fee : row.fee + "%") : "";
  return [
    row.platform || row.name,
    "",
    "",
    row.openDate || "",
    formatPreciseAmount_(row.earnedStables, 8),
    formatPreciseAmount_(row.earnedAsset, 12),
    row.earnedAssetSymbol || "",
    "",
    formatPreciseAmount_(row.totalFeeIncome, 8),
    row.pair,
    row.chain || "solana",
    feeLabel,
    formatApyForSheet_(row.apy),
    row.link,
    formatPreciseAmount_(row.investedUsd, 4),
  ];
}

function writeRwaPoolBattleSheet_(sh, rows) {
  if (!rows || !rows.length) return 0;
  harvestRwaOpenDatesFromSheet_(sh);
  var cols = POOL_BATTLE_UNIFIED_LABELS.length;
  var wallet = getRwaWalletFromSheet_(sh);
  sh.getRange("A1:W120").clearContent();
  sh.getRange(1, 1, 1, cols).setValues([POOL_BATTLE_UNIFIED_LABELS]);
  var lines = rows.map(rwaRowToUnifiedLine_);
  sh.getRange(2, 1, lines.length, cols).setValues(lines);
  sh.getRange("Z1").setValue("Кошелёк Jupiter");
  if (wallet) {
    sh.getRange("Z2").setValue("https://jup.ag/portfolio/" + wallet);
  }
  return rows.length;
}

function ensureRwaDailyLogSheet_(ss) {
  var sh = ss.getSheetByName(RWA_DAILY_LOG_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(RWA_DAILY_LOG_SHEET);
  sh.getRange(1, 1, 1, 12).setValues([
    [
      "Синк (Варшава)",
      "День",
      "Платформа",
      "Пара",
      "Ссылка",
      "Стейблы USD",
      "Актив USD",
      "Символ актива",
      "Итого комс USD",
      "Инвестировано USD",
      "APY Jupiter",
      "Часов с открытия",
    ],
  ]);
  return sh;
}

function ensureRwaIncomeDailySheet_(ss) {
  var sh = ss.getSheetByName(RWA_INCOME_DAILY_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(RWA_INCOME_DAILY_SHEET);
  sh.getRange(1, 1, 1, 11).setValues([
    [
      "День",
      "Платформа",
      "Пара",
      "Ссылка",
      "Стейблы USD",
      "Актив USD",
      "Итого комс USD",
      "Инвестировано USD",
      "APY %",
      "Часов",
      "Обновлено",
    ],
  ]);
  return sh;
}

function upsertRwaIncomeDailySnapshot_(ss, rows) {
  if (!rows || !rows.length) return;
  var sh = ensureRwaIncomeDailySheet_(ss);
  var day = Utilities.formatDate(new Date(), RWA_DISPLAY_TZ, "yyyy-MM-dd");
  var updatedAt = Utilities.formatDate(new Date(), RWA_DISPLAY_TZ, "dd.MM.yyyy HH:mm");
  var last = sh.getLastRow();
  var existing = last > 1 ? sh.getRange(2, 1, last, 11).getValues() : [];
  var index = {};
  var i;
  for (i = 0; i < existing.length; i++) {
    var key = String(existing[i][0]) + "|" + normalizeLinkKey(String(existing[i][3] || ""));
    index[key] = i + 2;
  }
  for (i = 0; i < rows.length; i++) {
    var row = rows[i];
    var linkKey = normalizeLinkKey(row.link);
    var dayKey = day + "|" + linkKey;
    var line = [
      day,
      row.platform,
      row.pair,
      row.link,
      row.earnedStables,
      row.earnedAssetUsd != null ? row.earnedAssetUsd : "",
      row.totalFeeIncome,
      row.investedUsd,
      row.apy,
      row.hoursOpen != null ? row.hoursOpen : "",
      updatedAt,
    ];
    if (index[dayKey]) {
      sh.getRange(index[dayKey], 1, 1, 11).setValues([line]);
    } else {
      sh.appendRow(line);
      index[dayKey] = sh.getLastRow();
    }
  }
}

function appendRwaDailyLog_(ss, rows) {
  if (!rows || !rows.length) return;
  var logSh = ensureRwaDailyLogSheet_(ss);
  var syncAt = Utilities.formatDate(new Date(), RWA_DISPLAY_TZ, "dd.MM.yyyy HH:mm");
  var day = Utilities.formatDate(new Date(), RWA_DISPLAY_TZ, "dd.MM.yyyy");
  var out = rows.map(function (row) {
    return [
      syncAt,
      day,
      row.platform,
      row.pair,
      row.link,
      row.earnedStables,
      row.earnedAssetUsd != null ? row.earnedAssetUsd : row.earnedAsset,
      row.earnedAssetSymbol,
      row.totalFeeIncome,
      row.investedUsd,
      row.apy,
      row.hoursOpen != null ? row.hoursOpen : "",
    ];
  });
  var start = logSh.getLastRow() + 1;
  logSh.getRange(start, 1, out.length, 12).setValues(out);
  upsertRwaIncomeDailySnapshot_(ss, rows);
}

/** VIP Navigator Data для RWA не используем — только таблица DeFi Labs Navigator. */
function copyRwaDataToSiteSpreadsheet_() {
  return false;
}

/**
 * Синхронизация листа RWA: Jupiter Portfolio → строки инструментов (только liquidity pool).
 * Кошелёк / ссылка jup.ag/portfolio/… — ячейка Z2 (или B6) на листе RWA.
 */
function syncRwaJupiterPositions() {
  var ss = openRwaSourceSpreadsheet_();
  var sh = findRwaSheet_(ss);
  if (!sh) throw new Error("На таблице битвы пуллов нет листа «БИТВА ПУЛОВ RWA»");
  ensureRwaJupiterConfigLabels_(sh);
  persistJupiterApiKeyIfNeeded_(getRwaJupiterApiKeyFromSheet_(sh));

  var wallet = getRwaWalletForSync_(sh);
  if (!wallet) {
    throw new Error("Укажите кошелёк в Z2 (или B6): jup.ag/portfolio/… или Solana-адрес");
  }
  PropertiesService.getScriptProperties().setProperty("RWA_WALLET", wallet);

  var payload = fetchJupiterPositions_(wallet, false);
  var rows = jupiterElementsToRows_(payload, wallet);
  var diag = jupiterPortfolioSummary_(payload);
  var source = "jupiter-api";
  if (!rows.length) {
    rows = fetchRwaPositionsViaUiProxy_(wallet) || [];
    if (rows.length) source = "onchain-raydium-orca";
  }
  var ts = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone() || "GMT",
    "dd.MM.yyyy HH:mm",
  );

  if (!rows.length) {
    var kept = countRwaDataRowsOnSheet_(sh);
    var apiKey = getJupiterApiKey_();
    var msg =
      jupiterSyncFailureMessage_(payload, wallet, apiKey) +
      " Fallback UI scrape недоступен." +
      (kept ? " Старые " + kept + " строк не обновлены." : "");
    writeRwaSyncStatus_(sh, msg.slice(0, 240));
    throw new Error(msg.slice(0, 500));
  }

  writeRwaPoolBattleSheet_(sh, rows);
  appendRwaDailyLog_(ss, rows);

  PropertiesService.getScriptProperties().setProperty("RWA_LAST_SYNC_MS", String(Date.now()));
  PropertiesService.getScriptProperties().setProperty("RWA_LAST_SYNC_COUNT", String(rows.length));
  writeRwaSyncStatus_(sh, "OK · " + rows.length + " LP · " + source + " · " + ts);
  return {
    wallet: wallet,
    count: rows.length,
    syncedAt: new Date().toISOString(),
    diag: diag,
    source: source,
  };
}

/** Журнал → View → Logs: проверка Jupiter API (ключ, elements, fetcherReports). */
function diagnoseRwaJupiterApi() {
  var sh = findRwaSheet_(openRwaSourceSpreadsheet_());
  if (!sh) throw new Error("Нет листа «" + RWA_SHEET_TITLE_CANONICAL + "»");
  var wallet = getRwaWalletForSync_(sh);
  if (!wallet) throw new Error("Нет кошелька в Z2/B6");
  var apiKey = getJupiterApiKey_();
  Logger.log("JUPITER_API_KEY: " + (apiKey ? "есть (" + apiKey.length + " симв.)" : "НЕТ"));
  Logger.log("wallet: " + wallet);
  var platforms = apiKey ? fetchJupiterPlatformsList_(apiKey) : [];
  var liqIds = liquidityPlatformIdsForRwa_(platforms);
  Logger.log("platforms в API: " + platforms.length + ", RWA ids: " + liqIds.join(", "));
  var res = fetchJupiterPositionsOnce_(wallet, "", apiKey);
  Logger.log("HTTP " + res.code + " " + res.url);
  var payload = parseJupiterPortfolioResponse_(res);
  var diag = jupiterPortfolioSummary_(payload);
  var rows = jupiterElementsToRows_(payload, wallet);
  Logger.log("elements: " + diag.elements + " → LP-строк: " + rows.length);
  Logger.log("fetcherReports: " + diag.fetcherReports);
  if (!diag.elements && apiKey) {
    Logger.log("Подсказка: " + jupiterSyncFailureMessage_(payload, wallet, apiKey));
  }
  Logger.log("ответ (начало): " + JSON.stringify(payload).slice(0, 2500));
  return {
    wallet: wallet,
    diag: diag,
    lpRows: rows.length,
    platforms: platforms.length,
    liquidityPlatformIds: liqIds,
    httpCode: res.code,
  };
}

function syncRwaJupiterPositionsIfDue_() {
  try {
    var ss = openRwaSourceSpreadsheet_();
    var sh = findRwaSheet_(ss);
    if (!sh) {
      Logger.log("RWA: лист «" + RWA_SHEET_TITLE_CANONICAL + "» не найден");
      return;
    }
    if (!getRwaWalletForSync_(sh)) {
      writeRwaSyncStatus_(sh, "Нет кошелька в Z2/B6 (jup.ag/portfolio/…)");
      return;
    }
    var last = Number(
      PropertiesService.getScriptProperties().getProperty("RWA_LAST_SYNC_MS") || "0",
    );
    if (rwaSheetHasDataRows_(sh) && Date.now() - last < RWA_SYNC_MIN_INTERVAL_MS) return;
    var wallet = getRwaWalletForSync_(sh);
    var payload = fetchJupiterPositions_(wallet, true);
    var rows = jupiterElementsToRows_(payload, wallet);
    var ts = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone() || "GMT",
      "dd.MM.yyyy HH:mm",
    );
    if (!rows.length) {
      rows = fetchRwaPositionsViaUiProxy_(wallet) || [];
    }
    if (!rows.length) {
      writeRwaSyncStatus_(sh, "0 LP · A1 не очищена · " + ts);
      return;
    }
    writeRwaPoolBattleSheet_(sh, rows);
    appendRwaDailyLog_(ss, rows);
    PropertiesService.getScriptProperties().setProperty("RWA_LAST_SYNC_MS", String(Date.now()));
    PropertiesService.getScriptProperties().setProperty("RWA_LAST_SYNC_COUNT", String(rows.length));
    PropertiesService.getScriptProperties().setProperty("RWA_WALLET", wallet);
    writeRwaSyncStatus_(sh, "OK · " + rows.length + " LP · " + ts);
  } catch (err) {
    Logger.log("RWA sync: " + err);
    try {
      var sh2 = findRwaSheet_(openRwaSourceSpreadsheet_());
      if (sh2) writeRwaSyncStatus_(sh2, "Ошибка: " + String(err.message || err).slice(0, 200));
    } catch (e2) {}
  }
}

function installRwaHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncRwaJupiterPositions") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("syncRwaJupiterPositions").timeBased().everyHours(1).create();
}

function removeRwaHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncRwaJupiterPositions") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("DeFi Navigator")
    .addItem("Проверить файл RWA (статус Z3)", "verifyRwaSpreadsheetTarget")
    .addItem("Перенести RWA в A1 (из H30)", "relayoutRwaSheetToA1")
    .addItem("Синхронизировать RWA (Jupiter)", "syncRwaJupiterPositions")
    .addItem("Диагностика Jupiter API (журнал)", "diagnoseRwaJupiterApi")
    .addItem("Авто-синх RWA каждый час", "installRwaHourlyTrigger")
    .addItem("Отключить авто-синх RWA", "removeRwaHourlyTrigger")
    .addItem("Открытие RWA: вчера 16:00 (Варшава)", "anchorAllRwaOpenYesterday16Warsaw_")
    .addItem("Запомнить Jupiter ключ из Z4", "saveJupiterApiKeyFromZ4_")
    .addToUi();
}

/** Один раз: ключ в Z4 → свойства скрипта (если уже задавали ключ в свойствах — Z4 не нужна). */
function saveJupiterApiKeyFromZ4_() {
  var sh = findRwaSheet_(openRwaSourceSpreadsheet_());
  if (!sh) throw new Error("Нет листа RWA");
  ensureRwaJupiterConfigLabels_(sh);
  var key = getRwaJupiterApiKeyFromSheet_(sh);
  if (!key) {
    throw new Error(
      "Вставьте API-ключ в ячейку Z4 на листе RWA (тот же, что на portal.jup.ag), затем снова этот пункт меню.",
    );
  }
  PropertiesService.getScriptProperties().setProperty("JUPITER_API_KEY", key);
  writeRwaSyncStatus_(sh, "Jupiter key сохранён в свойствах скрипта · " + key.length + " симв.");
  SpreadsheetApp.getActiveSpreadsheet().toast("Ключ Jupiter сохранён", "DeFi Navigator", 8);
}

/** Разовая фиксация времени открытия (~вчера 16:00 по Варшаве), если Jupiter отдаёт неверную дату. */
function anchorAllRwaOpenYesterday16Warsaw_() {
  var sh = findRwaSheet_(openRwaSourceSpreadsheet_());
  if (!sh) throw new Error("Нет листа «" + RWA_SHEET_TITLE_CANONICAL + "»");
  var last = sh.getLastRow();
  if (last < 2) throw new Error("Сначала синхронизируйте RWA или заполните таблицу");
  var links = sh.getRange(2, 13, last, 13).getDisplayValues();
  var yesterdayStr = Utilities.formatDate(
    new Date(Date.now() - 86400000),
    RWA_DISPLAY_TZ,
    "dd.MM.yyyy",
  );
  var ms = parseOpenDateWarsawToMs_(yesterdayStr + " 16:00");
  if (!ms) throw new Error("Не удалось разобрать дату " + yesterdayStr + " 16:00");
  var n = 0;
  for (var i = 0; i < links.length; i++) {
    var lk = normalizeLinkKey(links[i][0]);
    if (!lk) continue;
    persistRwaOpenMs_(lk, ms);
    n++;
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(
    "Зафиксировано открытие " + yesterdayStr + " 16:00 для " + n + " поз. → «Синхронизировать RWA»",
    "DeFi Navigator",
    10,
  );
}

function findCol(row, names) {
  var r = row || [];
  for (var n = 0; n < names.length; n++) {
    var name = names[n].toLowerCase();
    for (var i = 0; i < r.length; i++) {
      if (
        String(r[i] || "")
          .toLowerCase()
          .trim() === name
      )
        return i;
    }
  }
  return -1;
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

function normalizeFeeValue(value) {
  return String(value || "")
    .replace(",", ".")
    .replace(/%/g, "")
    .trim();
}

/** Убирает случайный суффикс «дн» в колонках мин/макс (ошибка вставки периода в цену). */
function sanitizeRangeCell_(val) {
  var s = String(val || "").trim();
  var m = s.match(/^([\d\s\u00a0.,]+)\s*дн\s*$/i);
  if (m) return m[1].trim();
  return s;
}

/** APY для API: только колонка APY. Из «18,65%» или доли 0,1865. */
function formatApyForApi_(rawVal, displayVal) {
  var disp = displayVal != null ? String(displayVal).trim() : "";
  if (disp && disp.indexOf("%") !== -1) return normalizeApyFromCell_(disp);
  if (typeof rawVal === "number" && !isNaN(rawVal)) {
    if (rawVal > 0 && rawVal <= 1.5) return String(Math.round(rawVal * 1000) / 10);
    if (rawVal > 1.5) return String(Math.round(rawVal * 10) / 10);
  }
  var s = normalizeApyFromCell_(rawVal) || normalizeApyFromCell_(disp);
  if (s) {
    var n = parseFloat(String(s).replace(",", "."));
    if (!isNaN(n) && n > 0 && n <= 1.5) return String(Math.round(n * 1000) / 10);
  }
  return s || "0";
}

/** fee_tier: из «0,30%» или доли 0,003 → 0,3 */
function formatFeeForApi_(rawVal, displayVal) {
  var disp = displayVal != null ? String(displayVal).trim() : "";
  if (disp && disp.indexOf("%") !== -1) return normalizeFeeValue(disp);
  if (typeof rawVal === "number" && !isNaN(rawVal)) {
    if (rawVal > 0 && rawVal < 0.5) return String(Math.round(rawVal * 10000) / 100);
  }
  return normalizeFeeValue(rawVal || disp);
}

function findApyColumnIndex_(headers) {
  var idx = findHeaderColumn(headers, 0, [/^(apy)$/], -1);
  if (idx >= 0) return idx;
  return findHeaderColumn(headers, 0, [/^(доходность|доход|yield)$/], -1);
}

/** Мин/макс: число из value, не display (иначе Sheets портит как «2505 дн»). */
function pickRangeValue_(r, idx, rw, displayRows) {
  if (idx < 0) return "";
  var raw = rw[idx];
  if (typeof raw === "number" && !isNaN(raw)) return formatSheetNumber_(raw, 4);
  var disp = displayRows && displayRows[r] ? displayRows[r][idx] : "";
  if (disp !== undefined && disp !== null && disp !== "")
    return sanitizeRangeCell_(String(disp).trim());
  return sanitizeRangeCell_(String(raw || "").trim());
}

function parsePoolMetaFromDesc(desc) {
  var text = String(desc || "").trim();
  if (!text) return { chain: "", fee: "" };
  var withFee = text.match(/^([A-Za-z0-9]+)\s+([\d.,]+)\s*%$/);
  if (withFee) {
    return {
      chain: withFee[1],
      fee: normalizeFeeValue(withFee[2]),
    };
  }
  if (/^[A-Za-z0-9]+$/.test(text)) return { chain: text, fee: "" };
  return { chain: "", fee: "" };
}

function enrichPoolBattleFields(name, desc, platform, chain, fee) {
  if (!platform && name) platform = String(name).trim();
  var meta = parsePoolMetaFromDesc(desc);
  if (!chain && meta.chain) chain = meta.chain;
  if (!fee && meta.fee !== "") fee = meta.fee;
  return {
    platform: platform || "",
    chain: chain || "",
    fee: fee || "",
  };
}

function normalizeLinkKey(link) {
  return String(link || "")
    .trim()
    .toLowerCase();
}

function findHeaderColumn(headers, startIdx, patterns, fallbackIdx) {
  var i;
  for (i = startIdx; i < headers.length; i++) {
    var h = headers[i];
    if (!h) continue;
    var p;
    for (p = 0; p < patterns.length; p++) {
      if (patterns[p].test(h)) return i;
    }
  }
  return fallbackIdx >= 0 ? fallbackIdx : -1;
}

/** Legacy: второй блок справа (H+) — только если лист ещё не переведён на A1. */
function buildAuxiliaryDetailIndex(rows, displayRows) {
  var index = {};
  var r;
  for (r = 0; r < rows.length; r++) {
    var headers = rowToNormalizedHeaders_(rows[r]);
    if (isUnifiedPoolBattleHeaderRow_(headers)) return {};
    var hasPlatform = false;
    var hi;
    for (hi = 7; hi < headers.length; hi++) {
      if (/^(платформа|platform|dex|protocol|протокол)$/.test(headers[hi])) hasPlatform = true;
    }
    if (!hasPlatform) continue;

    var platformCol = findHeaderColumn(
      headers,
      7,
      [/^(платформа|platform|dex|protocol|протокол)$/],
      7,
    );
    var minPriceCol = findHeaderColumn(
      headers,
      7,
      [/мин.*диапаз|min.*range|min_price|price_min/],
      8,
    );
    var maxPriceCol = findHeaderColumn(
      headers,
      7,
      [/макс.*диапаз|max.*range|max_price|price_max/],
      9,
    );
    var pairCol = findHeaderColumn(headers, 7, [/^(пара|pair)$/], 15);
    var chainCol = findHeaderColumn(headers, 7, [/^(блокчейн|chain|blockchain|network|сеть)$/], 16);
    var feeCol = findHeaderColumn(
      headers,
      7,
      [/^(fee_tier|fitier|fi tier|fee tier|fee|комиссия|tier|уровень)$/],
      17,
    );
    var aprCol = findHeaderColumn(headers, 7, [/^(apr)$/], 19);
    var apyCol = findHeaderColumn(headers, 7, [/^(apy|доходность|доход)$/], 20);
    var linkCol = findHeaderColumn(headers, 7, [/ссылка|link|url/], 20);

    function pickAux(rowVals, dispVals, idx) {
      if (idx < 0) return "";
      if (
        dispVals &&
        dispVals[idx] !== undefined &&
        dispVals[idx] !== null &&
        dispVals[idx] !== ""
      ) {
        return String(dispVals[idx]).trim();
      }
      if (rowVals[idx] !== undefined && rowVals[idx] !== null && rowVals[idx] !== "") {
        return String(rowVals[idx]).trim();
      }
      return "";
    }

    for (var rr = r + 1; rr < rows.length; rr++) {
      var rw = rows[rr] || [];
      var disp = displayRows ? displayRows[rr] || [] : rw;
      var platform = pickAux(rw, disp, platformCol);
      if (!platform) continue;
      var link = pickAux(rw, disp, linkCol);
      if (!link) continue;
      index[normalizeLinkKey(link)] = {
        platform: platform,
        priceMin: pickAux(rw, disp, minPriceCol),
        priceMax: pickAux(rw, disp, maxPriceCol),
        pair: pickAux(rw, disp, pairCol),
        chain: pickAux(rw, disp, chainCol),
        fee: pickAux(rw, disp, feeCol),
        apr: pickAux(rw, disp, aprCol),
        apy: pickAux(rw, disp, apyCol),
      };
    }
    break;
  }
  return index;
}

function mapUnifiedToolColumns_(headers) {
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
    aprCol: findHeaderColumn(headers, 0, [/^(apr)$/], -1),
    apyCol: findHeaderColumn(headers, 0, [/^(apy)$/], -1),
    linkCol: findHeaderColumn(headers, 0, [/ссылка|link|url/], -1),
    periodCol: findHeaderColumn(headers, 0, [/^(period|период|term|срок)$/], -1),
    statusCol: findHeaderColumn(headers, 0, [/^(status|статус)$/], -1),
    descCol: findHeaderColumn(headers, 0, [/^(description|desc|описание)$/], -1),
    nameCol: findHeaderColumn(headers, 0, [/^(name|название|instrument|инструмент)$/], -1),
  };
}

function findPriceColumnIndex(headers, kind) {
  var minPatterns = [
    /^(min_price|price_min|min range|range_min|price_min_usd|min price|price lower|price_low|lower price|range low)$/,
    /^(мин|минимум|мин диапазон|диапазон мин|нижняя граница)$/,
    /min/,
    /lower/,
    /нижн/,
    /мин/,
  ];
  var maxPatterns = [
    /^(max_price|price_max|max range|range_max|price_max_usd|max price|price upper|price_high|upper price|range high)$/,
    /^(макс|максимум|макс диапазон|диапазон макс|верхняя граница)$/,
    /max/,
    /upper/,
    /верхн/,
    /макс/,
  ];
  var patterns = kind === "min" ? minPatterns : maxPatterns;
  var i;
  for (i = 0; i < headers.length; i++) {
    var h = headers[i];
    if (!h) continue;
    var p;
    for (p = 0; p < patterns.length; p++) {
      if (patterns[p].test(h)) return i;
    }
  }
  var letterFallback = kind === "min" ? [4, 8] : [5];
  var f;
  for (f = 0; f < letterFallback.length; f++) {
    var idx = letterFallback[f];
    var headerAt = headers[idx];
    if (!headerAt) continue;
    for (p = 0; p < patterns.length; p++) {
      if (patterns[p].test(headerAt)) return idx;
    }
  }
  return -1;
}

function detectToolHeaderRow(rows) {
  var unified = findUnifiedHeaderRowIndex_(rows);
  if (unified >= 0) return unified;
  var maxScan = Math.min(15, rows.length);
  for (var r = 0; r < maxScan; r++) {
    var headers = rowToNormalizedHeaders_(rows[r]);
    var hasName = false;
    var hasApy = false;
    var hi;
    for (hi = 0; hi < headers.length; hi++) {
      var h = headers[hi];
      if (/^(name|название|instrument|инструмент)$/.test(h)) hasName = true;
      if (/^(apy|доходность|доход|yield|rate|apr)$/.test(h)) hasApy = true;
    }
    if (hasName && hasApy) return r;
  }
  return 0;
}

function getData() {
  syncRwaJupiterPositionsIfDue_();
  var ss = openSiteSpreadsheet_();
  var sheets = ss.getSheets();
  var categories = [];
  var allTools = [];
  var toolId = 1;

  if (sheets.length === 0) return { categories: categories, tools: allTools };

  // Первый лист — категории
  var first = sheets[0];
  var firstData = first.getDataRange().getValues();
  var catHeaders = firstData[0] || [];
  var idI = findCol(catHeaders, ["id"]) >= 0 ? findCol(catHeaders, ["id"]) : 0;
  var nameI = findCol(catHeaders, ["name"]) >= 0 ? findCol(catHeaders, ["name"]) : 1;
  var iconI = findCol(catHeaders, ["icon"]) >= 0 ? findCol(catHeaders, ["icon"]) : 2;
  var descI = findCol(catHeaders, ["description"]) >= 0 ? findCol(catHeaders, ["description"]) : 3;
  var colorI = findCol(catHeaders, ["color"]) >= 0 ? findCol(catHeaders, ["color"]) : 4;

  for (var i = 1; i < firstData.length; i++) {
    var row = firstData[i];
    var id = String(row[idI] || "").trim();
    if (!id) continue;
    categories.push({
      id: id,
      name: String(row[nameI] || "").trim() || id,
      icon: String(row[iconI] || "").trim(),
      description: String(row[descI] || "").trim(),
      color: String(row[colorI] || "").trim(),
    });
  }

  var categoryIds = categories.map(function (c) {
    return c.id;
  });
  var categoryIdSet = {};
  for (var ci = 0; ci < categoryIds.length; ci++) categoryIdSet[categoryIds[ci]] = true;

  // Листы со 2-го — инструменты по категориям
  for (var s = 1; s < sheets.length; s++) {
    var sh = sheets[s];
    var title = sh.getName();
    var fromSheetName = sheetNameToCategoryId(title);
    var fromOrder = categoryIds[s - 1] || "";
    var catId = "";
    if (isRwaPoolBattleSheet_(title)) {
      catId = "rwa";
    } else if (fromSheetName && categoryIdSet[fromSheetName]) {
      catId = fromSheetName;
    } else if (fromOrder) {
      catId = fromOrder;
    } else if (fromSheetName) {
      catId = fromSheetName;
    } else {
      catId = String(s);
    }

    var dataSh = sh;

    var rows = dataSh.getDataRange().getValues();
    var displayRows = dataSh.getDataRange().getDisplayValues();
    var headerRow = detectToolHeaderRow(rows);
    var headers = (rows[headerRow] || []).map(function (h) {
      return normalizeHeaderCell(h);
    });

    function colIndex(allowedNames) {
      if (!allowedNames || allowedNames.length === 0) return -1;
      for (var i = 0; i < headers.length; i++) {
        if (allowedNames.indexOf(headers[i]) !== -1) return i;
      }
      return -1;
    }
    var unified = isUnifiedPoolBattleHeaderRow_(headers);
    var umap = unified ? mapUnifiedToolColumns_(headers) : null;

    var nameCol = unified
      ? umap.nameCol >= 0
        ? umap.nameCol
        : umap.platformCol
      : colIndex(["name", "название", "instrument", "инструмент"]);
    if (nameCol < 0) nameCol = unified ? umap.platformCol : 0;
    var apyCol = unified
      ? umap.apyCol >= 0
        ? umap.apyCol
        : findApyColumnIndex_(headers)
      : findApyColumnIndex_(headers);
    if (apyCol < 0) apyCol = colIndex(["apy", "доходность", "доход", "yield"]);
    if (apyCol < 0) apyCol = unified ? 13 : 1;
    var periodCol = unified ? umap.periodCol : colIndex(["period", "период", "term"]);
    if (periodCol < 0) periodCol = unified ? -1 : 2;
    var statusCol = unified ? umap.statusCol : colIndex(["status", "статус"]);
    if (statusCol < 0) statusCol = unified ? -1 : 3;
    var linkCol = unified ? umap.linkCol : colIndex(["link", "url", "ссылка"]);
    if (linkCol < 0) linkCol = unified ? 14 : 4;
    var descCol = unified ? umap.descCol : colIndex(["description", "desc", "описание"]);
    if (!unified && descCol < 0) {
      var di;
      for (di = 0; di < headers.length; di++) {
        var dh = headers[di];
        if (dh.indexOf("описание") !== -1) {
          descCol = di;
          break;
        }
        if (dh === "description" || dh.indexOf("description") === 0) {
          descCol = di;
          break;
        }
      }
    }
    if (descCol < 0) descCol = -1;
    var pairCol = unified ? umap.pairCol : -1;
    if (!unified) {
      var pci;
      for (pci = 0; pci < headers.length; pci++) {
        if (headers[pci] === "pair" || headers[pci] === "пара") {
          pairCol = pci;
          break;
        }
      }
    }
    var platformCol = unified
      ? umap.platformCol
      : colIndex(["platform", "платформа", "dex", "protocol", "протокол"]);
    if (platformCol < 0) platformCol = -1;
    var feeCol = unified
      ? umap.feeCol
      : colIndex([
          "fee",
          "fee tier",
          "fee_tier",
          "fitier",
          "fi tier",
          "комиссия",
          "tier",
          "уровень",
        ]);
    if (feeCol < 0) feeCol = -1;
    var chainCol = unified
      ? umap.chainCol
      : colIndex(["chain", "blockchain", "network", "сеть", "блокчейн"]);
    if (chainCol < 0) chainCol = -1;
    var typeCol = colIndex(["type", "тип", "position type", "pool type", "тип позиции"]);
    if (typeCol < 0) typeCol = -1;
    var minPriceCol = unified ? umap.minPriceCol : findPriceColumnIndex(headers, "min");
    var maxPriceCol = unified ? umap.maxPriceCol : findPriceColumnIndex(headers, "max");
    var openDateCol = unified ? umap.openDateCol : -1;
    var detailIndex = unified ? {} : buildAuxiliaryDetailIndex(rows, displayRows);

    function pick(row, idx, def) {
      def = def || "";
      if (idx >= 0 && row[idx] !== undefined && row[idx] !== null && row[idx] !== "")
        return String(row[idx]).trim();
      return def;
    }

    function pickDisplay(r, idx, rowVals) {
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
    }

    for (var r = headerRow + 1; r < rows.length; r++) {
      var rw = rows[r];
      var name = pickDisplay(r, nameCol, rw) || pick(rw, nameCol);
      if (!name && unified && platformCol >= 0)
        name = pickDisplay(r, platformCol, rw) || pick(rw, platformCol);
      if (!name) continue;
      var apyDisp = apyCol >= 0 && displayRows[r] ? displayRows[r][apyCol] : "";
      var apyRaw = apyCol >= 0 ? rw[apyCol] : "";
      var apy =
        unified || apyCol >= 0
          ? formatApyForApi_(apyRaw, apyDisp)
          : normalizeApyFromCell_(pickDisplay(r, apyCol, rw) || pick(rw, apyCol)) || "0";
      var period = "";
      if (periodCol >= 0 && !unified) {
        period =
          displayRows[r] &&
          displayRows[r][periodCol] !== undefined &&
          displayRows[r][periodCol] !== ""
            ? String(displayRows[r][periodCol]).trim()
            : pick(rw, periodCol);
      }
      if ((!period || unified) && openDateCol >= 0) {
        var openRaw = openDateCol >= 0 ? rw[openDateCol] : "";
        var openDisp = pickDisplay(r, openDateCol, rw) || pick(rw, openDateCol);
        period = periodFromOpenDateCell_(openRaw, openDisp);
      }
      if (!period) period = "7d";
      var status = statusCol >= 0 ? (pick(rw, statusCol) || "active").toLowerCase() : "active";
      if (status !== "warning" && status !== "внимание") status = "active";
      else status = "warning";
      var link = pickDisplay(r, linkCol, rw) || pick(rw, linkCol) || "#";
      var desc = descCol >= 0 ? pick(rw, descCol) : "";
      var pair = pairCol >= 0 ? pickDisplay(r, pairCol, rw) || pick(rw, pairCol, "") : "";
      var platform =
        platformCol >= 0 ? pickDisplay(r, platformCol, rw) || pick(rw, platformCol) : "";
      if (!platform) platform = name;
      if (shouldSkipToolRow_(catId, pair, name, platform)) continue;
      var feeDisp = feeCol >= 0 && displayRows[r] ? displayRows[r][feeCol] : "";
      var feeRaw = feeCol >= 0 ? rw[feeCol] : "";
      var fee =
        unified || feeCol >= 0
          ? formatFeeForApi_(feeRaw, feeDisp)
          : feeCol >= 0
            ? pick(rw, feeCol)
            : "";
      var chain = chainCol >= 0 ? pickDisplay(r, chainCol, rw) || pick(rw, chainCol) : "";
      var type = typeCol >= 0 ? pick(rw, typeCol) : "";
      var priceMin = unified
        ? pickRangeValue_(r, minPriceCol, rw, displayRows)
        : minPriceCol >= 0
          ? pickDisplay(r, minPriceCol, rw) || pick(rw, minPriceCol)
          : "";
      var priceMax = unified
        ? pickRangeValue_(r, maxPriceCol, rw, displayRows)
        : maxPriceCol >= 0
          ? pickDisplay(r, maxPriceCol, rw) || pick(rw, maxPriceCol)
          : "";
      if (!desc && (chain || fee)) desc = buildSolanaDesc_(chain, fee);
      var enriched = enrichPoolBattleFields(name, desc, platform, chain, fee);
      platform = enriched.platform;
      chain = enriched.chain;
      fee = enriched.fee;
      if (!unified) {
        var detail = detailIndex[normalizeLinkKey(link)];
        if (detail) {
          if (detail.platform) platform = detail.platform;
          if (detail.pair) pair = detail.pair;
          if (detail.chain) chain = detail.chain;
          if (detail.fee) fee = detail.fee;
          if (catId !== "rwa") {
            if (detail.priceMin) priceMin = detail.priceMin;
            if (detail.priceMax) priceMax = detail.priceMax;
          }
          if (detail.apy) {
            var detailApy = normalizeApyFromCell_(detail.apy).replace(/\s/g, "").replace(",", ".");
            var primaryApy = normalizeApyFromCell_(apy).replace(/\s/g, "").replace(",", ".");
            if (!primaryApy || primaryApy === "0" || primaryApy === "0.0") apy = detailApy;
          }
        }
      }
      if (catId === "rwa") {
        priceMin = RWA_RANGE_MIN_LABEL;
        priceMax = RWA_RANGE_MAX_LABEL;
      }

      allTools.push({
        id: toolId++,
        categoryId: catId,
        name: name,
        pair: pair,
        platform: platform,
        fee: fee,
        chain: chain,
        type: type,
        priceMin: priceMin,
        priceMax: priceMax,
        apy: apy,
        period: period,
        openDate: openDateCol >= 0 ? pickDisplay(r, openDateCol, rw) || pick(rw, openDateCol) : "",
        status: status,
        link: link,
        desc: desc,
        descEn: desc,
      });
    }
  }

  return { categories: categories, tools: allTools, apiVersion: 4, source: "apps-script" };
}

function doGet(e) {
  var callback = e && e.parameter && e.parameter.callback;
  var data;
  try {
    data = getData();
  } catch (err) {
    data = { categories: [], tools: [], error: String(err.message || err) };
  }
  var out;

  if (callback) {
    var jsonStr = JSON.stringify(data);
    var safeCallback = String(callback).replace(/[^a-zA-Z0-9_.]/g, "");
    out = ContentService.createTextOutput(safeCallback + "(" + jsonStr + ")").setMimeType(
      ContentService.MimeType.JAVASCRIPT,
    );
  } else {
    out = ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
      ContentService.MimeType.JSON,
    );
  }

  return out;
}
