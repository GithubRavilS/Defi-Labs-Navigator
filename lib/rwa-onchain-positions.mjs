/**
 * RWA LP positions via Solana RPC + Raydium dynamic-ipfs + Orca pools API.
 * Works when Jupiter Portfolio REST returns elements=[].
 */
import { PublicKey } from "@solana/web3.js";

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const ORCA_WHIRL = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

async function rpc(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "RPC error");
  return data.result;
}

function readU64(buf, off) {
  const v = buf.readBigUInt64LE(off);
  return Number(v);
}

function readPubkey(buf, off) {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

function deriveRaydiumPositionPda(nftMint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), new PublicKey(nftMint).toBuffer()],
    RAYDIUM_CLMM,
  );
  return pda.toBase58();
}

function deriveOrcaPositionPda(nftMint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), new PublicKey(nftMint).toBuffer()],
    ORCA_WHIRL,
  );
  return pda.toBase58();
}

async function listPositionNftMints(wallet) {
  const result = await rpc("getTokenAccountsByOwner", [
    wallet,
    { programId: TOKEN_2022 },
    { encoding: "jsonParsed" },
  ]);
  const mints = [];
  for (const row of result.value || []) {
    const info = row.account?.data?.parsed?.info;
    const amt = info?.tokenAmount;
    if (Number(amt?.uiAmount) === 1 && Number(amt?.decimals) === 0 && info?.mint) {
      mints.push(info.mint);
    }
  }
  return mints;
}

async function fetchRaydiumPosition(nftMint, wallet) {
  const posId = deriveRaydiumPositionPda(nftMint);
  const res = await fetch(`https://dynamic-ipfs.raydium.io/clmm/position?id=${posId}`);
  if (!res.ok) return null;
  const data = await res.json();
  const pi = data.poolInfo || {};
  const pos = data.positionInfo || {};
  const symA = pi.mintA?.symbol || "?";
  const symB = pi.mintB?.symbol || "?";
  const pair = `${symA} / ${symB}`;
  if (/\b(ETH|WETH|BTC|WBTC)\b/i.test(pair) && !/x/i.test(pair)) return null;
  const apyPct = pi.day?.apr != null ? Number(pi.day.apr) : 0;
  const fee = pi.feeRate != null ? `${(Number(pi.feeRate) * 100).toFixed(2)}%` : "";
  const fees = pos.unclaimedFee || {};
  const slug = `Raydium-${pair}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    platform: "Raydium",
    pair,
    apy: `${Math.round(apyPct * 100) / 100}%`,
    link: `https://jup.ag/portfolio/${wallet}#${slug}`,
    investedUsd: Number(pos.usdValue) || 0,
    earnedStables: Number(fees.amountB) && symB === "USDC" ? Number(fees.amountB) : 0,
    earnedAsset: Number(fees.amountA) && symA !== "USDC" ? Number(fees.amountA) : 0,
    earnedAssetSymbol: symA !== "USDC" ? symA : symB !== "USDC" ? symB : "",
    totalFeeIncome: Number(fees.usdValue) || 0,
    chain: "solana",
    fee,
  };
}

async function decodeOrcaPosition(positionAddress) {
  const info = await rpc("getAccountInfo", [positionAddress, { encoding: "base64" }]);
  if (!info?.value?.data?.[0]) return null;
  const buf = Buffer.from(info.value.data[0], "base64");
  if (buf.length < 144) return null;
  const whirlpool = readPubkey(buf, 8);
  const liquidity = bufReadU128(buf, 72);
  const feeA = readU64(buf, 128);
  const feeB = readU64(buf, 136);
  return { whirlpool, liquidity, feeA, feeB, buf };
}

async function fetchOrcaPosition(nftMint, wallet) {
  const posAddr = deriveOrcaPositionPda(nftMint);
  const metaRes = await fetch(`https://metadata.orca.so/positions/${posAddr}`);
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  const name = String(meta.name || "");
  const pairM = name.match(/-\s*([^-]+)\/([^-]+)$/);
  const pair = pairM
    ? `${pairM[1].trim()} / ${pairM[2].trim()}`
    : name.replace(/^Whirlpool\s*-?\s*/i, "");
  const feeM = name.match(/([\d.]+)%/);
  const fee = feeM ? `${feeM[1]}%` : "";

  const decoded = await decodeOrcaPosition(posAddr);
  if (!decoded) return null;
  const poolRes = await fetch(`https://api.orca.so/v2/solana/pools/${decoded.whirlpool}?stats=24h`);
  if (!poolRes.ok) return null;
  const poolJson = await poolRes.json();
  const pool = poolJson.data || poolJson;
  const y24 = Number(pool.stats?.["24h"]?.yieldOverTvl || 0);
  const apyPct = y24 > 0 ? y24 * 365 * 100 : 0;
  const tokenA = pool.tokenA?.symbol || pool.tokenA?.name || "";
  const tokenB = pool.tokenB?.symbol || pool.tokenB?.name || "";
  const decA = pool.tokenA?.decimals ?? 6;
  const decB = pool.tokenB?.decimals ?? 6;
  const feeAUi = decoded.feeA / 10 ** decA;
  const feeBUi = decoded.feeB / 10 ** decB;
  const priceA = Number(pool.tokenA?.price || 0);
  const priceB = Number(pool.tokenB?.price || 0);
  const feeUsd = feeAUi * priceA + feeBUi * priceB;

  let stableUsd = 0;
  let assetAmt = 0;
  let assetSym = "";
  if (/USDC/i.test(tokenA)) stableUsd += feeAUi * priceA;
  else if (tokenA) {
    assetAmt += feeAUi;
    assetSym = tokenA;
  }
  if (/USDC/i.test(tokenB)) stableUsd += feeBUi * priceB;
  else if (tokenB) {
    assetAmt += feeBUi;
    if (!assetSym) assetSym = tokenB;
  }

  const poolLiq = BigInt(pool.liquidity || "0");
  const tvl = Number(pool.tvlUsdc || 0);
  let investedUsd = 0;
  if (poolLiq > 0n && decoded.liquidity > 0n && tvl > 0) {
    investedUsd = tvl * (Number(decoded.liquidity) / Number(poolLiq));
  }
  const slug = `Orca-${pair}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    platform: "Orca",
    pair,
    apy: `${Math.round(apyPct * 100) / 100}%`,
    link: `https://www.orca.so/pools/${decoded.whirlpool}`,
    investedUsd,
    earnedStables: stableUsd,
    earnedAsset: assetAmt,
    earnedAssetSymbol: assetSym,
    totalFeeIncome: feeUsd,
    chain: "solana",
    fee,
  };
}

function bufReadU128(buf, off) {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return hi * 2n ** 64n + lo;
}

async function classifyMint(nftMint) {
  const rayPda = deriveRaydiumPositionPda(nftMint);
  const info = await rpc("getAccountInfo", [rayPda, { encoding: "base64" }]);
  if (info?.value?.owner === RAYDIUM_CLMM.toBase58()) return "raydium";
  const orcaPda = deriveOrcaPositionPda(nftMint);
  const info2 = await rpc("getAccountInfo", [orcaPda, { encoding: "base64" }]);
  if (info2?.value?.owner === ORCA_WHIRL.toBase58()) return "orca";
  return null;
}

export async function fetchRwaPositionsOnchain(wallet) {
  const mints = await listPositionNftMints(wallet);
  const rows = [];
  const seen = new Set();
  for (const mint of mints) {
    const kind = await classifyMint(mint);
    let row = null;
    if (kind === "raydium") row = await fetchRaydiumPosition(mint, wallet);
    else if (kind === "orca") row = await fetchOrcaPosition(mint, wallet);
    if (!row || !row.pair) continue;
    const key = `${row.platform}|${row.pair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  rows.sort((a, b) => parseFloat(b.apy) - parseFloat(a.apy));
  return { wallet, rows, source: "onchain-raydium-orca", count: rows.length };
}

export function rowsToUnifiedSheetLines(rows) {
  const fmt = (n, d = 8) => {
    if (n == null || isNaN(Number(n))) return "";
    const v = Number(n);
    if (v === 0) return "0";
    return String(Math.round(v * 10 ** d) / 10 ** d);
  };
  const now = new Date()
    .toLocaleString("ru-RU", { timeZone: "Europe/Warsaw", hour12: false })
    .replace(",", "");
  return rows.map((r) => [
    r.platform,
    "",
    "",
    now,
    fmt(r.earnedStables),
    fmt(r.earnedAsset, 12),
    r.earnedAssetSymbol || "",
    "",
    fmt(r.totalFeeIncome),
    r.pair,
    r.chain || "solana",
    r.fee || "",
    r.apy,
    r.link,
    fmt(r.investedUsd, 4),
  ]);
}
