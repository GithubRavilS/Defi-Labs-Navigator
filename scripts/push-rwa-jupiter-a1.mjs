/**
 * RWA → лист «БИТВА ПУЛОВ RWA» (unified A1), APY как на Jupiter.
 * JUPITER_API_KEY=... node scripts/push-rwa-jupiter-a1.mjs
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = "1ZrMaFUyrHmxldFG242OsKHLOWPxhI4H8vCxO-TvL9Zg";
const SHEET = "БИТВА ПУЛОВ RWA";
const JUPITER = "https://api.jup.ag/portfolio/v1";

const HEADERS = [
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

function parseWallet(v) {
  const s = String(v || "").trim();
  const m =
    s.match(/portfolio\/([1-9A-HJ-NP-Za-km-z]{32,44})/i) ||
    s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? m[1] : "";
}

function isLiq(el) {
  if (!el || el.networkId !== "solana") return false;
  if (el.type === "borrowlend" || el.label === "Lending") return false;
  const pid = String(el.platformId || "").toLowerCase();
  if (pid.includes("kamino") && el.type !== "liquidity") return false;
  return el.type === "liquidity" || el.label === "LiquidityPool";
}

function pairHasEthBtc(pair) {
  return /\b(ETH|WETH|BTC|WBTC|cbBTC)\b/i.test(String(pair || ""));
}

function sym(asset, tokenInfo) {
  const a = asset?.data?.address;
  if (tokenInfo?.solana?.[a]?.symbol) return tokenInfo.solana[a].symbol;
  return asset?.data?.symbol || "";
}

function tokenUsd(asset) {
  if (!asset) return 0;
  if (asset.value != null) return Number(asset.value) || 0;
  const amt = Number(asset.data?.amount) || 0;
  const pr = Number(asset.data?.price) || 0;
  return amt * pr;
}

function isStable(sym) {
  return /^(USDC|USDT|USD1|PYUSD|USDS|DAI|CASH)$/i.test(String(sym || "").trim());
}

function splitRewards(liq, tokenInfo) {
  let stableUsd = 0;
  let assetAmt = 0;
  let assetSym = "";
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
  return { stableUsd, assetAmt, assetSym, assetUsd, totalUsd: stableUsd + assetUsd };
}

function apyFromJupiter(el, liq) {
  let f = null;
  if (liq?.yields?.[0]?.apy != null) f = Number(liq.yields[0].apy);
  else if (liq?.netApy != null) f = Number(liq.netApy);
  else if (el?.netApy != null) f = Number(el.netApy);
  else if (liq?.yields?.[0]?.apr != null) f = Number(liq.yields[0].apr);
  if (f == null || isNaN(f)) return "0%";
  const pct = f <= 1 && f >= -1 ? f * 100 : f;
  return `${Math.round(pct * 100) / 100}%`;
}

function fmt(n, d = 8) {
  if (n == null || isNaN(Number(n))) return "";
  const v = Number(n);
  if (v === 0) return "0";
  return String(Math.round(v * 10 ** d) / 10 ** d);
}

function platformName(el) {
  const pid = String(el.platformId || "").toLowerCase();
  if (pid.includes("raydium")) return "Raydium";
  if (pid.includes("orca")) return "Orca";
  if (pid.includes("meteora")) return "Meteora";
  return el.name || el.platformId || "RWA";
}

async function loadJupiterApiKey(sheetsApi, sheetQuery) {
  if (process.env.JUPITER_API_KEY) return String(process.env.JUPITER_API_KEY).trim();
  const paths = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "secrets", "jupiter-api-key.txt"),
  ];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const m = raw.match(/JUPITER_API_KEY\s*=\s*(\S+)/);
      if (m) return m[1].trim();
      if (p.endsWith(".txt")) return raw.trim().split("\n")[0].trim();
    } catch {
      /* ignore */
    }
  }
  try {
    const z4 = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetQuery}!Z4`,
    });
    const v = String(z4.data.values?.[0]?.[0] || "").trim();
    if (v && v.length >= 12 && !/jupiter\s*api/i.test(v)) return v;
  } catch {
    /* ignore */
  }
  return "";
}

async function fetchJupiter(wallet, apiKey) {
  const key = apiKey;
  if (!key) {
    console.error(
      "Нет ключа: JUPITER_API_KEY в env, secrets/jupiter-api-key.txt, .env или ячейка Z4 на листе RWA.",
    );
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2200));
  const headers = { Accept: "application/json", "x-api-key": key };
  const res = await fetch(`${JUPITER}/positions/${wallet}`, { headers });
  const text = await res.text();
  if (!res.ok) {
    console.error("Jupiter", res.status, text.slice(0, 400));
    process.exit(1);
  }
  const payload = JSON.parse(text);
  const n = payload.elements?.length || 0;
  if (!n) {
    console.error("Jupiter вернул 0 elements — проверьте ключ и кошелёк");
    process.exit(1);
  }
  return payload;
}

function toLines(payload, wallet) {
  const tokenInfo = payload.tokenInfo || {};
  const rows = [];
  const seen = new Set();
  for (const el of payload.elements || []) {
    if (!isLiq(el)) continue;
    const liqs =
      el.type === "liquidity" && el.data?.liquidities?.length ? el.data.liquidities : [null];
    for (const liq of liqs) {
      const pair =
        (liq?.assets || [])
          .map((a) => sym(a, tokenInfo))
          .filter(Boolean)
          .join(" / ") || "";
      if (pairHasEthBtc(pair)) continue;
      const platform = platformName(el);
      const link = liq?.link || el.data?.link || `https://jup.ag/portfolio/${wallet}`;
      const key = link + "|" + platform;
      if (seen.has(key)) continue;
      seen.add(key);
      const rew = splitRewards(liq, tokenInfo);
      const invested = Number(liq?.value ?? liq?.assetsValue ?? 0) || 0;
      const feeM = String(liq?.name || "").match(/(\d+(?:[.,]\d+)?)\s*%/);
      const fee = feeM ? `${feeM[1].replace(",", ".")}%` : "";
      rows.push([
        platform,
        "",
        "",
        new Date()
          .toLocaleString("ru-RU", { timeZone: "Europe/Warsaw", hour12: false })
          .replace(",", ""),
        fmt(rew.stableUsd),
        fmt(rew.assetAmt, 12),
        rew.assetSym,
        "",
        fmt(rew.totalUsd),
        pair,
        "solana",
        fee,
        apyFromJupiter(el, liq),
        link,
        fmt(invested, 4),
      ]);
    }
  }
  rows.sort((a, b) => parseFloat(b[12]) - parseFloat(a[12]));
  return rows;
}

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "..", "pusher-490008-bf7c384ba372.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const q = `'${SHEET.replace(/'/g, "''")}'`;

const z2 = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!Z2`,
});
const wallet = parseWallet(z2.data.values?.[0]?.[0]);
if (!wallet) {
  console.error("Нет кошелька в Z2");
  process.exit(1);
}

const apiKey = await loadJupiterApiKey(sheets, q);
console.log("Jupiter key:", apiKey ? `${apiKey.length} символов` : "нет");
const payload = await fetchJupiter(wallet, apiKey);
const lines = toLines(payload, wallet);
console.log("Позиций LP:", lines.length);
for (const line of lines) {
  console.log(`  ${line[0]} | ${line[9]} | APY ${line[12]}`);
}

const block = [HEADERS, ...lines];
await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${q}!A1:W120` });
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!A1`,
  valueInputOption: "USER_ENTERED",
  requestBody: { values: block },
});
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${q}!Z3`,
  valueInputOption: "USER_ENTERED",
  requestBody: {
    values: [[`OK · ${lines.length} LP · Jupiter APY · ${new Date().toISOString()}`]],
  },
});
console.log("Таблица обновлена:", SPREADSHEET_ID);
