/**
 * Сервер для DeFi Labs Navigator.
 * Читает данные из Google Sheets (credentials из pusher-490008-bf7c384ba372.json)
 * и отдаёт их по /api/data. Ключи никогда не уходят в браузер.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
const CREDENTIALS_PATH = path.join(__dirname, 'pusher-490008-bf7c384ba372.json');
const PORT = process.env.PORT || 3333;

// Нормализация id категории из названия листа
function sheetNameToCategoryId(name) {
  if (!name || typeof name !== 'string') return '';
  const raw = name.trim();
  if (/\brwa\b/i.test(raw) || /real\s*world/i.test(raw)) return 'rwa';
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function findColumnIndex(row, ...names) {
  const r = row || [];
  const lower = (v) => String(v || '').toLowerCase().trim();
  for (const name of names) {
    const idx = r.findIndex((h) => lower(h) === lower(name));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Как в HTML: trim, lower, NBSP→space, схлопывание пробелов + BOM / zero-width */
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
  const text = String(desc || '').trim();
  if (!text) return { chain: '', fee: '' };
  const withFee = text.match(/^([A-Za-z0-9]+)\s+([\d.,]+)\s*%$/);
  if (withFee) {
    return {
      chain: withFee[1],
      fee: normalizeFeeValue(withFee[2]),
    };
  }
  if (/^[A-Za-z0-9]+$/.test(text)) return { chain: text, fee: '' };
  return { chain: '', fee: '' };
}

function enrichPoolBattleFields(name, desc, platform, chain, fee) {
  if (!platform && name) platform = String(name).trim();
  const meta = parsePoolMetaFromDesc(desc);
  if (!chain && meta.chain) chain = meta.chain;
  if (!fee && meta.fee !== '') fee = meta.fee;
  return { platform: platform || '', chain: chain || '', fee: fee || '' };
}

function normalizeLinkKey(link) {
  return String(link || '').trim().toLowerCase();
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

function buildAuxiliaryDetailIndex(rows) {
  const index = {};
  for (let r = 0; r < rows.length; r++) {
    const headers = (rows[r] || []).map(normalizeHeaderCell);
    let hasPlatform = false;
    let hasMinRange = false;
    for (let hi = 7; hi < headers.length; hi++) {
      if (/^(платформа|platform|dex|protocol|протокол)$/.test(headers[hi])) hasPlatform = true;
      if (/мин.*диапаз|min.*range|min_price|price_min/.test(headers[hi])) hasMinRange = true;
    }
    if (!hasPlatform || !hasMinRange) continue;

    const platformCol = findHeaderColumn(headers, 7, [/^(платформа|platform|dex|protocol|протокол)$/], 7);
    const minPriceCol = findHeaderColumn(headers, 7, [/мин.*диапаз|min.*range|min_price|price_min/], 8);
    const maxPriceCol = findHeaderColumn(headers, 7, [/макс.*диапаз|max.*range|max_price|price_max/], 9);
    const pairCol = findHeaderColumn(headers, 7, [/^(пара|pair)$/], 15);
    const chainCol = findHeaderColumn(headers, 7, [/^(блокчейн|chain|blockchain|network|сеть)$/], 16);
    const feeCol = findHeaderColumn(headers, 7, [/^(fee_tier|fitier|fi tier|fee tier|fee|комиссия|tier|уровень)$/], 17);
    const apyCol = findHeaderColumn(headers, 7, [/^(apy|доходность|доход)$/], 19);
    const linkCol = findHeaderColumn(headers, 7, [/ссылка|link|url/], 20);

    const pickAux = (rowVals, idx) => (idx >= 0 && rowVals[idx] !== undefined && rowVals[idx] !== '' ? String(rowVals[idx]).trim() : '');

    for (let rr = r + 1; rr < rows.length; rr++) {
      const rw = rows[rr] || [];
      const platform = pickAux(rw, platformCol);
      if (!platform) continue;
      const link = pickAux(rw, linkCol);
      if (!link) continue;
      index[normalizeLinkKey(link)] = {
        platform,
        priceMin: pickAux(rw, minPriceCol),
        priceMax: pickAux(rw, maxPriceCol),
        pair: pickAux(rw, pairCol),
        chain: pickAux(rw, chainCol),
        fee: pickAux(rw, feeCol),
        apy: pickAux(rw, apyCol),
      };
    }
    break;
  }
  return index;
}

/** Первая строка не всегда заголовки (баннер/пусто); ищем строку с name + apy */
function findPriceColumnIndex(headers, kind) {
  const minPatterns = [
    /^(min_price|price_min|min range|range_min|price_min_usd|min price|price lower|price_low|lower price|range low)$/,
    /^(мин|минимум|мин диапазон|диапазон мин|нижняя граница)$/,
    /min/,
    /lower/,
    /нижн/,
    /мин/,
  ];
  const maxPatterns = [
    /^(max_price|price_max|max range|range_max|price_max_usd|max price|price upper|price_high|upper price|range high)$/,
    /^(макс|максимум|макс диапазон|диапазон макс|верхняя граница)$/,
    /max/,
    /upper/,
    /верхн/,
    /макс/,
  ];
  const patterns = kind === 'min' ? minPatterns : maxPatterns;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    for (const re of patterns) {
      if (re.test(h)) return i;
    }
  }
  const letterFallback = kind === 'min' ? [4, 8] : [5];
  for (const idx of letterFallback) {
    const h = headers[idx];
    if (!h) continue;
    if (patterns.some((re) => re.test(h))) return idx;
  }
  return -1;
}

function detectToolHeaderRow(rows) {
  const maxScan = Math.min(10, rows.length);
  for (let r = 0; r < maxScan; r++) {
    const headers = (rows[r] || []).map(normalizeHeaderCell);
    const hasName = headers.some((h) => /^(name|название|instrument|инструмент)$/.test(h));
    const hasApy = headers.some((h) =>
      /^(apy|доходность|доход|yield|rate|apr)$/.test(h)
    );
    if (hasName && hasApy) return r;
  }
  return 0;
}

async function getSheetsClient() {
  const cred = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: cred,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchSpreadsheetData() {
  const sheets = await getSheetsClient();

  // Метаданные: список листов
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId,title))',
  });

  const sheetList = meta.data.sheets || [];
  if (sheetList.length === 0) {
    return { categories: [], tools: [] };
  }

  const categories = [];
  const allTools = [];
  let toolId = 1;

  // Первый лист — категории (id, name, icon, description, color)
  const firstTitle = sheetList[0].properties.title;
  const firstRange = `'${firstTitle.replace(/'/g, "''")}'!A:E`;
  const firstRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: firstRange,
  });
  const firstRows = firstRes.data.values || [];
  const catHeaders = firstRows[0] || [];
  const idIdx = findColumnIndex(catHeaders, 'id') >= 0 ? findColumnIndex(catHeaders, 'id') : 0;
  const nameIdx = findColumnIndex(catHeaders, 'name') >= 0 ? findColumnIndex(catHeaders, 'name') : 1;
  const iconIdx = findColumnIndex(catHeaders, 'icon') >= 0 ? findColumnIndex(catHeaders, 'icon') : 2;
  const descIdx = findColumnIndex(catHeaders, 'description') >= 0 ? findColumnIndex(catHeaders, 'description') : 3;
  const colorIdx = findColumnIndex(catHeaders, 'color') >= 0 ? findColumnIndex(catHeaders, 'color') : 4;

  for (let i = 1; i < firstRows.length; i++) {
    const row = firstRows[i];
    const id = (row[idIdx] || '').toString().trim();
    if (!id) continue;
    categories.push({
      id,
      name: (row[nameIdx] || '').toString().trim() || id,
      icon: (row[iconIdx] || '').toString().trim(),
      description: (row[descIdx] || '').toString().trim(),
      color: (row[colorIdx] || '').toString().trim(),
    });
  }

  // Листы со 2-го — инструменты по категориям (один лист = одна категория)
  const categoryOrder = categories.map((c) => c.id);
  const categoryIdSet = new Set(categoryOrder);
  for (let s = 1; s < sheetList.length; s++) {
    const props = sheetList[s].properties;
    const title = props.title || '';
    const fromSheetName = sheetNameToCategoryId(title);
    const fromOrder = categoryOrder[s - 1] || '';
    let categoryId = '';
    if (fromSheetName && categoryIdSet.has(fromSheetName)) categoryId = fromSheetName;
    else if (fromOrder) categoryId = fromOrder;
    else if (fromSheetName) categoryId = fromSheetName;
    else categoryId = String(s);

    // A:Z обрезал столбцы после Z — pair/прочие поля часто правее; берём широкий диапазон
    const range = `'${title.replace(/'/g, "''")}'!A:ZZ`;
    let rows;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueRenderOption: 'FORMATTED_VALUE',
      });
      rows = res.data.values || [];
    } catch (e) {
      continue;
    }

    const headerRow = detectToolHeaderRow(rows);
    const headers = (rows[headerRow] || []).map(normalizeHeaderCell);
    const nameCol = headers.findIndex((h) => /^(name|название|instrument|инструмент)$/.test(h));
    const apyCol = headers.findIndex((h) =>
      /^(apy|доходность|доход|yield|rate|apr)$/.test(h)
    );
    const periodCol = headers.findIndex((h) => /^(period|период|term)$/.test(h));
    const statusCol = headers.findIndex((h) => /^(status|статус)$/.test(h));
    const linkCol = headers.findIndex((h) => /^(link|url|ссылка)$/.test(h));
    let descCol = headers.findIndex((h) => /^(description|desc|описание)$/.test(h));
    if (descCol < 0) {
      descCol = headers.findIndex((h) => h.includes('описание'));
    }
    if (descCol < 0) {
      descCol = headers.findIndex((h) => h === 'description' || h.startsWith('description'));
    }
    // Столбец pair или «пара» (та же нормализация заголовков)
    const pairCol = headers.findIndex((h) => h === 'pair' || h === 'пара');
    const platformCol = headers.findIndex((h) =>
      /^(platform|платформа|dex|protocol|протокол)$/.test(h)
    );
    const feeCol = headers.findIndex((h) =>
      /^(fee|fee tier|fee_tier|fitier|fi tier|комиссия|tier|уровень)$/.test(h)
    );
    const chainCol = headers.findIndex((h) =>
      /^(chain|blockchain|network|сеть|блокчейн)$/.test(h)
    );
    const typeCol = headers.findIndex((h) =>
      /^(type|тип|position type|pool type|тип позиции)$/.test(h)
    );
    const minPriceCol = findPriceColumnIndex(headers, 'min');
    const maxPriceCol = findPriceColumnIndex(headers, 'max');
    const detailIndex = buildAuxiliaryDetailIndex(rows);

    const pick = (row, idx, def = '') => (idx >= 0 && row[idx] !== undefined && row[idx] !== '' ? String(row[idx]).trim() : def);

    function parseApyCell(s) {
      if (s == null || s === '') return '0';
      const t = String(s).replace(/%/g, '').replace(/\s/g, '').replace(',', '.');
      const n = parseFloat(t);
      return Number.isFinite(n) ? String(n) : '0';
    }

    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i];
      const name = nameCol >= 0 ? pick(row, nameCol) : pick(row, 0);
      if (!name) continue;

      const apyRaw = apyCol >= 0 ? pick(row, apyCol) : pick(row, 1);
      const apy = parseApyCell(apyRaw);
      const period = periodCol >= 0 ? pick(row, periodCol) : '7d';
      const status = (statusCol >= 0 ? pick(row, statusCol) : 'active').toLowerCase() || 'active';
      const link = linkCol >= 0 ? pick(row, linkCol) : '';
      const desc = descCol >= 0 ? pick(row, descCol) : '';
      const pair = pairCol >= 0 ? pick(row, pairCol) : '';
      const platform = platformCol >= 0 ? pick(row, platformCol) : '';
      const fee = feeCol >= 0 ? pick(row, feeCol) : '';
      const chain = chainCol >= 0 ? pick(row, chainCol) : '';
      const type = typeCol >= 0 ? pick(row, typeCol) : '';
      const priceMin = minPriceCol >= 0 ? pick(row, minPriceCol) : '';
      const priceMax = maxPriceCol >= 0 ? pick(row, maxPriceCol) : '';
      const enriched = enrichPoolBattleFields(name, desc, platform, chain, fee);
      const detail = detailIndex[normalizeLinkKey(link)];
      let mergedPlatform = enriched.platform;
      let mergedFee = enriched.fee;
      let mergedChain = enriched.chain;
      let mergedPair = pair;
      let mergedMin = priceMin;
      let mergedMax = priceMax;
      let mergedApy = apy;
      if (detail) {
        if (detail.platform) mergedPlatform = detail.platform;
        if (detail.pair) mergedPair = detail.pair;
        if (detail.chain) mergedChain = detail.chain;
        if (detail.fee) mergedFee = detail.fee;
        if (detail.priceMin) mergedMin = detail.priceMin;
        if (detail.priceMax) mergedMax = detail.priceMax;
        if (detail.apy) {
          const detailApy = parseApyCell(detail.apy);
          if (!parseFloat(mergedApy)) mergedApy = detailApy;
        }
      }

      allTools.push({
        id: toolId++,
        categoryId,
        name,
        pair: mergedPair,
        platform: mergedPlatform,
        fee: mergedFee,
        chain: mergedChain,
        type,
        priceMin: mergedMin,
        priceMax: mergedMax,
        apy: mergedApy,
        period,
        status: status === 'warning' || status === 'внимание' ? 'warning' : 'active',
        link: link || '#',
        desc,
        descEn: desc,
      });
    }
  }

  return { categories, tools: allTools };
}

function serveFile(filePath, contentType, res) {
  const full = path.join(__dirname, filePath);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0] || '/';

  if (url === '/api/data') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const data = await fetchSpreadsheetData();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e.message), categories: [], tools: [] }));
    }
    return;
  }

  if (url === '/' || url === '/index.html') {
    serveFile('defi-lab-navigator.html', 'text/html; charset=utf-8', res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`DeFi Labs Navigator: http://localhost:${PORT}`);
  console.log('API: http://localhost:' + PORT + '/api/data');
});
