/**
 * GET /api/pool-tvl
 *
 * Returns the exact TVL of a liquidity pool using DexScreener (by pool address).
 * Pool address is resolved via:
 *   1. Direct poolAddress param (if caller already has it, e.g. from Krystal)
 *   2. Revert Finance API (for Revert-linked positions: uniswap v3/v4, pancakeswap v3)
 *
 * Query params:
 *   link         - position URL (revert.finance or cloud-ui.krystal.app)
 *   poolAddress  - pool contract address (optional, skips Revert lookup)
 *   chain        - mainnet | bsc | base | arbitrum | optimism (required if poolAddress given)
 *
 * DexScreener is free, no API key. Revert Finance public API is free, no key.
 */

const https = require("https");

// Our chain key → DexScreener network slug
const CHAIN_TO_DEXSCREENER = {
  mainnet: "ethereum",
  ethereum: "ethereum",
  bsc: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  "op mainnet": "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  zksync: "zksync",
};

// Revert Finance: our chain key → Revert network name
const CHAIN_TO_REVERT = {
  mainnet: "mainnet",
  ethereum: "mainnet",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
};

// Revert Finance: our chain+protocol → Revert protocol slug
const PLATFORM_TO_REVERT_PROTOCOL = {
  uniswapv3: "uniswapv3",
  uniswapv4: "uniswapv4",
  pancakev3: "pancakeswapv3",
  "uniswap v3": "uniswapv3",
  "uniswap v4": "uniswapv4",
  "pancakeswap v3": "pancakeswapv3",
};

// In-memory cache: poolAddr_chain → { tvlUsd, ts }
const _cache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000; // 8 min

function httpsGet(url, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "defilabs-navigator/1.0", Accept: "application/json" } },
      (res) => {
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
      },
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/**
 * Extract (network, nftId) from a Revert Finance URL.
 * Formats:
 *   /#/uniswap-position/optimism/1089241  → { network: "optimism", nftId: "1089241" }
 *   /#/uniswapv3-position/329542          → { network: null (use chain param), nftId: "329542" }
 *   /#/uniswapv4-position/mainnet/12345   → { network: "mainnet", nftId: "12345" }
 */
function parseRevertLink(link) {
  // New format: /#/<anything>-position/<network>/<id>
  let m = link.match(/#\/[^/]+-position\/([a-z]+)\/(\d+)/i);
  if (m) return { network: m[1].toLowerCase(), nftId: m[2] };
  // Old format: /#/<anything>-position/<id>
  m = link.match(/#\/[^/]+-position\/(\d+)/i);
  if (m) return { network: null, nftId: m[1] };
  // Catch-all: last numeric segment
  m = link.match(/\/(\d{4,})\s*$/);
  if (m) return { network: null, nftId: m[1] };
  return null;
}

/**
 * Extract pool address from a Krystal cloud-ui link.
 * Links contain the position ID which encodes NFPM+tokenId, not pool address directly.
 * We'll use poolAddress param instead for Krystal.
 */
function parseKrystalLink(link) {
  // https://cloud-ui.krystal.app/positions/56/0xNFPM-tokenId
  const m = link.match(/krystal\.app\/positions\/(\d+)\/(0x[0-9a-fA-F]+)-(\d+)/i);
  if (!m) return null;
  return { chainId: m[1], nfpm: m[2], tokenId: m[3] };
}

/**
 * Get pool address via Revert Finance API.
 * Returns pool contract address string or null.
 * Revert response: { success, total_count, data: [ { pool, exchange, fee_tier, ... } ] }
 */
async function getPoolAddressFromRevert(nftId, revertNetwork, revertProtocol) {
  const url = `https://api.revert.finance/v1/positions?positionId=${nftId}&network=${revertNetwork}&protocol=${revertProtocol}`;
  try {
    const { status, body } = await httpsGet(url, { timeout: 12000 });
    if (status !== 200) return null;
    const resp = JSON.parse(body);
    // data is an array of positions
    const pos = Array.isArray(resp.data) ? resp.data[0] : resp.data || resp;
    return (pos && pos.pool) || null;
  } catch {
    return null;
  }
}

/**
 * Get TVL from DexScreener by pool address + chain.
 * Returns number (USD) or null.
 */
async function getTvlFromDexScreener(poolAddress, dexChain) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${dexChain}/${poolAddress}`;
  try {
    const { status, body } = await httpsGet(url, { timeout: 8000 });
    if (status !== 200) return null;
    const data = JSON.parse(body);
    const pairs = data.pairs || (data.pair ? [data.pair] : []);
    if (!pairs || !pairs.length) return null;
    // If multiple pairs (rare), pick the one with matching address
    const pair =
      pairs.find((p) => (p.pairAddress || "").toLowerCase() === poolAddress.toLowerCase()) ||
      pairs[0];
    return pair?.liquidity?.usd ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalise chain string from frontend → our internal key.
 */
function normalizeChain(chain) {
  const c = (chain || "").toLowerCase().trim();
  if (c === "ethereum" || c === "mainnet") return "mainnet";
  if (c === "bsc" || c === "bnb" || c === "binance smart chain" || c === "binancesmartchain")
    return "bsc";
  return c;
}

/**
 * Normalise platform string → revert protocol slug.
 */
function platformToRevertProtocol(platform) {
  const p = (platform || "").toLowerCase().replace(/\s+/g, "");
  for (const [k, v] of Object.entries(PLATFORM_TO_REVERT_PROTOCOL)) {
    if (p.includes(k.replace(/\s+/g, ""))) return v;
  }
  // fallback guesses
  if (p.includes("uniswap") && p.includes("4")) return "uniswapv4";
  if (p.includes("uniswap")) return "uniswapv3";
  if (p.includes("pancake")) return "pancakeswapv3";
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const { link = "", poolAddress = "", chain = "", platform = "" } = req.query || {};
  const chainKey = normalizeChain(chain);
  const dexChain = CHAIN_TO_DEXSCREENER[chainKey];

  // ── Path 1: caller provides pool address directly (Krystal rows) ──────────
  if (poolAddress && /^0x[0-9a-fA-F]{40}$/.test(poolAddress) && dexChain) {
    const cacheKey = `${poolAddress.toLowerCase()}:${chainKey}`;
    const cached = _cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=480");
      return res
        .status(200)
        .json({
          found: cached.tvlUsd != null,
          tvlUsd: cached.tvlUsd,
          source: "dexscreener",
          cached: true,
        });
    }

    const tvlUsd = await getTvlFromDexScreener(poolAddress, dexChain);
    _cache.set(cacheKey, { tvlUsd, ts: Date.now() });
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=480");
    return res.status(200).json({ found: tvlUsd != null, tvlUsd, source: "dexscreener" });
  }

  // ── Path 2: Revert Finance link → pool address → DexScreener ─────────────
  if (link && link.includes("revert.finance")) {
    const parsed = parseRevertLink(link);
    if (!parsed) {
      return res.status(400).json({ error: "cannot parse revert link" });
    }
    const { network: linkNetwork, nftId } = parsed;
    // Use network from URL first (most reliable), fallback to chain param
    const revertNetwork = linkNetwork || CHAIN_TO_REVERT[chainKey] || chainKey;
    const revertProtocol = platformToRevertProtocol(platform) || "uniswapv3";

    const cacheKey = `revert:${revertNetwork}:${revertProtocol}:${nftId}`;
    const cached = _cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=480");
      return res
        .status(200)
        .json({
          found: cached.tvlUsd != null,
          tvlUsd: cached.tvlUsd,
          source: "revert+dexscreener",
          cached: true,
        });
    }

    if (!dexChain) {
      return res.status(200).json({ found: false, tvlUsd: null, reason: "unsupported chain" });
    }

    const poolAddr = await getPoolAddressFromRevert(nftId, revertNetwork, revertProtocol);
    if (!poolAddr) {
      _cache.set(cacheKey, { tvlUsd: null, ts: Date.now() });
      return res
        .status(200)
        .json({ found: false, tvlUsd: null, reason: "pool not found via revert" });
    }

    const tvlUsd = await getTvlFromDexScreener(poolAddr, dexChain);
    _cache.set(cacheKey, { tvlUsd, ts: Date.now() });
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=480");
    return res
      .status(200)
      .json({ found: tvlUsd != null, tvlUsd, poolAddress: poolAddr, source: "revert+dexscreener" });
  }

  return res
    .status(400)
    .json({ error: "provide either poolAddress+chain or a revert.finance link+chain" });
};
