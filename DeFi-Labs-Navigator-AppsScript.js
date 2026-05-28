/**
 * DeFi Labs Navigator — скрипт для Google Apps Script
 * Читает данные из таблицы и отдаёт их в формате JSON (для сайта на GitHub Pages).
 *
 * КАК ПОДКЛЮЧИТЬ:
 * 1. Открой https://script.google.com
 * 2. Новый проект → удали весь код в редакторе и вставь сюда ВЕСЬ этот файл.
 * 3. Сохрани (Ctrl+S). SPREADSHEET_ID — сайт; RWA_POOL_BATTLE_SPREADSHEET_ID — битва пуллов (B6).
 * 4. Меню «Развёртывание» → «Новое развёртывание» → тип «Веб-приложение».
 * 5. Описание: например «DeFi Navigator API». Выполнять от имени: «Я». Доступ: «Все».
 * 6. Нажми «Развернуть», скопируй URL (он вида …/exec).
 * 7. В HTML-файле сайта вставь этот URL в переменную DATA_API_URL (см. README).
 */

/** Базовая таблица — отсюда сайт читает JSON (getData). */
var SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
/** Вторая таблица (битва пуллов / Bitcoin) — сюда Jupiter пишет RWA, кошелёк в B6. */
var RWA_POOL_BATTLE_SPREADSHEET_ID = '1NjN5ELRjNVlFSVfJLCQsho32Kod5HRA4JWakZ7KVsJY';

function sheetNameToCategoryId(name) {
  if (!name || typeof name !== 'string') return '';
  var raw = String(name).trim();
  if (/\brwa\b/i.test(raw) || /real\s*world/i.test(raw)) return 'rwa';
  return raw.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** Лист RWA: ссылка на портфель Jupiter или адрес кошелька (по умолчанию B6). */
var RWA_WALLET_CELL_A1 = 'B6';
var RWA_SYNC_MIN_INTERVAL_MS = 50 * 60 * 1000;
var JUPITER_PORTFOLIO_API_BASE = 'https://api.jup.ag/portfolio/v1';

function getJupiterApiKey_() {
  return String(PropertiesService.getScriptProperties().getProperty('JUPITER_API_KEY') || '').trim();
}

function parseSolanaWalletFromCell_(value) {
  var s = String(value || '').trim();
  if (!s) return '';
  var m = s.match(/portfolio\/([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (m) return m[1];
  m = s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? m[1] : '';
}

/** Кошелёк только из B6 (вторая таблица, лист RWA). */
function getRwaWalletFromSheet_(sh) {
  var w = parseSolanaWalletFromCell_(sh.getRange(RWA_WALLET_CELL_A1).getDisplayValue());
  if (!w) w = parseSolanaWalletFromCell_(sh.getRange(RWA_WALLET_CELL_A1).getValue());
  if (w) return w;
  var saved = String(PropertiesService.getScriptProperties().getProperty('RWA_WALLET') || '').trim();
  if (saved && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(saved)) return saved;
  return '';
}

function openRwaSourceSpreadsheet_() {
  return SpreadsheetApp.openById(RWA_POOL_BATTLE_SPREADSHEET_ID);
}

function openSiteSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function rwaSheetHasDataRows_(sh) {
  var data = sh.getDataRange().getValues();
  var hr = getRwaToolHeaderRowIndex_(data);
  var r;
  for (r = hr + 1; r < data.length; r++) {
    if (String(data[r][0] || '').trim()) return true;
  }
  return false;
}

function writeRwaSyncStatus_(sh, message) {
  try {
    sh.getRange('D2').setValue(String(message || '').slice(0, 240));
  } catch (e) {}
}

/** Истинное имя листа в таблице (регистр не важен; «пулов» и «пуллов» — оба варианта). */
var RWA_SHEET_TITLE_CANONICAL = 'БИТВА ПУЛОВ RWA';

function normalizeRwaSheetTitle_(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ё/g, 'е');
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

/** Формат «Битва пуллов» (как ethereum/bitcoin): шапка A–G, блок деталей с кол. H. */
var RWA_POOL_BATTLE_HEADER_ROW_1BASED = 7;
var RWA_POOL_BATTLE_CONFIG_LAST_ROW = 6;
var RWA_POOL_BATTLE_AUX_HEADERS = [
  '', '', '', '', '', '', '',
  'Платформа', 'Мин диапазона', 'Макс диапазон', 'Дата открытия норм',
  'Заработано стейблов', 'Заработано актива', 'Символ актива', 'Заработано AERO',
  'Итого комс доход', 'валютка', 'Блокчейн', 'fee_tier', 'APR', 'APY', 'ссылка', 'Инвестировано'
];
var RWA_DAILY_LOG_SHEET = 'RWA_DAILY_LOG';

function getRwaToolHeaderRowIndex_(data) {
  var scanFrom = Math.max(0, RWA_POOL_BATTLE_HEADER_ROW_1BASED - 2);
  for (var r = scanFrom; r < Math.min(data.length, 12); r++) {
    var line = data[r] || [];
    var headers = [];
    for (var c = 0; c < line.length; c++) headers.push(normalizeHeaderCell(line[c]));
    var hasName = false;
    var hasApy = false;
    for (var hi = 0; hi < headers.length; hi++) {
      if (/^(name|название|instrument|инструмент)$/.test(headers[hi])) hasName = true;
      if (/^(apy|доходность|доход|yield|rate|apr)$/.test(headers[hi])) hasApy = true;
    }
    if (hasName && hasApy) return r;
  }
  return RWA_POOL_BATTLE_HEADER_ROW_1BASED - 1;
}

function buildSolanaDesc_(chain, fee) {
  var c = String(chain || 'solana').trim() || 'solana';
  var f = String(fee || '').trim();
  return f ? (c + ' ' + f) : c;
}

function formatPlatformDisplay_(platformId, fallbackName) {
  var pid = String(platformId || '').toLowerCase();
  if (pid.indexOf('raydium') !== -1) return 'Raydium';
  if (pid.indexOf('orca') !== -1) return 'Orca';
  if (pid.indexOf('meteora') !== -1) return 'Meteora';
  if (pid.indexOf('kamino') !== -1) return 'Kamino';
  if (fallbackName) return String(fallbackName).trim();
  if (!pid) return 'Solana';
  return pid.charAt(0).toUpperCase() + pid.slice(1);
}

function isNavigatorLiquidityElement_(el) {
  if (!el) return false;
  if (String(el.networkId || '') !== 'solana') return false;
  var type = String(el.type || '');
  var label = String(el.label || '');
  var pid = String(el.platformId || '').toLowerCase();

  if (type === 'borrowlend') return false;
  if (label === 'Lending') return false;
  if (pid.indexOf('kamino') !== -1 && (type === 'borrowlend' || label === 'Lending')) return false;
  if (type === 'liquidity') return true;
  if (label === 'LiquidityPool') return true;
  if (type === 'multiple' && label === 'LiquidityPool') return true;
  if (pid.indexOf('raydium') !== -1 || pid.indexOf('orca') !== -1 || pid.indexOf('meteora') !== -1) {
    if (label === 'LiquidityPool' || type === 'liquidity') return true;
  }
  return false;
}

function extractFeePercent_(text) {
  var s = String(text || '');
  var m = s.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return '';
  return String(m[1]).replace(',', '.');
}

function apyPercentFromElement_(el, liq) {
  var frac = null;
  if (el && el.netApy != null && !isNaN(Number(el.netApy))) frac = Number(el.netApy);
  if (frac == null && liq && liq.yields && liq.yields.length) {
    var y0 = liq.yields[0];
    if (y0 && y0.apy != null && !isNaN(Number(y0.apy))) frac = Number(y0.apy);
    else if (y0 && y0.apr != null && !isNaN(Number(y0.apr))) frac = Number(y0.apr);
  }
  if (frac == null) return '0';
  var pct = frac <= 1 && frac >= -1 ? frac * 100 : frac;
  return String(Math.round(pct * 10) / 10);
}

function tokenSymbolFromAsset_(asset, tokenInfo) {
  if (!asset || asset.type !== 'token' || !asset.data) return '';
  var addr = asset.data.address;
  if (tokenInfo && tokenInfo.solana && addr && tokenInfo.solana[addr]) {
    return String(tokenInfo.solana[addr].symbol || '').trim();
  }
  if (asset.data.symbol) return String(asset.data.symbol).trim();
  return addr ? String(addr).slice(0, 6) : '';
}

function pairFromLiquidityAssets_(liq, tokenInfo) {
  var assets = (liq && liq.assets) ? liq.assets : [];
  var syms = [];
  for (var i = 0; i < assets.length; i++) {
    var sym = tokenSymbolFromAsset_(assets[i], tokenInfo);
    if (sym) syms.push(sym);
  }
  return syms.length ? syms.join(' / ') : '';
}

function isStableSymbol_(sym) {
  return /^(USDC|USDT|USD1|PYUSD|USDS|DAI|CASH|USDC\.e|UXD)$/i.test(String(sym || '').trim());
}

function tokenValueUsd_(asset) {
  if (!asset) return 0;
  if (asset.value != null && !isNaN(Number(asset.value))) return Number(asset.value);
  if (asset.type === 'token' && asset.data) {
    var amt = Number(asset.data.amount) || 0;
    var pr = Number(asset.data.price) || 0;
    return amt * pr;
  }
  return 0;
}

function splitRewardAssets_(liq, tokenInfo) {
  var stableUsd = 0;
  var assetAmt = 0;
  var assetSym = '';
  var assetUsd = 0;
  var rewards = (liq && liq.rewardAssets) ? liq.rewardAssets : [];
  var i;
  for (i = 0; i < rewards.length; i++) {
    var sym = tokenSymbolFromAsset_(rewards[i], tokenInfo);
    var val = tokenValueUsd_(rewards[i]);
    var amt = (rewards[i] && rewards[i].data && rewards[i].data.amount != null)
      ? Number(rewards[i].data.amount) : 0;
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
    totalUsd: stableUsd + assetUsd
  };
}

function parseRangeFromPoolName_(text) {
  var s = String(text || '');
  var m = s.match(/(\d[\d\s.,]*)\s*[-–—]\s*(\d[\d\s.,]*)/);
  if (!m) return { min: '', max: '' };
  return {
    min: String(m[1]).replace(/\s/g, '').replace(',', '.'),
    max: String(m[2]).replace(/\s/g, '').replace(',', '.')
  };
}

function formatSheetNumber_(n, decimals) {
  if (n == null || isNaN(Number(n))) return '';
  var d = decimals == null ? 6 : decimals;
  return String(Math.round(Number(n) * Math.pow(10, d)) / Math.pow(10, d));
}

function periodFromTimestampMs_(ms) {
  if (!ms || isNaN(Number(ms))) return '0 дн';
  var days = Math.max(0, Math.floor((Date.now() - Number(ms)) / 86400000));
  return days + ' дн';
}

function periodFromOpenDateString_(dateStr) {
  var s = String(dateStr || '').trim();
  var m = s.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);
  if (!m) return '0 дн';
  var y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  var opened = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  if (isNaN(opened.getTime())) return '0 дн';
  return Math.max(0, Math.floor((Date.now() - opened.getTime()) / 86400000)) + ' дн';
}

function openDateFromElement_(el, liq) {
  var ms = null;
  if (el && el.updatedAt) ms = Number(el.updatedAt);
  if (!ms && el && el.data && el.data.createdAt) ms = Number(el.data.createdAt);
  if (!ms && liq && liq.createdAt) ms = Number(liq.createdAt);
  if (!ms || isNaN(ms)) {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'dd.MM.yyyy');
  }
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone() || 'GMT', 'dd.MM.yyyy');
}

function mapLiquidityToRow_(el, liq, tokenInfo, wallet) {
  var platform = formatPlatformDisplay_(el.platformId, el.name);
  var poolName = (liq && liq.name) ? String(liq.name).trim() : '';
  var pair = pairFromLiquidityAssets_(liq, tokenInfo);
  if (!pair && poolName && poolName.indexOf('/') !== -1) pair = poolName;
  var link = (liq && liq.link) ? String(liq.link).trim() : '';
  if (!link && el.data && el.data.link) link = String(el.data.link).trim();
  if (!link && wallet) link = 'https://jup.ag/portfolio/' + wallet;
  var fee = extractFeePercent_(poolName) || extractFeePercent_(el.name) || '';
  var chain = 'solana';
  var range = parseRangeFromPoolName_(poolName);
  var rewards = splitRewardAssets_(liq, tokenInfo);
  var invested = (liq && liq.value != null) ? Number(liq.value) : ((liq && liq.assetsValue != null) ? Number(liq.assetsValue) : 0);
  if (isNaN(invested)) invested = 0;
  var openDate = openDateFromElement_(el, liq);
  var period = periodFromOpenDateString_(openDate);
  if (period === '0 дн' && el && el.updatedAt) period = periodFromTimestampMs_(el.updatedAt);
  var apy = apyPercentFromElement_(el, liq);
  return {
    name: platform,
    apy: apy,
    period: period,
    status: 'active',
    link: link || '#',
    desc: buildSolanaDesc_(chain, fee),
    pair: pair,
    platform: platform,
    fee: fee,
    chain: chain,
    type: 'Liquidity Pool',
    priceMin: range.min,
    priceMax: range.max,
    openDate: openDate,
    earnedStables: rewards.stableUsd,
    earnedAsset: rewards.assetAmount,
    earnedAssetSymbol: rewards.assetSymbol,
    totalFeeIncome: rewards.totalUsd,
    investedUsd: invested
  };
}

function jupiterElementsToRows_(payload, wallet) {
  var elements = (payload && payload.elements) ? payload.elements : [];
  var tokenInfo = (payload && payload.tokenInfo) ? payload.tokenInfo : {};
  var rows = [];
  var seen = {};
  for (var e = 0; e < elements.length; e++) {
    var el = elements[e];
    if (!isNavigatorLiquidityElement_(el)) continue;
    var chunk = [];
    if (el.type === 'liquidity' && el.data && el.data.liquidities && el.data.liquidities.length) {
      for (var l = 0; l < el.data.liquidities.length; l++) {
        chunk.push(mapLiquidityToRow_(el, el.data.liquidities[l], tokenInfo, wallet));
      }
    } else {
      chunk.push(mapLiquidityToRow_(el, null, tokenInfo, wallet));
    }
    for (var c = 0; c < chunk.length; c++) {
      var row = chunk[c];
      var key = normalizeLinkKey(row.link) + '|' + String(row.name).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      rows.push(row);
    }
  }
  rows.sort(function(a, b) {
    return parseFloat(b.apy) - parseFloat(a.apy);
  });
  return rows;
}

function fetchJupiterPositions_(wallet) {
  var apiKey = getJupiterApiKey_();
  var url = JUPITER_PORTFOLIO_API_BASE + '/positions/' + encodeURIComponent(wallet);
  var headers = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  Utilities.sleep(2200);
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: headers
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code === 401 && !apiKey) {
    throw new Error('Jupiter API 401: добавьте бесплатный ключ (план Free $0) в Script properties → JUPITER_API_KEY с portal.jup.ag');
  }
  if (code < 200 || code >= 300) {
    throw new Error('Jupiter API HTTP ' + code + ': ' + text.slice(0, 280));
  }
  var payload = JSON.parse(text);
  var n = (payload.elements && payload.elements.length) ? payload.elements.length : 0;
  if (!n && !apiKey) {
    throw new Error('Jupiter вернул 0 позиций. Добавьте JUPITER_API_KEY (бесплатно на portal.jup.ag) и проверьте кошелёк в B6.');
  }
  return payload;
}

function writeRwaPoolBattleSheet_(sh, rows) {
  var headerRow = RWA_POOL_BATTLE_HEADER_ROW_1BASED;
  var dataStart = headerRow + 1;
  var stdHeaders = ['name', 'apy', 'period', 'status', 'link', 'description', 'pair'];
  sh.getRange(headerRow, 1, headerRow, stdHeaders.length).setValues([stdHeaders]);

  var lastRow = Math.max(sh.getLastRow(), dataStart);
  if (lastRow >= dataStart) {
    sh.getRange(dataStart, 1, lastRow, RWA_POOL_BATTLE_AUX_HEADERS.length).clearContent();
  }

  if (!rows.length) return 0;

  var primary = rows.map(function(row) {
    var feeLabel = row.fee ? (String(row.fee).indexOf('%') !== -1 ? row.fee : row.fee + '%') : '';
    return [
      row.name,
      row.apy,
      row.period,
      row.status,
      row.link,
      buildSolanaDesc_(row.chain, feeLabel),
      row.pair
    ];
  });
  sh.getRange(dataStart, 1, dataStart + primary.length - 1, 7).setValues(primary);

  var auxHeaderRow = Math.max(dataStart + primary.length + 2, 11);
  sh.getRange(auxHeaderRow, 1, auxHeaderRow, RWA_POOL_BATTLE_AUX_HEADERS.length)
    .setValues([RWA_POOL_BATTLE_AUX_HEADERS]);

  var auxDataStart = auxHeaderRow + 1;
  var aux = rows.map(function(row) {
    var feeLabel = row.fee ? (String(row.fee).indexOf('%') !== -1 ? row.fee : row.fee + '%') : '';
    var line = new Array(RWA_POOL_BATTLE_AUX_HEADERS.length);
    for (var i = 0; i < line.length; i++) line[i] = '';
    line[7] = row.platform;
    line[8] = row.priceMin || '';
    line[9] = row.priceMax || '';
    line[10] = row.openDate || '';
    line[11] = formatSheetNumber_(row.earnedStables, 6);
    line[12] = formatSheetNumber_(row.earnedAsset, 8);
    line[13] = row.earnedAssetSymbol || '';
    line[14] = '';
    line[15] = formatSheetNumber_(row.totalFeeIncome, 4);
    line[16] = row.pair;
    line[17] = row.chain || 'solana';
    line[18] = feeLabel;
    line[19] = row.apy;
    line[20] = row.apy;
    line[21] = row.link;
    line[22] = formatSheetNumber_(row.investedUsd, 2);
    return line;
  });
  sh.getRange(auxDataStart, 1, auxDataStart + aux.length - 1, RWA_POOL_BATTLE_AUX_HEADERS.length)
    .setValues(aux);
  return rows.length;
}

function ensureRwaDailyLogSheet_(ss) {
  var sh = ss.getSheetByName(RWA_DAILY_LOG_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(RWA_DAILY_LOG_SHEET);
  sh.getRange(1, 1, 1, 10).setValues([[
    'Дата', 'Платформа', 'Пара', 'Ссылка', 'Заработано стейблов USD',
    'Заработано актива', 'Символ', 'Итого комс USD', 'Инвестировано USD', 'APY'
  ]]);
  return sh;
}

function appendRwaDailyLog_(ss, rows) {
  if (!rows || !rows.length) return;
  var logSh = ensureRwaDailyLogSheet_(ss);
  var day = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'dd.MM.yyyy');
  var out = rows.map(function(row) {
    return [
      day,
      row.platform,
      row.pair,
      row.link,
      row.earnedStables,
      row.earnedAsset,
      row.earnedAssetSymbol,
      row.totalFeeIncome,
      row.investedUsd,
      row.apy
    ];
  });
  var start = logSh.getLastRow() + 1;
  logSh.getRange(start, 1, start + out.length - 1, 10).setValues(out);
}

function copyRwaDataToSiteSpreadsheet_(sourceSh) {
  var destSs = openSiteSpreadsheet_();
  var destSh = findRwaSheet_(destSs);
  if (!destSh) {
    destSh = destSs.getSheetByName(RWA_SHEET_TITLE_CANONICAL);
  }
  if (!destSh) throw new Error('На сайтовой таблице нет листа «' + RWA_SHEET_TITLE_CANONICAL + '»');

  var startRow = RWA_POOL_BATTLE_HEADER_ROW_1BASED;
  var last = Math.max(sourceSh.getLastRow(), startRow + 5);
  var cols = RWA_POOL_BATTLE_AUX_HEADERS.length;
  var block = sourceSh.getRange(startRow, 1, last, cols).getValues();

  destSh.getRange(1, 1, Math.max(destSh.getLastRow(), block.length + 5), cols).clearContent();
  destSh.getRange(1, 1, block.length, cols).setValues(block);
}

/**
 * Синхронизация листа RWA: Jupiter Portfolio → строки инструментов (только liquidity pool).
 * Кошелёк / ссылка jup.ag/portfolio/… — ячейка B6 на листе RWA.
 */
function syncRwaJupiterPositions() {
  var ss = openRwaSourceSpreadsheet_();
  var sh = findRwaSheet_(ss);
  if (!sh) throw new Error('На таблице битвы пуллов нет листа «БИТВА ПУЛОВ RWA»');

  var wallet = getRwaWalletFromSheet_(sh);
  if (!wallet) {
    throw new Error('Укажите кошелёк в B6: ссылка jup.ag/portfolio/… или Solana-адрес');
  }

  var payload = fetchJupiterPositions_(wallet);
  var rows = jupiterElementsToRows_(payload, wallet);
  writeRwaPoolBattleSheet_(sh, rows);
  appendRwaDailyLog_(ss, rows);
  copyRwaDataToSiteSpreadsheet_(sh);

  PropertiesService.getScriptProperties().setProperty('RWA_LAST_SYNC_MS', String(Date.now()));
  PropertiesService.getScriptProperties().setProperty('RWA_LAST_SYNC_COUNT', String(rows.length));
  PropertiesService.getScriptProperties().setProperty('RWA_WALLET', wallet);
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'dd.MM.yyyy HH:mm');
  writeRwaSyncStatus_(sh, rows.length ? ('OK · ' + rows.length + ' поз. → сайт · ' + ts) : ('0 поз. · ключ API / кошелёк · ' + ts));
  return { wallet: wallet, count: rows.length, syncedAt: new Date().toISOString() };
}

function syncRwaJupiterPositionsIfDue_() {
  try {
    var ss = openRwaSourceSpreadsheet_();
    var sh = findRwaSheet_(ss);
    if (!sh || !getRwaWalletFromSheet_(sh)) return;
    var last = Number(PropertiesService.getScriptProperties().getProperty('RWA_LAST_SYNC_MS') || '0');
    var siteSh = findRwaSheet_(openSiteSpreadsheet_());
    var forceEmpty = !siteSh || !rwaSheetHasDataRows_(siteSh);
    if (!forceEmpty && Date.now() - last < RWA_SYNC_MIN_INTERVAL_MS) return;
    syncRwaJupiterPositions();
  } catch (err) {
    Logger.log('RWA sync: ' + err);
    try {
      var sh2 = findRwaSheet_(openRwaSourceSpreadsheet_());
      if (sh2) writeRwaSyncStatus_(sh2, 'Ошибка: ' + String(err.message || err).slice(0, 200));
    } catch (e2) {}
  }
}

function installRwaHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncRwaJupiterPositions') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('syncRwaJupiterPositions').timeBased().everyHours(1).create();
}

function removeRwaHourlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncRwaJupiterPositions') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DeFi Navigator')
    .addItem('Синхронизировать RWA (Jupiter)', 'syncRwaJupiterPositions')
    .addItem('Авто-синх RWA каждый час', 'installRwaHourlyTrigger')
    .addItem('Отключить авто-синх RWA', 'removeRwaHourlyTrigger')
    .addToUi();
}

function findCol(row, names) {
  var r = row || [];
  for (var n = 0; n < names.length; n++) {
    var name = names[n].toLowerCase();
    for (var i = 0; i < r.length; i++) {
      if (String(r[i] || '').toLowerCase().trim() === name) return i;
    }
  }
  return -1;
}

function normalizeHeaderCell(h) {
  return String(h || '')
    .replace(/^\uFEFF/, '')
    .replace(/\u200b/g, '')
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeFeeValue(value) {
  return String(value || '').replace(',', '.').replace(/%/g, '').trim();
}

function parsePoolMetaFromDesc(desc) {
  var text = String(desc || '').trim();
  if (!text) return { chain: '', fee: '' };
  var withFee = text.match(/^([A-Za-z0-9]+)\s+([\d.,]+)\s*%$/);
  if (withFee) {
    return {
      chain: withFee[1],
      fee: normalizeFeeValue(withFee[2])
    };
  }
  if (/^[A-Za-z0-9]+$/.test(text)) return { chain: text, fee: '' };
  return { chain: '', fee: '' };
}

function enrichPoolBattleFields(name, desc, platform, chain, fee) {
  if (!platform && name) platform = String(name).trim();
  var meta = parsePoolMetaFromDesc(desc);
  if (!chain && meta.chain) chain = meta.chain;
  if (!fee && meta.fee !== '') fee = meta.fee;
  return {
    platform: platform || '',
    chain: chain || '',
    fee: fee || ''
  };
}

function normalizeLinkKey(link) {
  return String(link || '').trim().toLowerCase();
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

function buildAuxiliaryDetailIndex(rows, displayRows) {
  var index = {};
  var r;
  for (r = 0; r < rows.length; r++) {
    var rawHeaders = rows[r] || [];
    var headers = [];
    var hi;
    for (hi = 0; hi < rawHeaders.length; hi++) headers.push(normalizeHeaderCell(rawHeaders[hi]));
    var hasPlatform = false;
    var hasMinRange = false;
    for (hi = 7; hi < headers.length; hi++) {
      if (/^(платформа|platform|dex|protocol|протокол)$/.test(headers[hi])) hasPlatform = true;
      if (/мин.*диапаз|min.*range|min_price|price_min/.test(headers[hi])) hasMinRange = true;
    }
    if (!hasPlatform || !hasMinRange) continue;

    var platformCol = findHeaderColumn(headers, 7, [/^(платформа|platform|dex|protocol|протокол)$/], 7);
    var minPriceCol = findHeaderColumn(headers, 7, [/мин.*диапаз|min.*range|min_price|price_min/], 8);
    var maxPriceCol = findHeaderColumn(headers, 7, [/макс.*диапаз|max.*range|max_price|price_max/], 9);
    var pairCol = findHeaderColumn(headers, 7, [/^(пара|pair)$/], 15);
    var chainCol = findHeaderColumn(headers, 7, [/^(блокчейн|chain|blockchain|network|сеть)$/], 16);
    var feeCol = findHeaderColumn(headers, 7, [/^(fee_tier|fitier|fi tier|fee tier|fee|комиссия|tier|уровень)$/], 17);
    var apyCol = findHeaderColumn(headers, 7, [/^(apy|доходность|доход)$/], 19);
    var linkCol = findHeaderColumn(headers, 7, [/ссылка|link|url/], 20);

  function pickAux(rowVals, dispVals, idx) {
      if (idx < 0) return '';
      if (dispVals && dispVals[idx] !== undefined && dispVals[idx] !== null && dispVals[idx] !== '') {
        return String(dispVals[idx]).trim();
      }
      if (rowVals[idx] !== undefined && rowVals[idx] !== null && rowVals[idx] !== '') {
        return String(rowVals[idx]).trim();
      }
      return '';
    }

    for (var rr = r + 1; rr < rows.length; rr++) {
      var rw = rows[rr] || [];
      var disp = displayRows ? (displayRows[rr] || []) : rw;
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
        apy: pickAux(rw, disp, apyCol)
      };
    }
    break;
  }
  return index;
}

function findPriceColumnIndex(headers, kind) {
  var minPatterns = [
    /^(min_price|price_min|min range|range_min|price_min_usd|min price|price lower|price_low|lower price|range low)$/,
    /^(мин|минимум|мин диапазон|диапазон мин|нижняя граница)$/,
    /min/,
    /lower/,
    /нижн/,
    /мин/
  ];
  var maxPatterns = [
    /^(max_price|price_max|max range|range_max|price_max_usd|max price|price upper|price_high|upper price|range high)$/,
    /^(макс|максимум|макс диапазон|диапазон макс|верхняя граница)$/,
    /max/,
    /upper/,
    /верхн/,
    /макс/
  ];
  var patterns = kind === 'min' ? minPatterns : maxPatterns;
  var i;
  for (i = 0; i < headers.length; i++) {
    var h = headers[i];
    if (!h) continue;
    var p;
    for (p = 0; p < patterns.length; p++) {
      if (patterns[p].test(h)) return i;
    }
  }
  var letterFallback = kind === 'min' ? [4, 8] : [5];
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
  var maxScan = Math.min(10, rows.length);
  for (var r = 0; r < maxScan; r++) {
    var line = rows[r] || [];
    var headers = [];
    var c;
    for (c = 0; c < line.length; c++) {
      headers.push(normalizeHeaderCell(line[c]));
    }
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
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheets = ss.getSheets();
  var categories = [];
  var allTools = [];
  var toolId = 1;

  if (sheets.length === 0) return { categories: categories, tools: allTools };

  // Первый лист — категории
  var first = sheets[0];
  var firstData = first.getDataRange().getValues();
  var catHeaders = firstData[0] || [];
  var idI = findCol(catHeaders, ['id']) >= 0 ? findCol(catHeaders, ['id']) : 0;
  var nameI = findCol(catHeaders, ['name']) >= 0 ? findCol(catHeaders, ['name']) : 1;
  var iconI = findCol(catHeaders, ['icon']) >= 0 ? findCol(catHeaders, ['icon']) : 2;
  var descI = findCol(catHeaders, ['description']) >= 0 ? findCol(catHeaders, ['description']) : 3;
  var colorI = findCol(catHeaders, ['color']) >= 0 ? findCol(catHeaders, ['color']) : 4;

  for (var i = 1; i < firstData.length; i++) {
    var row = firstData[i];
    var id = String(row[idI] || '').trim();
    if (!id) continue;
    categories.push({
      id: id,
      name: String(row[nameI] || '').trim() || id,
      icon: String(row[iconI] || '').trim(),
      description: String(row[descI] || '').trim(),
      color: String(row[colorI] || '').trim()
    });
  }

  var categoryIds = categories.map(function(c) { return c.id; });
  var categoryIdSet = {};
  for (var ci = 0; ci < categoryIds.length; ci++) categoryIdSet[categoryIds[ci]] = true;

  // Листы со 2-го — инструменты по категориям
  for (var s = 1; s < sheets.length; s++) {
    var sh = sheets[s];
    var title = sh.getName();
    var fromSheetName = sheetNameToCategoryId(title);
    var fromOrder = categoryIds[s - 1] || '';
    // Ключевая логика: приоритет у имени листа (устраняет сдвиги при перестановке вкладок).
    var catId = '';
    if (fromSheetName && categoryIdSet[fromSheetName]) catId = fromSheetName;
    else if (fromOrder) catId = fromOrder;
    else if (fromSheetName) catId = fromSheetName;
    else catId = String(s);
    var rows = sh.getDataRange().getValues();
    var displayRows = sh.getDataRange().getDisplayValues();
    var headerRow = detectToolHeaderRow(rows);
    var headers = (rows[headerRow] || []).map(function(h) {
      return normalizeHeaderCell(h);
    });

    function colIndex(allowedNames) {
      if (!allowedNames || allowedNames.length === 0) return -1;
      for (var i = 0; i < headers.length; i++) {
        if (allowedNames.indexOf(headers[i]) !== -1) return i;
      }
      return -1;
    }
    var nameCol = colIndex(['name', 'название', 'instrument', 'инструмент']);
    if (nameCol < 0) nameCol = 0;
    var apyCol = colIndex(['apy', 'доходность', 'доход', 'yield', 'rate', 'apr']);
    if (apyCol < 0) apyCol = 1;
    var periodCol = colIndex(['period', 'период', 'term']);
    if (periodCol < 0) periodCol = 2;
    var statusCol = colIndex(['status', 'статус']);
    if (statusCol < 0) statusCol = 3;
    var linkCol = colIndex(['link', 'url', 'ссылка']);
    if (linkCol < 0) linkCol = 4;
    var descCol = colIndex(['description', 'desc', 'описание']);
    if (descCol < 0) {
      var di;
      for (di = 0; di < headers.length; di++) {
        var dh = headers[di];
        if (dh.indexOf('описание') !== -1) { descCol = di; break; }
        if (dh === 'description' || dh.indexOf('description') === 0) { descCol = di; break; }
      }
    }
    if (descCol < 0) descCol = -1;
    var pairCol = -1;
    var pci;
    for (pci = 0; pci < headers.length; pci++) {
      if (headers[pci] === 'pair' || headers[pci] === 'пара') { pairCol = pci; break; }
    }
    var platformCol = colIndex(['platform', 'платформа', 'dex', 'protocol', 'протокол']);
    if (platformCol < 0) platformCol = -1;
    var feeCol = colIndex(['fee', 'fee tier', 'fee_tier', 'fitier', 'fi tier', 'комиссия', 'tier', 'уровень']);
    if (feeCol < 0) feeCol = -1;
    var chainCol = colIndex(['chain', 'blockchain', 'network', 'сеть', 'блокчейн']);
    if (chainCol < 0) chainCol = -1;
    var typeCol = colIndex(['type', 'тип', 'position type', 'pool type', 'тип позиции']);
    if (typeCol < 0) typeCol = -1;
    var minPriceCol = findPriceColumnIndex(headers, 'min');
    var maxPriceCol = findPriceColumnIndex(headers, 'max');
    var detailIndex = buildAuxiliaryDetailIndex(rows, displayRows);

    function pick(row, idx, def) {
      def = def || '';
      if (idx >= 0 && row[idx] !== undefined && row[idx] !== null && row[idx] !== '') return String(row[idx]).trim();
      return def;
    }

    function pickDisplay(r, idx, rowVals) {
      if (idx < 0) return '';
      if (displayRows[r] && displayRows[r][idx] !== undefined && displayRows[r][idx] !== null && displayRows[r][idx] !== '') {
        return String(displayRows[r][idx]).trim();
      }
      return pick(rowVals, idx, '');
    }

    for (var r = headerRow + 1; r < rows.length; r++) {
      var rw = rows[r];
      var name = pick(rw, nameCol);
      if (!name) continue;
      var apy = pick(rw, apyCol).replace(/%/g, '') || '0';
      var period = (periodCol >= 0 && displayRows[r] && displayRows[r][periodCol] !== undefined && displayRows[r][periodCol] !== '')
        ? String(displayRows[r][periodCol]).trim()
        : (pick(rw, periodCol) || '7d');
      var status = (pick(rw, statusCol) || 'active').toLowerCase();
      if (status !== 'warning' && status !== 'внимание') status = 'active'; else status = 'warning';
      var link = pick(rw, linkCol) || '#';
      var desc = descCol >= 0 ? pick(rw, descCol) : '';
      var pair = pairCol >= 0 ? (pickDisplay(r, pairCol, rw) || pick(rw, pairCol, '')) : '';
      var platform = platformCol >= 0 ? pick(rw, platformCol) : '';
      var fee = feeCol >= 0 ? pick(rw, feeCol) : '';
      var chain = chainCol >= 0 ? pick(rw, chainCol) : '';
      var type = typeCol >= 0 ? pick(rw, typeCol) : '';
      var priceMin = minPriceCol >= 0 ? pick(rw, minPriceCol) : '';
      var priceMax = maxPriceCol >= 0 ? pick(rw, maxPriceCol) : '';
      var enriched = enrichPoolBattleFields(name, desc, platform, chain, fee);
      platform = enriched.platform;
      chain = enriched.chain;
      fee = enriched.fee;
      var detail = detailIndex[normalizeLinkKey(link)];
      if (detail) {
        if (detail.platform) platform = detail.platform;
        if (detail.pair) pair = detail.pair;
        if (detail.chain) chain = detail.chain;
        if (detail.fee) fee = detail.fee;
        if (detail.priceMin) priceMin = detail.priceMin;
        if (detail.priceMax) priceMax = detail.priceMax;
        if (detail.apy) {
          var detailApy = String(detail.apy).replace(/%/g, '').replace(/\s/g, '').replace(',', '.');
          var primaryApy = String(apy).replace(/%/g, '').replace(/\s/g, '').replace(',', '.');
          if (!primaryApy || primaryApy === '0' || primaryApy === '0.0') apy = detailApy;
        }
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
        status: status,
        link: link,
        desc: desc,
        descEn: desc
      });
    }
  }

  return { categories: categories, tools: allTools };
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
    var safeCallback = String(callback).replace(/[^a-zA-Z0-9_.]/g, '');
    out = ContentService.createTextOutput(safeCallback + '(' + jsonStr + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } else {
    out = ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return out;
}
