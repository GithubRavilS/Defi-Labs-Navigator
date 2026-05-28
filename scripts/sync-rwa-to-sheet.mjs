/**
 * RWA: Jupiter → таблица битвы пуллов (2-й Excel) → копия на сайтовый лист.
 * node scripts/sync-rwa-to-sheet.mjs
 * JUPITER_API_KEY=... (portal.jup.ag, Free)
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_SPREADSHEET_ID = '1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg';
const SOURCE_SPREADSHEET_ID = '1NjN5ELRjNVlFSVfJLCQsho32Kod5HRA4JWakZ7KVsJY';
const SHEET = 'БИТВА ПУЛОВ RWA';
const JUPITER = 'https://api.jup.ag/portfolio/v1';

const AUX_HEADERS = [
  '', '', '', '', '', '', '',
  'Платформа', 'Мин диапазона', 'Макс диапазон', 'Дата открытия норм',
  'Заработано стейблов', 'Заработано актива', 'Символ актива', 'Заработано AERO',
  'Итого комс доход', 'пара', 'Блокчейн', 'fee_tier', 'APR', 'APY', 'ссылка', 'Инвестировано',
];

function parseWallet(v) {
  const s = String(v || '').trim();
  const m = s.match(/portfolio\/([1-9A-HJ-NP-Za-km-z]{32,44})/i) || s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? m[1] : '';
}

function isLiq(el) {
  if (!el || el.networkId !== 'solana') return false;
  if (el.type === 'borrowlend' || el.label === 'Lending') return false;
  const pid = String(el.platformId || '').toLowerCase();
  if (pid.includes('kamino') && (el.type === 'borrowlend' || el.label === 'Lending')) return false;
  if (el.type === 'liquidity' || el.label === 'LiquidityPool') return true;
  if (el.type === 'multiple' && el.label === 'LiquidityPool') return true;
  return false;
}

function isStable(sym) {
  return /^(USDC|USDT|USD1|PYUSD|USDS|DAI|CASH)$/i.test(String(sym || '').trim());
}

function sym(asset, tokenInfo) {
  const a = asset?.data?.address;
  if (tokenInfo?.solana?.[a]?.symbol) return tokenInfo.solana[a].symbol;
  return asset?.data?.symbol || '';
}

function tokenUsd(asset) {
  if (!asset) return 0;
  if (asset.value != null) return Number(asset.value) || 0;
  const amt = Number(asset.data?.amount) || 0;
  const pr = Number(asset.data?.price) || 0;
  return amt * pr;
}

function splitRewards(liq, tokenInfo) {
  let stableUsd = 0;
  let assetAmt = 0;
  let assetSym = '';
  let assetUsd = 0;
  for (const r of liq?.rewardAssets || []) {
    const s = sym(r, tokenInfo);
    const v = tokenUsd(r);
    const amt = Number(r?.data?.amount) || 0;
    if (isStable(s)) stableUsd += v;
    else if (s) {
      if (!assetSym) assetSym = s;
      assetAmt += amt;
      assetUsd += v;
    }
  }
  return { stableUsd, assetAmt, assetSym, totalUsd: stableUsd + assetUsd };
}

function apyPct(el, liq) {
  let f = el?.netApy;
  if (f == null && liq?.yields?.[0]) f = liq.yields[0].apy ?? liq.yields[0].apr;
  if (f == null) return '0';
  const n = Number(f);
  const pct = n <= 1 && n >= -1 ? n * 100 : n;
  return String(Math.round(pct * 10) / 10);
}

async function fetchJupiter(wallet) {
  const headers = { Accept: 'application/json' };
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;
  await new Promise((r) => setTimeout(r, 2200));
  const res = await fetch(`${JUPITER}/positions/${wallet}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jupiter ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function toRows(payload, wallet) {
  const tokenInfo = payload.tokenInfo || {};
  const rows = [];
  const seen = new Set();
  const today = new Date().toLocaleDateString('ru-RU');
  for (const el of payload.elements || []) {
    if (!isLiq(el)) continue;
    const liqs = el.type === 'liquidity' && el.data?.liquidities?.length ? el.data.liquidities : [null];
    for (const liq of liqs) {
      const platform = /raydium/i.test(el.platformId || '') ? 'Raydium' : /orca/i.test(el.platformId || '') ? 'Orca' : /meteora/i.test(el.platformId || '') ? 'Meteora' : (el.name || el.platformId || 'RWA');
      const pair = (liq?.assets || []).map((a) => sym(a, tokenInfo)).filter(Boolean).join(' / ') || (liq?.name || '');
      const link = liq?.link || el.data?.link || `https://jup.ag/portfolio/${wallet}`;
      const key = link + '|' + platform;
      if (seen.has(key)) continue;
      seen.add(key);
      const feeM = String(liq?.name || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
      const fee = feeM ? feeM[1].replace(',', '.') : '';
      const rew = splitRewards(liq, tokenInfo);
      const invested = Number(liq?.value ?? liq?.assetsValue ?? 0) || 0;
      rows.push({
        platform,
        apy: apyPct(el, liq),
        pair,
        link,
        fee,
        openDate: today,
        rewards: rew,
        invested,
      });
    }
  }
  return rows.sort((a, b) => parseFloat(b.apy) - parseFloat(a.apy));
}

/** Блок с 7-й строки (1–6 не трогаем: B6 = кошелёк). */
function buildSheetBlock(rows) {
  const stdHeaders = ['name', 'apy', 'period', 'status', 'link', 'description', 'pair'];
  const block = [stdHeaders];
  for (const r of rows) {
    block.push([
      r.platform,
      r.apy,
      '0 дн',
      'active',
      r.link,
      r.fee ? `solana ${r.fee}%` : 'solana',
      r.pair,
    ]);
  }
  const gap = Math.max(2, 11 - block.length);
  for (let i = 0; i < gap; i++) block.push(new Array(AUX_HEADERS.length).fill(''));
  block.push(AUX_HEADERS);
  for (const r of rows) {
    const line = new Array(AUX_HEADERS.length).fill('');
    line[7] = r.platform;
    line[10] = r.openDate;
    line[11] = r.rewards.stableUsd;
    line[12] = r.rewards.assetAmt;
    line[13] = r.rewards.assetSym;
    line[15] = r.rewards.totalUsd;
    line[16] = r.pair;
    line[17] = 'solana';
    line[18] = r.fee ? `${r.fee}%` : '';
    line[19] = r.apy;
    line[20] = r.apy;
    line[21] = r.link;
    line[22] = r.invested;
    block.push(line);
  }
  return block;
}

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '..', 'pusher-490008-bf7c384ba372.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const q = `'${SHEET.replace(/'/g, "''")}'`;

let wallet = '';
try {
  const b6 = await sheets.spreadsheets.values.get({
    spreadsheetId: SOURCE_SPREADSHEET_ID,
    range: `${q}!B6`,
    valueRenderOption: 'FORMULA',
  });
  wallet = parseWallet(b6.data.values?.[0]?.[0]);
} catch (e) {
  console.error('Нет доступа к таблице битвы пуллов (2-й Excel). Дайте сервисному аккаунту доступ или запускайте синх из Apps Script.');
  console.error(e.message);
  process.exit(1);
}

if (!wallet) {
  console.error('Кошелёк не найден в B6 второй таблицы.');
  process.exit(1);
}
console.log('Wallet B6:', wallet);

const payload = await fetchJupiter(wallet);
const rows = toRows(payload, wallet);
console.log('Liquidity positions:', rows.length);
if (rows.length < 6) {
  console.warn('Меньше 6 позиций — добавьте JUPITER_API_KEY или проверьте кошелёк.');
}

const block = buildSheetBlock(rows);
const cols = AUX_HEADERS.length;

await sheets.spreadsheets.values.clear({
  spreadsheetId: SOURCE_SPREADSHEET_ID,
  range: `${q}!A8:W200`,
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SOURCE_SPREADSHEET_ID,
  range: `${q}!A7`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: block },
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SOURCE_SPREADSHEET_ID,
  range: `${q}!D2`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: [[`OK · ${rows.length} поз.`]] },
});

await sheets.spreadsheets.values.clear({
  spreadsheetId: SITE_SPREADSHEET_ID,
  range: `${q}!A1:W200`,
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SITE_SPREADSHEET_ID,
  range: `${q}!A1`,
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: block },
});

console.log('Done: source + site sheets updated.');
