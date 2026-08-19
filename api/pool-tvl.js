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

// Fee tier normalisation: "500" bps → "0.05%", "3000" → "0.3%", etc.
function normalizeFee(fee) {
  if (!fee) return null;
  const s = String(fee).trim();
  if (s.endsWith("%")) return s; // already "0.05%"
  const bps = parseFloat(s);
  if (!isNaN(bps) && bps > 1) {
    // bps → percent
    return (bps / 10000).toFixed(4).replace(/\.?0+$/, "") + "%";
  }
  return s;
}

// Project slug hints — Krystal protocol key → DeFiLlama project slugs
const PROTOCOL_TO_LLAMA = {
  uniswapv3: ["uniswap-v3"],
  uniswapv4: ["uniswap-v4"],
  pancakev3: ["pancakeswap-amm-v3"],
  pancakev4: ["pancakeswap-amm", "pancakeswap-amm-v3"],
  pancakev2: ["pancakeswap-amm"],
  "aerodrome-concentrated": ["aerodrome-slipstream"],
  aerodromev2: ["aerodrome-slipstream"],
  aerodromev1: ["aerodrome-v1"],
  // revert exchange names
  uniswapv4: ["uniswap-v4"],
  uniswapv3: ["uniswap-v3"],
};

function fetchDeFiLlamaPools() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      "https://yields.llama.fi/pools",
      { headers: { "Accept-Encoding": "gzip, deflate", Accept: "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body);
            resolve(parsed.data || []);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(20000, () => {
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
  const sym0 = (token0 || "").toUpperCase().trim();
  const sym1 = (token1 || "").toUpperCase().trim();
  const symsSet = new Set([sym0, sym1]);

  // Allowed project slugs
  let allowedProjects = null;
  if (project) {
    const slug = (project || "").toLowerCase();
    allowedProjects = PROTOCOL_TO_LLAMA[slug] ||
      Object.entries(PROTOCOL_TO_LLAMA).find(([k]) => slug.includes(k))?.[1] || [slug];
  }

  let bestMatch = null;
  let bestScore = -1;

  for (const p of pools) {
    if (!llamaChainMatches(p.chain, chain)) continue;
    if (allowedProjects && !allowedProjects.includes(p.project)) continue;

    // Symbol matching — DeFiLlama stores "USDC-WETH" or "WETH-USDC"
    const parts = (p.symbol || "").toUpperCase().split("-");
    if (parts.length < 2) continue;
    const partsSet = new Set(parts);
    const symOverlap = [...symsSet].filter((t) => partsSet.has(t)).length;
    if (symOverlap < 2) continue;

    let score = symOverlap * 10;
    if (feeNorm && p.poolMeta) {
      if (p.poolMeta === feeNorm) score += 5;
    } else if (!feeNorm) {
      score += 1; // no fee filter — small bonus
    }
    // prefer higher TVL when scores tie
    score += Math.log10((p.tvlUsd || 1) + 1) * 0.01;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
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
