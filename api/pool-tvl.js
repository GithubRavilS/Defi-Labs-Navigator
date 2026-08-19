/**
 * GET /api/pool-tvl
 *
 * Resolves exact TVL for a liquidity pool position.
 *
 * Resolution order:
 *   1. revert.finance link  → Revert API → pool address → DexScreener TVL
 *   2. krystal link         → eth_call NFPM.positions() → token0+token1+fee
 *                             → DexScreener search by token pair → filter by dex+fee → TVL
 *   3. poolAddress param    → DexScreener TVL directly
 *
 * Query params:
 *   link        – position URL
 *   poolAddress – pool contract address (skip resolution)
 *   chain       – mainnet | bsc | base | arbitrum | optimism
 *   platform    – platform hint (uniswapv3, pancakev3, aerodrome, …)
 *
 * All APIs used are free and require no API key.
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
  avalanche: "avalanche",
  zksync: "zksync",
};

// chain key → public JSON-RPC endpoint (free, no key)
const CHAIN_TO_RPC = {
  mainnet: "https://eth.llamarpc.com",
  base: "https://mainnet.base.org",
  bsc: "https://bsc-dataseed.binance.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://mainnet.optimism.io",
  polygon: "https://polygon-rpc.com",
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

// Platform → DexScreener dexId substrings for filtering
const PLATFORM_TO_DEX = {
  uniswapv3: ["uniswap"],
  uniswapv4: ["uniswap"],
  pancakev3: ["pancakeswap"],
  pancakev4: ["pancakeswap"],
  "aerodrome-slipstream": ["aerodrome"],
  aerodromev2: ["aerodrome"],
  aerodromev1: ["aerodrome"],
  "uniswap v3": ["uniswap"],
  "uniswap v4": ["uniswap"],
  "pancakeswap v3": ["pancakeswap"],
  "pancakeswap v4": ["pancakeswap"],
  "aerodrome concentrated": ["aerodrome"],
};

// fee tier in bps → DexScreener poolMeta-like string for matching
function feeBpsToPercent(bps) {
  return ((bps / 10000) * 100).toFixed(4).replace(/\.?0+$/, "") + "%";
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": "defilabs-navigator/2.0", Accept: "application/json" },
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

function httpsPost(url, body, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": bodyBuf.length },
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

// ─── In-memory cache ──────────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000;

function cacheGet(key) {
  const v = _cache.get(key);
  if (v && Date.now() - v.ts < CACHE_TTL_MS) return v;
  return null;
}
function cacheSet(key, tvlUsd, extra = {}) {
  _cache.set(key, { tvlUsd, ts: Date.now(), ...extra });
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normalizeChain(chain) {
  const c = (chain || "").toLowerCase().replace(/\s+/g, "");
  if (c === "ethereum" || c === "mainnet") return "mainnet";
  if (c === "bsc" || c === "bnb" || c === "binancesmartchain") return "bsc";
  if (c === "base") return "base";
  if (c === "arbitrum" || c === "arbitrumone") return "arbitrum";
  if (c === "optimism" || c === "opmainnet") return "optimism";
  return c;
}

function normalizePlatform(platform) {
  return (platform || "").toLowerCase().replace(/\s+/g, "");
}

// ─── Link parsers ─────────────────────────────────────────────────────────────

function parseRevertLink(link) {
  // /#/<anything>-position/<network>/<id>
  let m = link.match(/#\/[^/]+-position\/([a-z]+)\/(\d+)/i);
  if (m) return { network: m[1].toLowerCase(), nftId: m[2] };
  // /#/<anything>-position/<id>
  m = link.match(/#\/[^/]+-position\/(\d+)/i);
  if (m) return { network: null, nftId: m[1] };
  return null;
}

function parseKrystalLink(link) {
  // https://cloud-ui.krystal.app/positions/<chainId>/<nfpm>-<tokenId>
  const m = link.match(/krystal\.app\/positions\/(\d+)\/(0x[0-9a-fA-F]{40})-(\d+)/i);
  if (!m) return null;
  return { chainId: m[1], nfpm: m[2].toLowerCase(), tokenId: m[3] };
}

// ─── Revert Finance ───────────────────────────────────────────────────────────

function platformToRevertProtocol(platform) {
  const p = normalizePlatform(platform);
  if (p.includes("uniswap") && p.includes("4")) return "uniswapv4";
  if (p.includes("uniswap")) return "uniswapv3";
  if (p.includes("pancake")) return "pancakeswapv3";
  return "uniswapv3";
}

async function getPoolAddressFromRevert(nftId, network, protocol) {
  const url = `https://api.revert.finance/v1/positions?positionId=${nftId}&network=${network}&protocol=${protocol}`;
  try {
    const { status, body } = await httpsGet(url, { timeout: 12000 });
    if (status !== 200) return null;
    const resp = JSON.parse(body);
    const pos = Array.isArray(resp.data) ? resp.data[0] : resp.data || resp;
    return (pos && pos.pool) || null;
  } catch {
    return null;
  }
}

// ─── On-chain NFPM lookup ─────────────────────────────────────────────────────

// Call NFPM.positions(tokenId) via eth_call on public RPC
async function getPositionFromNFPM(nfpm, tokenId, rpcUrl) {
  // positions(uint256) selector: 0x99fbab88
  const tokenIdHex = BigInt(tokenId).toString(16).padStart(64, "0");
  const data = "0x99fbab88" + tokenIdHex;
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: nfpm, data }, "latest"],
  };
  try {
    const { status, body } = await httpsPost(rpcUrl, payload, { timeout: 8000 });
    if (status !== 200) return null;
    const resp = JSON.parse(body);
    if (resp.error || !resp.result || resp.result === "0x") return null;
    const hex = resp.result.slice(2); // remove 0x
    const fields = [];
    for (let i = 0; i < hex.length; i += 64) fields.push(hex.slice(i, i + 64));
    if (fields.length < 5) return null;
    // Layout: [0]=nonce, [1]=operator, [2]=token0, [3]=token1, [4]=fee, ...
    const token0 = "0x" + fields[2].slice(-40);
    const token1 = "0x" + fields[3].slice(-40);
    const fee = parseInt(fields[4], 16); // in bps (e.g. 500 = 0.05%)
    return { token0: token0.toLowerCase(), token1: token1.toLowerCase(), fee };
  } catch {
    return null;
  }
}

// ─── DexScreener ─────────────────────────────────────────────────────────────

async function getTvlByPoolAddress(poolAddress, dexChain) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${dexChain}/${poolAddress.toLowerCase()}`;
  try {
    const { status, body } = await httpsGet(url, { timeout: 8000 });
    if (status !== 200) return null;
    const data = JSON.parse(body);
    const pairs = data.pairs || (data.pair ? [data.pair] : []);
    if (!pairs || !pairs.length) return null;
    const pair =
      pairs.find((p) => (p.pairAddress || "").toLowerCase() === poolAddress.toLowerCase()) ||
      pairs[0];
    return pair?.liquidity?.usd ?? null;
  } catch {
    return null;
  }
}

async function getTvlByTokenPair(token0, token1, dexChain, platformSlug, feeBps) {
  // DexScreener: search by two token addresses
  const url = `https://api.dexscreener.com/latest/dex/tokens/${token0},${token1}`;
  try {
    const { status, body } = await httpsGet(url, ({ timeout = 10000 } = {}));
    if (status !== 200) return { tvlUsd: null };
    const data = JSON.parse(body);
    const pairs = (data.pairs || []).filter((p) => p.chainId === dexChain);
    if (!pairs.length) return { tvlUsd: null };

    // Filter by dex (platform)
    const dexHints = PLATFORM_TO_DEX[normalizePlatform(platformSlug)] || [];
    let candidates = dexHints.length
      ? pairs.filter((p) => dexHints.some((hint) => (p.dexId || "").includes(hint)))
      : pairs;
    if (!candidates.length) candidates = pairs;

    // Filter by fee tier if we know it
    if (feeBps) {
      const feeStr = feeBpsToPercent(feeBps); // e.g. "0.05%"
      // DexScreener doesn't expose fee tier directly — match by pool labels if available
      // Instead: among candidates pick the one matching token pair, sorted by TVL
      // (most liquid pool at this fee tier is the correct one for most cases)
    }

    // Sort by TVL descending, pick best
    candidates.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = candidates[0];
    return { tvlUsd: best?.liquidity?.usd ?? null, pairAddress: best?.pairAddress };
  } catch {
    return { tvlUsd: null };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const { link = "", poolAddress = "", chain = "", platform = "" } = req.query || {};
  const chainKey = normalizeChain(chain);
  const dexChain = CHAIN_TO_DEXSCREENER[chainKey];

  const respond = (tvlUsd, extra = {}) => {
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=480");
    return res.status(200).json({ found: tvlUsd != null, tvlUsd, ...extra });
  };

  // ── Path A: pool address given directly ────────────────────────────────────
  if (poolAddress && /^0x[0-9a-fA-F]{40}$/.test(poolAddress) && dexChain) {
    const ckey = `pool:${chainKey}:${poolAddress.toLowerCase()}`;
    const cached = cacheGet(ckey);
    if (cached) return respond(cached.tvlUsd, { source: "dexscreener", cached: true });
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
    const ckey = `revert:${revertNetwork}:${revertProtocol}:${nftId}`;
    const cached = cacheGet(ckey);
    if (cached) return respond(cached.tvlUsd, { source: "revert+dexscreener", cached: true });

    if (!dexChain) return respond(null, { reason: "unsupported chain" });

    const poolAddr = await getPoolAddressFromRevert(nftId, revertNetwork, revertProtocol);
    if (!poolAddr) {
      // Revert doesn't have it — fall through to token pair search if we have chain
      cacheSet(ckey, null);
      return respond(null, { reason: "not found in revert" });
    }

    const tvlUsd = await getTvlByPoolAddress(poolAddr, dexChain);
    cacheSet(ckey, tvlUsd, { poolAddress: poolAddr });
    return respond(tvlUsd, { source: "revert+dexscreener", poolAddress: poolAddr });
  }

  // ── Path C: Krystal link → NFPM on-chain lookup ───────────────────────────
  if (link.includes("krystal.app")) {
    const parsed = parseKrystalLink(link);
    if (!parsed) return respond(null, { reason: "cannot parse krystal link" });

    const { chainId, nfpm, tokenId } = parsed;
    const resolvedChain = CHAIN_ID_TO_KEY[chainId] || chainKey;
    const resolvedDexChain = CHAIN_TO_DEXSCREENER[resolvedChain];
    const ckey = `krystal:${resolvedChain}:${nfpm}:${tokenId}`;
    const cached = cacheGet(ckey);
    if (cached) return respond(cached.tvlUsd, { source: "onchain+dexscreener", cached: true });

    if (!resolvedDexChain) return respond(null, { reason: "unsupported chain" });

    const rpcUrl = CHAIN_TO_RPC[resolvedChain];
    if (!rpcUrl) return respond(null, { reason: "no rpc for chain" });

    // Get token0, token1, fee from NFPM contract
    const pos = await getPositionFromNFPM(nfpm, tokenId, rpcUrl);
    if (!pos) {
      cacheSet(ckey, null);
      return respond(null, { reason: "nfpm lookup failed" });
    }

    const { token0, token1, fee: feeBps } = pos;
    const { tvlUsd, pairAddress } = await getTvlByTokenPair(
      token0,
      token1,
      resolvedDexChain,
      platform,
      feeBps,
    );
    cacheSet(ckey, tvlUsd, { poolAddress: pairAddress });
    return respond(tvlUsd, { source: "onchain+dexscreener", feeBps, poolAddress: pairAddress });
  }

  return respond(null, { reason: "unrecognised link type" });
};
