#!/usr/bin/env node
/**
 * End-to-end TVL coverage test for all LP tools in sheet-data.
 * Usage: node scripts/test-pool-tvl-coverage.mjs [baseUrl]
 */
const BASE = process.argv[2] || "https://defilabsvipnavigator.vercel.app";

function normChain(chain) {
  const c = (chain || "").toLowerCase().replace(/\s+/g, "");
  if (c === "ethereum" || c === "mainnet") return "mainnet";
  if (c === "bsc" || c === "bnb" || c === "binancesmartchain") return "bsc";
  if (c === "base") return "base";
  if (c === "arbitrum" || c === "arbitrumone") return "arbitrum";
  if (c === "optimism" || c === "opmainnet") return "optimism";
  return c;
}

function tvlKey(tool) {
  const link = (tool.link || "").trim();
  const chainKey = normChain(tool.chain);
  if (link.includes("revert.finance")) {
    const m = link.match(/position\/(?:[a-z]+\/)?(\d+)/i);
    return m ? `revert:${chainKey}:${m[1]}` : null;
  }
  if (link.includes("krystal.app")) {
    const m = link.match(/krystal\.app\/positions\/(\d+)\/(0x[0-9a-fA-F]{40})-(\d+)/i);
    return m ? `krystal:${m[1]}:${m[2].toLowerCase()}:${m[3]}` : null;
  }
  return null;
}

function tvlUrl(tool) {
  const link = (tool.link || "").trim();
  const chainKey = normChain(tool.chain);
  if (!link || (!link.includes("revert.finance") && !link.includes("krystal.app"))) return null;
  const q = new URLSearchParams({
    link,
    chain: chainKey,
    platform: tool.platform || "",
    _: String(Date.now()),
  });
  return `${BASE}/api/pool-tvl?${q}`;
}

async function main() {
  const sheetRes = await fetch(`${BASE}/api/sheet-data`);
  const sheet = await sheetRes.json();
  const tools = (sheet.tools || []).filter(
    (t) => (t.link || "").includes("revert.finance") || (t.link || "").includes("krystal.app"),
  );

  const byKey = new Map();
  for (const t of tools) {
    const key = tvlKey(t);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, t);
  }

  const unique = [...byKey.entries()];
  console.log(`Testing ${unique.length} unique LP positions (${tools.length} total rows)...\n`);

  let ok = 0;
  let fail = 0;
  let noKey = 0;
  const failures = [];

  for (const [key, tool] of unique) {
    if (!key) {
      noKey++;
      failures.push({ pair: tool.pair, reason: "no tvlKey" });
      continue;
    }
    const url = tvlUrl(tool);
    try {
      const r = await fetch(url);
      const data = await r.json();
      if (data.found && data.tvlUsd != null) {
        ok++;
        console.log(
          `✓ ${tool.pair?.padEnd(22)} ${normChain(tool.chain).padEnd(10)} $${Math.round(data.tvlUsd).toLocaleString()}`,
        );
      } else {
        fail++;
        failures.push({
          pair: tool.pair,
          chain: tool.chain,
          platform: tool.platform,
          reason: data.reason || "not found",
          link: tool.link,
        });
        console.log(
          `✗ ${tool.pair?.padEnd(22)} ${normChain(tool.chain).padEnd(10)} ${data.reason || "not found"}`,
        );
      }
    } catch (e) {
      fail++;
      failures.push({ pair: tool.pair, reason: e.message });
      console.log(`✗ ${tool.pair?.padEnd(22)} error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  console.log(`\n--- Summary ---`);
  console.log(`OK: ${ok}/${unique.length} (${((ok / unique.length) * 100).toFixed(0)}%)`);
  console.log(`Missing: ${fail}`);
  console.log(`No key: ${noKey}`);

  if (failures.length) {
    console.log(`\nFailures detail:`);
    for (const f of failures.slice(0, 15)) {
      console.log(`  ${f.pair} (${f.chain}) — ${f.reason}`);
    }
  }

  process.exit(fail > 0 || noKey > 0 ? 1 : 0);
}

main();
