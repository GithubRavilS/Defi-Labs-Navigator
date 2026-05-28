/**
 * Тест Jupiter (без ключа) + пробная запись на лист RWA.
 * node scripts/sync-rwa-jupiter-test.mjs [wallet_or_url]
 */
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPREADSHEET_ID = '1NjN5ELRjNVlFSVfJLCQsho32Kod5HRA4JWakZ7KVsJY';
const RWA_SHEET = 'Битва пуллов RWA';

function parseWallet(v) {
  const s = String(v || '').trim();
  const m = s.match(/portfolio\/([1-9A-HJ-NP-Za-km-z]{32,44})/i) || s.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m ? m[1] : '';
}

function isLiq(el) {
  if (!el || el.networkId !== 'solana') return false;
  if (el.type === 'borrowlend' || el.label === 'Lending') return false;
  return el.type === 'liquidity' || el.label === 'LiquidityPool';
}

const wallet = parseWallet(process.argv[2] || process.env.RWA_WALLET || '');
if (!wallet) {
  console.error('Usage: node scripts/sync-rwa-jupiter-test.mjs <jup.ag/portfolio/ADDR or ADDR>');
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 2200));
const res = await fetch(`https://api.jup.ag/portfolio/v1/positions/${wallet}`, {
  headers: { Accept: 'application/json' },
});
const text = await res.text();
if (!res.ok) {
  console.error('Jupiter', res.status, text.slice(0, 400));
  process.exit(1);
}
const payload = JSON.parse(text);
const elements = payload.elements || [];
const liq = elements.filter(isLiq);
console.log('Wallet:', wallet, '| liquidity elements:', liq.length, '| total elements:', elements.length);
liq.slice(0, 5).forEach((e) => console.log(' -', e.platformId, e.name, e.type, e.label));
