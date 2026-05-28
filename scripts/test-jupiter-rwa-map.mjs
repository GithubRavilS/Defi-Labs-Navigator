/**
 * Проверка фильтра liquidity pool (логика как в DeFi-Labs-Navigator-AppsScript.js).
 * node scripts/test-jupiter-rwa-map.mjs
 */

function isNavigatorLiquidityElement(el) {
  if (!el) return false;
  if (String(el.networkId || '') !== 'solana') return false;
  const type = String(el.type || '');
  const label = String(el.label || '');
  const pid = String(el.platformId || '').toLowerCase();
  if (type === 'borrowlend') return false;
  if (label === 'Lending') return false;
  if (type === 'liquidity') return true;
  if (label === 'LiquidityPool') return true;
  if (pid.includes('kamino') && type !== 'liquidity') return false;
  return false;
}

function jupiterElementsToRows(payload) {
  const elements = payload?.elements || [];
  const tokenInfo = payload?.tokenInfo || {};
  const rows = [];
  const seen = new Set();
  for (const el of elements) {
    if (!isNavigatorLiquidityElement(el)) continue;
    const liqs =
      el.type === 'liquidity' && el.data?.liquidities?.length ? el.data.liquidities : [null];
    for (const liq of liqs) {
      const platform = el.platformId || 'solana';
      const name = (liq?.name || el.name || platform).trim();
      const key = `${name}|${platform}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const syms = (liq?.assets || [])
        .map((a) => tokenInfo.solana?.[a.data?.address]?.symbol)
        .filter(Boolean);
      rows.push({ name, platform: el.platformId, pair: syms.join(' / '), type: el.type, label: el.label });
    }
  }
  return rows;
}

const fixture = {
  elements: [
    {
      type: 'borrowlend',
      label: 'Lending',
      networkId: 'solana',
      platformId: 'kamino',
      name: 'Kamino Lend',
    },
    {
      type: 'liquidity',
      label: 'LiquidityPool',
      networkId: 'solana',
      platformId: 'raydium',
      name: 'Raydium',
      netApy: 0.42,
      data: {
        liquidities: [
          {
            name: 'USDC / BTC',
            assets: [
              { type: 'token', data: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
              { type: 'token', data: { address: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' } },
            ],
            yields: [{ apy: 0.38 }],
            link: 'https://raydium.io/liquidity/',
          },
        ],
      },
    },
    {
      type: 'liquidity',
      label: 'LiquidityPool',
      networkId: 'solana',
      platformId: 'orca',
      name: 'Orca',
      data: {
        liquidities: [
          {
            name: 'USDC / TSLAx',
            link: 'https://www.orca.so/',
          },
        ],
      },
    },
  ],
  tokenInfo: {
    solana: {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC' },
      '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': { symbol: 'BTC' },
    },
  },
};

const rows = jupiterElementsToRows(fixture);
if (rows.length !== 2) {
  console.error('FAIL: expected 2 liquidity rows, got', rows.length, rows);
  process.exit(1);
}
if (rows.some((r) => r.platform === 'kamino')) {
  console.error('FAIL: kamino lending must be excluded');
  process.exit(1);
}
console.log('OK:', rows);
