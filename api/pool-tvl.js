/**
 * GET /api/pool-tvl?chain=mainnet&token0=USDC&token1=WETH&fee=0.05%&project=uniswap-v3
 *
 * Returns TVL (and volume) for a liquidity pool by matching against DeFiLlama /pools.
 * DeFiLlama is free, no API key required.
 *
 * Cache: DeFiLlama full pool list is fetched at most once per 10 minutes per Vercel instance.
 *
 * Query params:
 *   chain    - mainnet | bsc | base | arbitrum | optimism | polygon (required)
 *   token0   - symbol, e.g. USDC (required)
 *   token1   - symbol, e.g. WETH (required)
 *   fee      - fee tier string, e.g. "0.05%" or "500" bps (optional, improves accuracy)
 *   project  - DeFiLlama project slug hint, e.g. "uniswap-v3" (optional)
 */

const https = require("https");
const zlib = require("zlib");

// In-memory cache for DeFiLlama full pool list
let _cachedPools = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// DeFiLlama chain name → our internal chain key
const LLAMA_CHAIN_MAP = {
  ethereum: "mainnet",
  "bnb chain": "bsc",
  "binance smart chain": "bsc",
  bsc: "bsc",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  "zk sync era": "zksync",
  zksync: "zksync",
};

// Our chain key → set of DeFiLlama chain names
function llamaChainMatches(llamaChain, ourChain) {
  const normalized = (llamaChain || "").toLowerCase();
  const mapped = LLAMA_CHAIN_MAP[normalized] || normalized;
  return mapped === (ourChain || "").toLowerCase();
}

// Fee tier normalisation: "500" bps → "0.05%", "3000" → "0.3%", "0,05%" → "0.05%"
function normalizeFee(fee) {
  if (!fee) return null;
  // Replace Russian/locale comma decimal separator with dot
  let s = String(fee).trim().replace(",", ".");
  if (s.endsWith("%")) {
    // Already percent-formatted — normalize decimal places for comparison
    const num = parseFloat(s);
    if (isNaN(num)) return s;
    // Round to avoid float noise: 0.0500% → "0.05%", 0.3000% → "0.3%"
    return num.toFixed(4).replace(/\.?0+$/, "") + "%";
  }
  const bps = parseFloat(s);
  if (!isNaN(bps) && bps >= 1) {
    return (bps / 10000).toFixed(4).replace(/\.?0+$/, "") + "%";
  }
  return s;
}

// Token symbol aliases — DeFiLlama sometimes uses ETH, sometimes WETH
// Expand a symbol set to include known aliases
function expandSymbolAliases(sym) {
  const s = sym.toUpperCase();
  if (s === "ETH") return [s, "WETH"];
  if (s === "WETH") return [s, "ETH"];
  if (s === "BTC") return [s, "WBTC", "BTCB"];
  if (s === "WBTC") return [s, "BTC", "BTCB"];
  return [s];
}

// Project slug hints — Krystal protocol key → DeFiLlama project slugs
const PROTOCOL_TO_LLAMA = {
  uniswapv3: ["uniswap-v3"],
  uniswapv4: ["uniswap-v4"],
  pancakev3: ["pancakeswap-amm-v3"],
  pancakev4: ["pancakeswap-amm", "pancakeswap-amm-v3"],
  pancakev2: ["pancakeswap-amm"],
  "aerodrome-concentrated": ["aerodrome-slipstream"],
  "aerodrome-slipstream": ["aerodrome-slipstream"],
  aerodromev2: ["aerodrome-slipstream"],
  aerodromev1: ["aerodrome-v1"],
};

function fetchDeFiLlamaPools() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      "https://yields.llama.fi/pools",
      { headers: { "Accept-Encoding": "gzip, deflate, br", Accept: "application/json" } },
      (res) => {
        let stream = res;
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip" || enc === "x-gzip") {
          stream = res.pipe(zlib.createGunzip());
        } else if (enc === "deflate") {
          stream = res.pipe(zlib.createInflate());
        } else if (enc === "br") {
          stream = res.pipe(zlib.createBrotliDecompress());
        }

        const chunks = [];
        stream.on("data", (d) => chunks.push(d));
        stream.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body);
            resolve(parsed.data || []);
          } catch (e) {
            reject(e);
          }
        });
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error("DeFiLlama timeout"));
    });
  });
}

async function getPools() {
  const now = Date.now();
  if (_cachedPools && now - _cacheTs < CACHE_TTL_MS) return _cachedPools;
  const pools = await fetchDeFiLlamaPools();
  _cachedPools = pools;
  _cacheTs = now;
  return pools;
}

function findBestMatch(pools, { chain, token0, token1, fee, project }) {
  const feeNorm = normalizeFee(fee);

  // Expand token symbols with aliases (ETH↔WETH, BTC↔WBTC etc.)
  const sym0Variants = new Set(expandSymbolAliases((token0 || "").trim()));
  const sym1Variants = new Set(expandSymbolAliases((token1 || "").trim()));

  // Allowed project slugs (try with and without restriction)
  let allowedProjects = null;
  if (project) {
    const slug = (project || "").toLowerCase();
    allowedProjects =
      PROTOCOL_TO_LLAMA[slug] ||
      Object.entries(PROTOCOL_TO_LLAMA).find(([k]) => slug.includes(k))?.[1] ||
      null; // if unknown slug, don't restrict
  }

  let bestMatch = null;
  let bestScore = -1;

  // Two passes: first with project filter, then without if nothing found
  const passes = allowedProjects ? [allowedProjects, null] : [null];

  for (const projectFilter of passes) {
    for (const p of pools) {
      if (!llamaChainMatches(p.chain, chain)) continue;
      if (projectFilter && !projectFilter.includes(p.project)) continue;

      // Symbol matching — DeFiLlama stores "USDC-WETH" or "WETH-USDC"
      const parts = (p.symbol || "").toUpperCase().split("-");
      if (parts.length < 2) continue;

      // Check that one part matches sym0 variants and another matches sym1 variants
      // (order-independent)
      const p0 = parts[0];
      const p1 = parts[parts.length - 1]; // for 3-token symbols take last
      const t0match =
        (sym0Variants.has(p0) && sym1Variants.has(p1)) ||
        (sym0Variants.has(p1) && sym1Variants.has(p0));
      if (!t0match) continue;

      let score = 20; // base: both tokens matched

      // Exact symbol match (ETH=ETH) scores higher than alias match (ETH=WETH)
      const sym0Raw = (token0 || "").toUpperCase().trim();
      const sym1Raw = (token1 || "").toUpperCase().trim();
      const exactSyms = new Set([sym0Raw, sym1Raw]);
      const partsSet = new Set([p0, p1]);
      const exactOverlap = [...exactSyms].filter((t) => partsSet.has(t)).length;
      score += exactOverlap * 3;

      // Fee match
      if (feeNorm && p.poolMeta) {
        const pMeta = normalizeFee(p.poolMeta);
        if (pMeta === feeNorm) score += 10;
      }

      // Project filter bonus
      if (!projectFilter) score -= 2; // second pass (no filter) slight penalty

      // Prefer higher TVL when scores tie
      score += Math.log10((p.tvlUsd || 1) + 1) * 0.01;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = p;
      }
    }
    if (bestMatch) break; // found in first pass, skip second
  }
  return bestMatch;
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

  const { chain, token0, token1, fee, project } = req.query || {};
  if (!chain || !token0 || !token1) {
    res.status(400).json({ error: "chain, token0, token1 required" });
    return;
  }

  try {
    const pools = await getPools();
    const match = findBestMatch(pools, { chain, token0, token1, fee, project });

    if (!match) {
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
      res.status(200).json({ found: false, tvlUsd: null });
      return;
    }

    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
    res.status(200).json({
      found: true,
      tvlUsd: match.tvlUsd || null,
      volumeUsd1d: match.volumeUsd1d || null,
      apyBase: match.apyBase || null,
      project: match.project,
      symbol: match.symbol,
      poolMeta: match.poolMeta,
      chain: match.chain,
      llamaPool: match.pool,
    });
  } catch (e) {
    console.error("pool-tvl error", e);
    res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
};
