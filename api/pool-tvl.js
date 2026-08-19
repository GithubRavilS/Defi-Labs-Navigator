/**
 * GET /api/pool-tvl
 *
 * Returns the EXACT TVL of a liquidity pool position.
 *
 * Resolution pipeline:
 *   A. revert.finance link  → Revert API → pool address → DexScreener
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
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": "defilabs-navigator/3.0", Accept: "application/json" },
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

function httpsPost(url, body, { timeout = 10000 } = {}) {
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
  return v && Date.now() - v.ts < CACHE_TTL_MS ? v : null;
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

function platformToRevertProtocol(platform) {
  const p = (platform || "").toLowerCase().replace(/\s+/g, "");
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

  // ── Path A: direct pool address ────────────────────────────────────────────
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
      cacheSet(ckey, null);
      return respond(null, { reason: "not found in revert" });
    }
    const tvlUsd = await getTvlByPoolAddress(poolAddr, dexChain);
    cacheSet(ckey, tvlUsd, { poolAddress: poolAddr });
    return respond(tvlUsd, { source: "revert+dexscreener", poolAddress: poolAddr });
  }

  // ── Path C: Krystal link → on-chain NFPM → Factory → DexScreener ──────────
  if (link.includes("krystal.app")) {
    const parsed = parseKrystalLink(link);
    if (!parsed) return respond(null, { reason: "cannot parse krystal link" });

    const { chainId, nfpm, tokenId } = parsed;
    const resolvedChain = CHAIN_ID_TO_KEY[chainId] || chainKey;
    const resolvedDex = CHAIN_TO_DEXSCREENER[resolvedChain];
    const ckey = `krystal:${resolvedChain}:${nfpm}:${tokenId}`;
    const cached = cacheGet(ckey);
    if (cached) return respond(cached.tvlUsd, { source: "onchain+dexscreener", cached: true });

    if (!resolvedDex || !CHAIN_TO_RPC[resolvedChain]) {
      return respond(null, { reason: "unsupported chain" });
    }

    // Step 1: get token0, token1, fee from NFPM
    const pos = await getPositionData(nfpm, tokenId, resolvedChain);
    if (!pos) {
      cacheSet(ckey, null);
      return respond(null, { reason: "nfpm lookup failed" });
    }

    // Step 2: find the factory for this NFPM
    const factory = NFPM_TO_FACTORY[nfpm.toLowerCase()];
    if (!factory) {
      // Unknown NFPM — fall back to factory() call on NFPM contract
      // (some contracts expose factory())
      const factoryResult = await ethCall(resolvedChain, nfpm, "0xc45a0155");
      const fallbackFactory = factoryResult ? "0x" + factoryResult.slice(-40) : null;
      if (!fallbackFactory || fallbackFactory === "0x0000000000000000000000000000000000000000") {
        cacheSet(ckey, null);
        return respond(null, { reason: "unknown nfpm factory" });
      }
      const poolAddr = await getPoolFromFactory(
        fallbackFactory,
        pos.token0,
        pos.token1,
        pos.fee,
        resolvedChain,
      );
      if (!poolAddr) {
        cacheSet(ckey, null);
        return respond(null, { reason: "pool not found in factory" });
      }
      const tvlUsd = await getTvlByPoolAddress(poolAddr, resolvedDex);
      cacheSet(ckey, tvlUsd, { poolAddress: poolAddr });
      return respond(tvlUsd, {
        source: "onchain+dexscreener",
        poolAddress: poolAddr,
        feeBps: pos.fee,
      });
    }

    // Step 3: Factory.getPool(token0, token1, fee) → exact pool address
    const poolAddr = await getPoolFromFactory(
      factory,
      pos.token0,
      pos.token1,
      pos.fee,
      resolvedChain,
    );
    if (!poolAddr) {
      cacheSet(ckey, null);
      return respond(null, { reason: "pool not found in factory" });
    }

    // Step 4: DexScreener by exact pool address
    const tvlUsd = await getTvlByPoolAddress(poolAddr, resolvedDex);
    cacheSet(ckey, tvlUsd, { poolAddress: poolAddr });
    return respond(tvlUsd, {
      source: "onchain+dexscreener",
      poolAddress: poolAddr,
      feeBps: pos.fee,
    });
  }

  return respond(null, { reason: "unrecognised link type" });
};
