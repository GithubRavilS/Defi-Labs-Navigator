/**
 * GET /api/pool-tvl
 *
 * Returns the EXACT TVL of a liquidity pool position.
 *
 * Resolution pipeline:
 *   A. revert.finance link  → Revert API /positions/{net}/{proto}/{id} → exact pool TVL
 *   B. krystal link         → NFPM.positions() on-chain → token0+token1+fee
 *                             → Factory.getPool() on-chain → exact pool address
 *                             → DexScreener by pool address → exact TVL
 *   C. poolAddress param    → DexScreener directly
 *
 * All APIs/RPCs are free with no API key required.
 */

const https = require("https");
const zlib = require("zlib");

// ─── Chain maps ───────────────────────────────────────────────────────────────

const CHAIN_TO_DEXSCREENER = {
  mainnet: "ethereum",
  ethereum: "ethereum",
  bsc: "bsc",
  binancesmartchain: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  opmainnet: "optimism",
  polygon: "polygon",
};

// chain key → ordered fallback RPC list (free, no key)
const CHAIN_TO_RPC = {
  mainnet: ["https://ethereum.publicnode.com", "https://cloudflare-eth.com"],
  bsc: ["https://bsc-dataseed.binance.org", "https://bsc.publicnode.com"],
  base: ["https://mainnet.base.org", "https://base.publicnode.com"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.publicnode.com"],
  optimism: ["https://mainnet.optimism.io", "https://optimism.publicnode.com"],
  polygon: ["https://polygon-rpc.com", "https://polygon.publicnode.com"],
};

// Uniswap V3 NFPM per chain (for on-chain fallback when Revert API fails)
const CHAIN_TO_UNISWAP_V3_NFPM = {
  mainnet: "0xc36442b4a4522e871399cd717abdd847ab11fe88",
  optimism: "0xc36442b4a4522e871399cd717abdd847ab11fe88",
  bsc: "0x7b8a01b39d58278b5de7e48c8449c9f4f5170613",
  base: "0x03a520b32c04bf3beef7bef1b5e31f91fe8f31d8",
  arbitrum: "0x91ae842a5ffd8d12023116943e72a606179294f3",
};

// Krystal chain ID → our chain key
const CHAIN_ID_TO_KEY = {
  1: "mainnet",
  56: "bsc",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
};

// Revert Finance chain key → network slug
const CHAIN_TO_REVERT = {
  mainnet: "mainnet",
  ethereum: "mainnet",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
};

// NFPM address (lowercase) → Factory address (lowercase)
// Verified on-chain by calling pool.factory() on known pools.
const NFPM_TO_FACTORY = {
  // Uniswap V3 (all chains share same factory 0x1f98...)
  "0xc36442b4a4522e871399cd717abdd847ab11fe88": "0x1f98431c8ad98523631ae4a59f267346ea31f984", // mainnet
  "0x7b8a01b39d58278b5de7e48c8449c9f4f5170613": "0x1f98431c8ad98523631ae4a59f267346ea31f984", // bsc
  "0x03a520b32c04bf3beef7bef1b5e31f91fe8f31d8": "0x1f98431c8ad98523631ae4a59f267346ea31f984", // base
  "0x91ae842a5ffd8d12023116943e72a606179294f3": "0x1f98431c8ad98523631ae4a59f267346ea31f984", // arbitrum
  "0xc36442b4a4522e871399cd717abdd847ab11fe88": "0x1f98431c8ad98523631ae4a59f267346ea31f984", // optimism (same as mainnet)
  // Uniswap V4 - uses PoolManager, no NFPM factory lookup (Revert handles these)
  // PancakeSwap V3 — different factory per chain
  "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364": "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865", // bsc+base+mainnet
  // Aerodrome CL (slipstream)
  "0x827922686190790b37229fd06084350e74485b72": "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a", // base
  // Aerodrome Concentrated V3
  "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53": "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef", // base
};

const SYMBOL_ALIASES = {
  ETH: ["ETH", "WETH"],
  WETH: ["ETH", "WETH"],
  BTC: ["BTC", "WBTC", "CBBTC", "cbBTC"],
  WBTC: ["BTC", "WBTC", "CBBTC", "cbBTC"],
  CBBTC: ["BTC", "WBTC", "CBBTC", "cbBTC"],
  USDT: ["USDT", "USDT0", "USDT_0"],
  USDT0: ["USDT", "USDT0", "USDT_0"],
  "USD\u20AE0": ["USDT", "USDT0", "USD\u20AE0"],
};

function parseFeePercent(feeStr) {
  if (!feeStr) return null;
  const m = String(feeStr)
    .replace(",", ".")
    .match(/([\d.]+)/);
  const v = m ? parseFloat(m[1]) : null;
  if (v === 0) return null;
  return v;
}

function parsePairSymbols(pairStr) {
  return (pairStr || "")
    .split(/[\/\-]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function symbolVariants(sym) {
  let u = (sym || "").toUpperCase();
  if (u === "USD\u20AE0") u = "USDT0";
  return SYMBOL_ALIASES[u] || [u];
}

function pairNameMatchesSymbols(name, symbols) {
  const raw = (name || "").toUpperCase();
  // Only accept simple two-token pool names like "WETH / USDC 0.05%"
  const beforeFee = raw.split(/\d+\.?\d*\s*%/)[0];
  const segments = beforeFee
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length !== 2) return false;

  return symbols.every((sym) =>
    symbolVariants(sym).some((v) => segments.some((seg) => seg.includes(v))),
  );
}

function extractFeeFromName(name) {
  const m = (name || "").replace(",", ".").match(/([\d.]+)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

function platformToDexIds(platform) {
  const p = (platform || "").toLowerCase().replace(/\s+/g, "");
  if (p.includes("aerodrome")) return ["aerodrome"];
  if (p.includes("pancake")) return ["pancakeswap"];
  if (p.includes("uniswap")) return ["uniswap"];
  return null;
}

function isAerodromePlatform(platform, nfpm) {
  const p = (platform || "").toLowerCase();
  if (p.includes("aerodrome")) return true;
  const n = (nfpm || "").toLowerCase();
  return (
    n === "0x827922686190790b37229fd06084350e74485b72" ||
    n === "0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53"
  );
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url, { timeout = 12000, headers: extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "defilabs-navigator/3.0",
          Accept: "application/json",
          ...extraHeaders,
        },
      },
      (res) => {
        let stream = res;
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        stream.on("data", (d) => chunks.push(d));
        stream.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
          } catch (e) {
            reject(e);
          }
        });
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function httpsPost(url, body, { timeout = 10000, headers: extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
        "User-Agent": "defilabs-navigator/3.0",
        ...extraHeaders,
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000;

function cacheGet(key) {
  const v = _cache.get(key);
  if (!v) return null;
  const ttl = v.tvlUsd == null ? 90 * 1000 : CACHE_TTL_MS;
  return Date.now() - v.ts < ttl ? v : null;
}
function cacheSet(key, tvlUsd, extra = {}) {
  _cache.set(key, { tvlUsd, ts: Date.now(), ...extra });
}

// ─── Chain normalisation ──────────────────────────────────────────────────────

function normalizeChain(chain) {
  const c = (chain || "").toLowerCase().replace(/\s+/g, "");
  if (c === "ethereum" || c === "mainnet") return "mainnet";
  if (c === "bsc" || c === "bnb" || c === "binancesmartchain") return "bsc";
  if (c === "base") return "base";
  if (c === "arbitrum" || c === "arbitrumone") return "arbitrum";
  if (c === "optimism" || c === "opmainnet") return "optimism";
  return c;
}

// ─── Link parsers ─────────────────────────────────────────────────────────────

function parseRevertLink(link) {
  let m = link.match(/#\/[^/]+-position\/([a-z]+)\/(\d+)/i);
  if (m) return { network: m[1].toLowerCase(), nftId: m[2] };
  m = link.match(/#\/[^/]+-position\/(\d+)/i);
  if (m) return { network: null, nftId: m[1] };
  return null;
}

function parseKrystalLink(link) {
  const m = link.match(/krystal\.app\/positions\/(\d+)\/(0x[0-9a-fA-F]{40})-(\d+)/i);
  if (!m) return null;
  return { chainId: m[1], nfpm: m[2].toLowerCase(), tokenId: m[3] };
}

// ─── Revert Finance ───────────────────────────────────────────────────────────

function pairFromV4Meta(pairName) {
  const m = (pairName || "").match(/-\s*([\w₮.]+)\/([\w₮.]+)\s*-/i);
  if (m) return `${m[1]}/${m[2]}`;
  return pairName || "";
}

function platformToRevertProtocol(platform) {
  const p = (platform || "").toLowerCase().replace(/\s+/g, "");
  if (p.includes("uniswap") && p.includes("4")) return "uniswapv4";
  if (p.includes("uniswap")) return "uniswapv3";
  if (p.includes("pancake")) return "pancakeswapv3";
  return "uniswapv3";
}

async function getRevertPosition(nftId, network, protocol) {
  const url = `https://api.revert.finance/v1/positions/${network}/${protocol}/${nftId}`;
  try {
    const { status, body } = await httpsGet(url, {
      timeout: 12000,
      headers: {
        Origin: "https://revert.finance",
        Referer: "https://revert.finance/",
      },
    });
    if (status !== 200) return null;
    const resp = JSON.parse(body);
    const pos = resp.data;
    if (!pos?.pool) return null;
    const symbols = Object.values(pos.tokens || {})
      .map((t) => (t.symbol || "").toUpperCase())
      .filter(Boolean);
    const feeTier = pos.fee_tier != null ? parseInt(pos.fee_tier, 10) / 10000 : null;
    return { pool: pos.pool, symbols, feeTier };
  } catch {
    return null;
  }
}

async function resolvePoolOnChain(nftId, chainKey, protocol) {
  if ((protocol || "").includes("v4")) return null;
  const nfpm = CHAIN_TO_UNISWAP_V3_NFPM[chainKey];
  if (!nfpm || !CHAIN_TO_RPC[chainKey]) return null;
  const pos = await getPositionData(nfpm, nftId, chainKey);
  if (!pos) return null;
  const factory = NFPM_TO_FACTORY[nfpm.toLowerCase()];
  if (!factory) return null;
  const pool = await getPoolFromFactory(factory, pos.token0, pos.token1, pos.fee, chainKey);
  return pool ? { pool, feeTier: pos.fee / 10000 } : null;
}

// ─── On-chain RPC calls ───────────────────────────────────────────────────────

// eth_call on multiple fallback RPCs
async function ethCall(chainKey, to, data) {
  const rpcs = CHAIN_TO_RPC[chainKey] || [];
  for (const rpc of rpcs) {
    try {
      const { status, body } = await httpsPost(
        rpc,
        { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] },
        { timeout: 8000 },
      );
      if (status !== 200) continue;
      const resp = JSON.parse(body);
      if (resp.error || !resp.result || resp.result === "0x") continue;
      return resp.result;
    } catch {
      continue;
    }
  }
  return null;
}

function decodeAbiString(hex) {
  try {
    const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
    const offset = parseInt(raw.slice(0, 64), 16) * 2;
    const len = parseInt(raw.slice(64, 128), 16);
    return Buffer.from(raw.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch {
    return null;
  }
}

// V4 PositionManager: tokenURI(uint256) returns addresses embedded in description
async function getPositionDataV4(nfpm, tokenId, chainKey) {
  const tokenIdHex = BigInt(tokenId).toString(16).padStart(64, "0");
  const result = await ethCall(chainKey, nfpm, "0xc87b56dd" + tokenIdHex); // tokenURI(uint256)
  if (!result) return null;
  try {
    const uri = decodeAbiString(result);
    if (!uri || !uri.includes("base64,")) return null;
    const meta = JSON.parse(Buffer.from(uri.split("base64,")[1], "base64").toString("utf8"));
    const desc = meta.description || "";
    const addrs = desc.match(/0x[0-9a-fA-F]{40}/g) || [];
    if (addrs.length < 2) return null;
    const feeFromName = extractFeeFromName(meta.name || "");
    return {
      token0: addrs[1] ? addrs[1].toLowerCase() : null,
      token1: addrs[2] ? addrs[2].toLowerCase() : null,
      fee: feeFromName,
      isV4: true,
      pairName: meta.name || "",
    };
  } catch {
    return null;
  }
}

// NFPM.positions(tokenId) → { token0, token1, fee }
async function getPositionData(nfpm, tokenId, chainKey) {
  const tokenIdHex = BigInt(tokenId).toString(16).padStart(64, "0");
  const result = await ethCall(chainKey, nfpm, "0x99fbab88" + tokenIdHex);
  if (!result) return null;
  const hex = result.slice(2);
  const fields = [];
  for (let i = 0; i < hex.length; i += 64) fields.push(hex.slice(i, i + 64));
  if (fields.length < 5) return null;
  return {
    token0: "0x" + fields[2].slice(-40),
    token1: "0x" + fields[3].slice(-40),
    fee: parseInt(fields[4], 16),
  };
}

// Factory.getPool(token0, token1, fee) → pool address
async function getPoolFromFactory(factory, token0, token1, fee, chainKey) {
  const t0 = token0.slice(2).toLowerCase().padStart(64, "0");
  const t1 = token1.slice(2).toLowerCase().padStart(64, "0");
  const feeHex = fee.toString(16).padStart(64, "0");
  const result = await ethCall(chainKey, factory, "0x1698ee82" + t0 + t1 + feeHex);
  if (!result) return null;
  const addr = "0x" + result.slice(-40);
  if (addr === "0x0000000000000000000000000000000000000000") return null;
  return addr;
}

// ─── DexScreener ─────────────────────────────────────────────────────────────

// DexScreener chain → GeckoTerminal network slug
const CHAIN_TO_GECKO = {
  ethereum: "eth",
  bsc: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
};

async function getTvlByPoolAddress(poolAddress, dexChain) {
  // Primary: DexScreener
  const url = `https://api.dexscreener.com/latest/dex/pairs/${dexChain}/${poolAddress.toLowerCase()}`;
  try {
    const { status, body } = await httpsGet(url, { timeout: 8000 });
    if (status === 200) {
      const data = JSON.parse(body);
      const pairs = data.pairs || (data.pair ? [data.pair] : []);
      if (pairs && pairs.length) {
        const pair =
          pairs.find((p) => (p.pairAddress || "").toLowerCase() === poolAddress.toLowerCase()) ||
          pairs[0];
        const tvl = pair?.liquidity?.usd;
        if (tvl != null) return tvl;
      }
    }
  } catch {
    /* fall through */
  }

  // Fallback: GeckoTerminal (covers pools DexScreener misses)
  const geckoNet = CHAIN_TO_GECKO[dexChain];
  if (!geckoNet) return null;
  try {
    const geckoUrl = `https://api.geckoterminal.com/api/v2/networks/${geckoNet}/pools/${poolAddress.toLowerCase()}`;
    const { status, body } = await httpsGet(geckoUrl, { timeout: 8000 });
    if (status === 200) {
      const data = JSON.parse(body);
      const reserveUsd = parseFloat(data.data?.attributes?.reserve_in_usd);
      if (!isNaN(reserveUsd) && reserveUsd > 0) return reserveUsd;
    }
  } catch {
    /* ignore */
  }

  return null;
}

// GeckoTerminal: find top pool TVL for two token addresses.
// token1 may be null for V4 ETH-native pairs (address(0) not captured by regex).
async function getTvlByTokenPair(token0, token1, geckoNet) {
  if (!geckoNet || !token0) return null;
  const ETH_KEYWORDS = ["weth", "/eth", "eth/", "wbnb", "wmatic"];
  const isEthPair = !token1;
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${geckoNet}/tokens/${token0.toLowerCase()}/pools?page=1`;
    const { status, body } = await httpsGet(url, { timeout: 8000 });
    if (status !== 200) return null;
    const data = JSON.parse(body);
    const pools = data.data || [];
    let bestTvl = null;
    for (const pool of pools) {
      const reserve = parseFloat(pool.attributes?.reserve_in_usd);
      if (isNaN(reserve) || reserve <= 0) continue;
      if (isEthPair) {
        const name = (pool.attributes?.name || "").toLowerCase();
        if (ETH_KEYWORDS.some((k) => name.includes(k))) {
          if (bestTvl === null || reserve > bestTvl) bestTvl = reserve;
        }
      } else {
        const rels = pool.relationships || {};
        const t0a = ((rels.base_token?.data?.id || "").split("_")[1] || "").toLowerCase();
        const t1a = ((rels.quote_token?.data?.id || "").split("_")[1] || "").toLowerCase();
        const has1 = t0a === token1.toLowerCase() || t1a === token1.toLowerCase();
        if (has1 && (bestTvl === null || reserve > bestTvl)) bestTvl = reserve;
      }
    }
    if (bestTvl !== null) return bestTvl;
  } catch {
    /* ignore */
  }
  return null;
}

function countSymbolOverlap(poolSymbols, pairSymbols) {
  let n = 0;
  for (const sym of pairSymbols) {
    if (symbolVariants(sym).some((v) => poolSymbols.some((ps) => ps === v || ps.includes(v)))) n++;
  }
  return n;
}

async function getPoolTokenSymbols(poolAddress, dexChain) {
  try {
    const { status, body } = await httpsGet(
      `https://api.dexscreener.com/latest/dex/pairs/${dexChain}/${poolAddress.toLowerCase()}`,
      { timeout: 6000 },
    );
    if (status !== 200) return null;
    const data = JSON.parse(body);
    const pairs = data.pairs || (data.pair ? [data.pair] : []);
    const p = pairs[0];
    if (!p) return null;
    return [(p.baseToken?.symbol || "").toUpperCase(), (p.quoteToken?.symbol || "").toUpperCase()];
  } catch {
    return null;
  }
}

async function getDexIdForPool(poolAddress, dexChain) {
  try {
    const { status, body } = await httpsGet(
      `https://api.dexscreener.com/latest/dex/pairs/${dexChain}/${poolAddress.toLowerCase()}`,
      { timeout: 6000 },
    );
    if (status !== 200) return null;
    const data = JSON.parse(body);
    const pairs = data.pairs || (data.pair ? [data.pair] : []);
    const pair = pairs[0];
    return pair?.dexId || null;
  } catch {
    return null;
  }
}

function pickBestPoolCandidate(candidates, feePct, dexIds, isV4) {
  if (!candidates.length) return null;
  let pool = candidates;

  if (feePct != null) {
    const exact = pool.filter((c) => c.fee != null && Math.abs(c.fee - feePct) < 0.015);
    if (exact.length) pool = exact;
    else if (isV4) {
      const close = pool.filter((c) => c.fee != null && Math.abs(c.fee - feePct) < 0.02);
      if (close.length) pool = close;
      else return null;
    } else return null;
  }

  if (dexIds && dexIds.length) {
    const dexMatch = pool.filter((c) => c.dexId && dexIds.includes(c.dexId));
    if (dexMatch.length) pool = dexMatch;
  }

  if (isV4) {
    const v4 = pool.filter((c) => c.isV4);
    if (v4.length) pool = v4;
  } else {
    const nonV4 = pool.filter((c) => !c.isV4);
    if (nonV4.length) pool = nonV4;
  }

  pool.sort((a, b) => b.tvl - a.tvl);
  return pool[0] || null;
}

// Universal fallback: search by pair + fee + chain + platform
async function getTvlByPairFeeSearch(pair, fee, dexChain, platform) {
  const symbols = parsePairSymbols(pair);
  const feePct = parseFeePercent(fee);
  if (symbols.length < 2 || !dexChain) return null;

  const geckoNet = CHAIN_TO_GECKO[dexChain];
  const dexIds = platformToDexIds(platform);
  const isV4 = (platform || "").toLowerCase().includes("v4");
  const candidates = [];

  // GeckoTerminal pool search (best for fee-tier names)
  if (geckoNet) {
    try {
      const q = encodeURIComponent(symbols.join(" "));
      const { status, body } = await httpsGet(
        `https://api.geckoterminal.com/api/v2/search/pools?query=${q}&network=${geckoNet}`,
        { timeout: 9000 },
      );
      if (status === 200) {
        for (const pool of JSON.parse(body).data || []) {
          const name = pool.attributes?.name || "";
          if (!pairNameMatchesSymbols(name, symbols)) continue;
          const reserve = parseFloat(pool.attributes?.reserve_in_usd);
          if (isNaN(reserve) || reserve <= 0) continue;
          const addr = (pool.attributes?.address || "").toLowerCase();
          candidates.push({
            tvl: reserve,
            fee: extractFeeFromName(name),
            dexId: null,
            isV4: /v4/i.test(name),
            source: "gecko-pair-search",
            poolAddress: addr,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // DexScreener search
  try {
    const q = encodeURIComponent(symbols.join(" "));
    const { status, body } = await httpsGet(
      `https://api.dexscreener.com/latest/dex/search?q=${q}`,
      { timeout: 9000 },
    );
    if (status === 200) {
      for (const p of JSON.parse(body).pairs || []) {
        if (p.chainId !== dexChain) continue;
        const base = (p.baseToken?.symbol || "").toUpperCase();
        const quote = (p.quoteToken?.symbol || "").toUpperCase();
        if (!pairNameMatchesSymbols(`${base} / ${quote}`, symbols)) continue;
        const tvl = p.liquidity?.usd;
        if (tvl == null || tvl <= 0) continue;
        const labels = p.labels || [];
        candidates.push({
          tvl,
          fee: extractFeeFromName(p.pairName || `${base}/${quote}`) || null,
          dexId: p.dexId || null,
          isV4: labels.includes("v4"),
          source: "dexscreener-pair-search",
          poolAddress: (p.pairAddress || "").toLowerCase(),
        });
      }
    }
  } catch {
    /* ignore */
  }

  const best = pickBestPoolCandidate(candidates, feePct, dexIds, isV4);
  if (!best) return null;
  return { tvlUsd: best.tvl, source: best.source, poolAddress: best.poolAddress };
}

async function tryPairFeeFallback(pair, fee, dexChain, platform) {
  if (!pair) return null;
  return getTvlByPairFeeSearch(pair, fee, dexChain, platform);
}

// ─── Uniswap V4 (official app gateway — same source as app.uniswap.org) ───────

const UNISWAP_GQL_URL = "https://interface.gateway.uniswap.org/v1/graphql";

const CHAIN_TO_UNISWAP_GQL = {
  mainnet: "ETHEREUM",
  ethereum: "ETHEREUM",
  base: "BASE",
  arbitrum: "ARBITRUM",
  optimism: "OPTIMISM",
  polygon: "POLYGON",
  bsc: "BNB",
};

function isUniswapV4Platform(platform) {
  const p = (platform || "").toLowerCase().replace(/\s+/g, "");
  return p.includes("uniswap") && p.includes("v4");
}

async function uniswapGql(query, variables = {}) {
  try {
    const { status, body } = await httpsPost(
      UNISWAP_GQL_URL,
      { query, variables },
      {
        timeout: 12000,
        headers: {
          Origin: "https://app.uniswap.org",
          Referer: "https://app.uniswap.org/",
        },
      },
    );
    if (status !== 200) return null;
    const parsed = JSON.parse(body);
    if (parsed.errors?.length) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function getTvlFromUniswapV4Pool(poolId, chainKey) {
  const gqlChain = CHAIN_TO_UNISWAP_GQL[chainKey];
  if (!gqlChain || !poolId) return null;
  const data = await uniswapGql(
    `query V4PoolTvl($chain: Chain!, $poolId: String!) {
      v4Pool(chain: $chain, poolId: $poolId) {
        totalLiquidity { value }
      }
    }`,
    { chain: gqlChain, poolId: poolId.toLowerCase() },
  );
  const val = parseFloat(data?.v4Pool?.totalLiquidity?.value);
  return !isNaN(val) && val > 0 ? val : null;
}

async function resolveUniswapV4PoolId(nftId, chainKey) {
  const revertNetwork = CHAIN_TO_REVERT[chainKey] || chainKey;
  const rev = await getRevertPosition(nftId, revertNetwork, "uniswapv4");
  return rev?.pool || null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const {
    link = "",
    poolAddress = "",
    chain = "",
    platform = "",
    pair = "",
    fee = "",
  } = req.query || {};
  const chainKey = normalizeChain(chain);
  const dexChain = CHAIN_TO_DEXSCREENER[chainKey];

  const respond = (tvlUsd, extra = {}) => {
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=480");
    return res.status(200).json({ found: tvlUsd != null, tvlUsd, ...extra });
  };

  const respondExact = (ckey, tvlUsd, poolAddr, source = "exact-pool") => {
    const extra = { source, poolAddress: poolAddr };
    if (ckey) cacheSet(ckey, tvlUsd, extra);
    return respond(tvlUsd, extra);
  };

  // Pair+fee search ONLY when we could not resolve any pool address for this position
  const finishWithPairFallback = async (ckey, extra = {}) => {
    if (pair) {
      const fb = await tryPairFeeFallback(pair, fee, dexChain, platform);
      if (fb?.tvlUsd != null) {
        if (ckey) cacheSet(ckey, fb.tvlUsd, fb);
        return respond(fb.tvlUsd, { ...fb, fallback: true });
      }
    }
    if (ckey) cacheSet(ckey, null, extra);
    if (!extra.reason) extra.reason = "not found";
    return respond(null, extra);
  };

  // ── Path A: direct pool address ────────────────────────────────────────────
  if (poolAddress && /^0x[0-9a-fA-F]{40}$/.test(poolAddress) && dexChain) {
    const ckey = `pool:${chainKey}:${poolAddress.toLowerCase()}`;
    const cached = cacheGet(ckey);
    if (cached && cached.tvlUsd != null) {
      return respond(cached.tvlUsd, { source: "dexscreener", cached: true });
    }
    const tvlUsd = await getTvlByPoolAddress(poolAddress, dexChain);
    cacheSet(ckey, tvlUsd);
    return respond(tvlUsd, { source: "dexscreener" });
  }

  if (!link) return res.status(400).json({ error: "provide link or poolAddress+chain" });

  // ── Path B: Revert Finance link ────────────────────────────────────────────
  if (link.includes("revert.finance")) {
    const parsed = parseRevertLink(link);
    if (!parsed) return respond(null, { reason: "cannot parse revert link" });

    const { network: linkNetwork, nftId } = parsed;
    const revertNetwork = linkNetwork || CHAIN_TO_REVERT[chainKey] || chainKey;
    const revertProtocol = platformToRevertProtocol(platform);
    const ckey = `v3:revert:${revertNetwork}:${revertProtocol}:${nftId}`;
    const cached = cacheGet(ckey);
    if (cached && cached.tvlUsd != null) {
      return respond(cached.tvlUsd, { source: cached.source || "revert+gecko", cached: true });
    }

    if (!dexChain) return respond(null, { reason: "unsupported chain" });

    const rev = await getRevertPosition(nftId, revertNetwork, revertProtocol);
    const isV4 = revertProtocol.includes("v4");

    if (rev) {
      if (isV4 || rev.pool.length > 42) {
        const uniCkey = `v4:uni:revert:${revertNetwork}:${nftId}`;
        const tvlUsd = await getTvlFromUniswapV4Pool(rev.pool, chainKey);
        if (tvlUsd != null) {
          return respondExact(uniCkey, tvlUsd, rev.pool, "uniswap-v4-gateway");
        }
        if (ckey) cacheSet(ckey, null, { reason: "uniswap v4 pool not found" });
        return respond(null, { reason: "uniswap v4 pool not found", poolId: rev.pool });
      }

      const pairSymbols = parsePairSymbols(pair);
      const overlap = pairSymbols.length ? countSymbolOverlap(rev.symbols, pairSymbols) : 2;
      if (overlap > 0) {
        const tvlUsd = await getTvlByPoolAddress(rev.pool, dexChain);
        return respondExact(ckey, tvlUsd, rev.pool, "revert+gecko");
      }
    }

    const onchain = await resolvePoolOnChain(nftId, chainKey, revertProtocol);
    if (onchain) {
      const tvlUsd = await getTvlByPoolAddress(onchain.pool, dexChain);
      return respondExact(ckey, tvlUsd, onchain.pool, "onchain+gecko");
    }

    return finishWithPairFallback(ckey, { reason: "revert position not found" });
  }

  // ── Path C: Krystal link → on-chain NFPM → Factory → DexScreener ──────────
  if (link.includes("krystal.app")) {
    const parsed = parseKrystalLink(link);
    if (!parsed) return respond(null, { reason: "cannot parse krystal link" });

    const { chainId, nfpm, tokenId } = parsed;
    const resolvedChain = CHAIN_ID_TO_KEY[chainId] || chainKey;
    const resolvedDex = CHAIN_TO_DEXSCREENER[resolvedChain];
    const ckey = `v3:krystal:${resolvedChain}:${nfpm}:${tokenId}`;
    const cached = cacheGet(ckey);
    if (cached && cached.tvlUsd != null) {
      return respond(cached.tvlUsd, { source: "onchain+dexscreener", cached: true });
    }
    // Retry with pair fallback if previous attempt cached null
    if (cached && cached.tvlUsd == null && pair) {
      const fb = await tryPairFeeFallback(pair, fee, resolvedDex, platform);
      if (fb?.tvlUsd != null) {
        cacheSet(ckey, fb.tvlUsd, fb);
        return respond(fb.tvlUsd, { ...fb, fallback: true, cached: false });
      }
    }

    if (!resolvedDex || !CHAIN_TO_RPC[resolvedChain]) {
      return respond(null, { reason: "unsupported chain" });
    }

    if (isUniswapV4Platform(platform)) {
      const uniCkey = `v4:uni:krystal:${resolvedChain}:${tokenId}`;
      const cachedUni = cacheGet(uniCkey);
      if (cachedUni && cachedUni.tvlUsd != null) {
        return respond(cachedUni.tvlUsd, {
          source: "uniswap-v4-gateway",
          cached: true,
          poolAddress: cachedUni.poolAddress,
        });
      }
      const poolId = await resolveUniswapV4PoolId(tokenId, resolvedChain);
      if (poolId) {
        const tvlUsd = await getTvlFromUniswapV4Pool(poolId, resolvedChain);
        if (tvlUsd != null) {
          return respondExact(uniCkey, tvlUsd, poolId, "uniswap-v4-gateway");
        }
      }
      if (ckey) cacheSet(ckey, null, { reason: "uniswap v4 pool not found" });
      return respond(null, { reason: "uniswap v4 pool not found" });
    }

    const isV4Nfpm = platform.toLowerCase().includes("v4");
    if (isV4Nfpm) {
      const posV4 = await getPositionDataV4(nfpm, tokenId, resolvedChain);
      const feeStr = posV4?.fee != null ? `${posV4.fee}%` : fee || "";
      const searchPair = pair || pairFromV4Meta(posV4?.pairName) || "";
      const fb = await getTvlByPairFeeSearch(searchPair, feeStr, resolvedDex, platform);
      if (fb?.tvlUsd != null) {
        if (ckey) cacheSet(ckey, fb.tvlUsd, fb);
        return respond(fb.tvlUsd, fb);
      }
      if (feeStr !== fee && fee) {
        const fb2 = await getTvlByPairFeeSearch(searchPair, fee, resolvedDex, platform);
        if (fb2?.tvlUsd != null) {
          if (ckey) cacheSet(ckey, fb2.tvlUsd, fb2);
          return respond(fb2.tvlUsd, fb2);
        }
      }
      return finishWithPairFallback(ckey, { reason: "v4 pool not found" });
    }

    // Step 1: get token0, token1, fee/tickSpacing from NFPM (V3-style)
    let pos = await getPositionData(nfpm, tokenId, resolvedChain);
    const isAero = isAerodromePlatform(platform, nfpm);

    if (!pos) {
      return finishWithPairFallback(ckey, { reason: "nfpm lookup failed" });
    }

    const factory = NFPM_TO_FACTORY[nfpm.toLowerCase()];
    let resolvedFactory = factory;
    if (!resolvedFactory) {
      const factoryResult = await ethCall(resolvedChain, nfpm, "0xc45a0155");
      resolvedFactory = factoryResult ? "0x" + factoryResult.slice(-40) : null;
      if (!resolvedFactory || resolvedFactory === "0x0000000000000000000000000000000000000000") {
        return finishWithPairFallback(ckey, { reason: "unknown nfpm factory" });
      }
    }

    const spacingOrFee = pos.fee;
    let poolAddr = await getPoolFromFactory(
      resolvedFactory,
      pos.token0,
      pos.token1,
      spacingOrFee,
      resolvedChain,
    );

    if (!poolAddr && isAero) {
      for (const ts of [1, 10, 50, 100, 200, 2000, spacingOrFee]) {
        poolAddr = await getPoolFromFactory(
          resolvedFactory,
          pos.token0,
          pos.token1,
          ts,
          resolvedChain,
        );
        if (poolAddr) break;
      }
    }

    if (!poolAddr) {
      return finishWithPairFallback(ckey, { reason: "pool not found in factory" });
    }

    const tvlUsd = await getTvlByPoolAddress(poolAddr, resolvedDex);
    return respondExact(ckey, tvlUsd, poolAddr, "onchain+gecko");
  }

  return respond(null, { reason: "unrecognised link type" });
};
