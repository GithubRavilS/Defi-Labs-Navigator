/**
 * Тест: столбец pair только по заголовку pair (как в server.js / Apps Script).
 * Запуск: node scripts/test-pair-resolution.mjs
 */

import assert from 'assert';

function normalizeHeaders(row0) {
  return (row0 || []).map((h) =>
    String(h || '')
      .trim()
      .toLowerCase()
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function pairColumnIndex(headers) {
  return headers.findIndex((h) => h === 'pair' || h === 'пара');
}

function pickPair(row, pairCol) {
  if (pairCol < 0) return '';
  const v = row[pairCol];
  return v !== undefined && v !== '' && v !== null ? String(v).trim() : '';
}

// 1) Обычный layout: pair в заголовке
function caseStandard() {
  const headers = normalizeHeaders([
    'name',
    'apy',
    'period',
    'status',
    'link',
    'description',
    'pair',
    'platform',
  ]);
  const pairCol = pairColumnIndex(headers);
  assert.strictEqual(pairCol, 6);
  const row = [
    'Uniswap',
    '12.5',
    '7d',
    'active',
    'https://x',
    'Описание',
    'ETH/USDC',
    'Uniswap',
  ];
  assert.strictEqual(pickPair(row, pairCol), 'ETH/USDC');
}

// 2) Широкий лист: pair не обязан быть рядом с description
function caseWideSheet() {
  const cols = 30;
  const header = new Array(cols).fill('');
  header[0] = 'name';
  header[1] = 'apy';
  header[5] = 'description';
  header[6] = 'pair';
  const headers = normalizeHeaders(header);
  const pairCol = pairColumnIndex(headers);
  assert.strictEqual(pairCol, 6);
  const row = new Array(cols).fill('');
  row[0] = 'Test';
  row[6] = 'BTC/ETH';
  assert.strictEqual(pickPair(row, pairCol), 'BTC/ETH');
}

// 3) Нет столбца pair — пустая строка (раньше могло тянуться с apy+5)
function caseNoPairColumn() {
  const headers = normalizeHeaders(['name', 'apy', 'a', 'b', 'c', 'd', 'other']);
  assert.strictEqual(pairColumnIndex(headers), -1);
  const row = ['X', '5', '', '', '', '', 'SOL/USDC'];
  assert.strictEqual(pickPair(row, -1), '');
}

// 4) Заголовок "Pair" → после нормализации pair
function caseHeaderPairCapitalized() {
  const headers = normalizeHeaders(['Name', 'Pair']);
  assert.strictEqual(pairColumnIndex(headers), 1);
  assert.strictEqual(pickPair(['Tool', 'ETH/USDT'], 1), 'ETH/USDT');
}

console.log('test-pair-resolution: running...');
caseStandard();
caseWideSheet();
caseNoPairColumn();
caseHeaderPairCapitalized();

function caseRussianParaHeader() {
  const headers = normalizeHeaders(['name', 'apy', 'пара']);
  assert.strictEqual(pairColumnIndex(headers), 2);
  assert.strictEqual(pickPair(['X', '1', 'ETH/USDT'], 2), 'ETH/USDT');
}

caseRussianParaHeader();
console.log('test-pair-resolution: OK (5 cases)');
console.log('Note: server.js requests A:ZZ so columns past Z are included.');
