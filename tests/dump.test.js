/**
 * Deterministic, offline tests for data_dump_ohlcv (src/core/dump.js).
 *
 * No live TradingView needed: the three existing core primitives the dump
 * tool COMPOSES — chart.setTimeframe(), pane.setSymbol(), data.getOhlcv() —
 * are module-mocked, so the REAL dump.js orchestration (sequencing, one-retry
 * soft-fail, atomic file write, sha256, filename safety, compact response)
 * runs unmodified against controllable fakes.
 *
 * Run: node --experimental-test-module-mocks --test tests/dump.test.js
 */

import { describe, it, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DUMP_SRC = join(__dirname, '..', 'src', 'core', 'dump.js');

// ── Mutable scenario controlling the fakes ────────────────────────────────
const calls = { setTimeframe: [], setSymbol: [], getOhlcv: [] };
const attempts = {};        // symbol -> times getOhlcv has been invoked
let plan = {};              // symbol -> 'ok' | 'fail' | 'fail-then-ok' | 'fail-pane'

function makeBars(symbol, n = 5) {
  return Array.from({ length: n }, (_, i) => ({
    time: 1788000000 + i * 86400,
    open: 10 + i, high: 10.5 + i, low: 9.5 + i, close: 10.2 + i, volume: 1000 + i,
  }));
}

mock.module('../src/core/chart.js', {
  exports: {
    setTimeframe: async ({ timeframe }) => { calls.setTimeframe.push(timeframe); return { success: true, timeframe }; },
  },
});
mock.module('../src/core/pane.js', {
  exports: {
    setSymbol: async ({ index, symbol }) => {
      calls.setSymbol.push(symbol);
      if (plan[symbol] === 'fail-pane') throw new Error(`pane switch failed for ${symbol}`);
      return { success: true, index, symbol, requested_symbol: symbol };
    },
  },
});
mock.module('../src/core/data.js', {
  exports: {
    getOhlcv: async ({ symbol, count }) => {
      calls.getOhlcv.push({ symbol, count });
      attempts[symbol] = (attempts[symbol] || 0) + 1;
      const p = plan[symbol] || 'ok';
      if (p === 'fail') throw new Error(`boom ${symbol}`);
      if (p === 'fail-then-ok' && attempts[symbol] === 1) throw new Error(`transient ${symbol}`);
      return { success: true, symbol, bar_count: 5, bars: makeBars(symbol) };
    },
  },
});

const { dumpOhlcv, resolveDumpPath, DUMP_DIR } = await import('../src/core/dump.js');

const created = new Set();
async function runDump(opts) {
  const res = await dumpOhlcv(opts);
  if (res && res.path) created.add(res.path);
  return res;
}

beforeEach(() => {
  calls.setTimeframe.length = 0;
  calls.setSymbol.length = 0;
  calls.getOhlcv.length = 0;
  for (const k of Object.keys(attempts)) delete attempts[k];
  plan = {};
});

after(() => {
  for (const p of created) { try { rmSync(p, { force: true }); } catch {} try { rmSync(`${p}.tmp`, { force: true }); } catch {} }
});

describe('dumpOhlcv — acquisition & soft-fail', () => {
  it('(1) single symbol success', async () => {
    const res = await runDump({ symbols: ['ASX:RHC'], filename: 'd_single' });
    assert.equal(res.symbols_requested, 1);
    assert.equal(res.symbols_succeeded, 1);
    assert.equal(res.symbols_failed, 0);
    assert.equal(res.per_symbol['ASX:RHC'].bars, 5);
    assert.equal(res.per_symbol['ASX:RHC'].error, null);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(file.symbols['ASX:RHC'].bars.length, 5);
  });

  it('(2) three-symbol success', async () => {
    const res = await runDump({ symbols: ['ASX:RHC', 'ASX:CLX', 'ASX:ANN'], filename: 'd_three' });
    assert.equal(res.symbols_succeeded, 3);
    assert.equal(res.symbols_failed, 0);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.deepEqual(Object.keys(file.symbols).sort(), ['ASX:ANN', 'ASX:CLX', 'ASX:RHC']);
  });

  it('(3) invalid symbol mixed with valid symbols', async () => {
    plan = { 'ASX:CLX': 'fail' };
    const res = await runDump({ symbols: ['ASX:RHC', 'ASX:CLX', 'ASX:ANN'], filename: 'd_mixed' });
    assert.equal(res.symbols_succeeded, 2);
    assert.equal(res.symbols_failed, 1);
    assert.ok(res.per_symbol['ASX:CLX'].error);
    assert.equal(res.per_symbol['ASX:CLX'].bars, 0);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.deepEqual(Object.keys(file.symbols).sort(), ['ASX:ANN', 'ASX:RHC']);
    assert.ok(file.failures['ASX:CLX']);
  });

  it('(4) one-symbol failure does not abort the remainder', async () => {
    plan = { 'ASX:RHC': 'fail' };
    const res = await runDump({ symbols: ['ASX:RHC', 'ASX:CLX', 'ASX:ANN'], filename: 'd_abort' });
    assert.equal(res.per_symbol['ASX:CLX'].error, null);
    assert.equal(res.per_symbol['ASX:ANN'].error, null);
    assert.equal(res.symbols_succeeded, 2);
  });

  it('(5) exactly one retry maximum (permanent fail → 2 attempts), and recovers on retry', async () => {
    plan = { 'ASX:BAD': 'fail' };
    const res = await runDump({ symbols: ['ASX:BAD'], filename: 'd_retry' });
    assert.equal(res.symbols_failed, 1);
    assert.equal(calls.getOhlcv.filter(c => c.symbol === 'ASX:BAD').length, 2, 'exactly 1 initial + 1 retry');
    assert.equal(calls.setSymbol.filter(s => s === 'ASX:BAD').length, 2);

    // fail-then-ok recovers on the single retry
    calls.getOhlcv.length = 0;
    for (const k of Object.keys(attempts)) delete attempts[k];
    plan = { 'ASX:REC': 'fail-then-ok' };
    const res2 = await runDump({ symbols: ['ASX:REC'], filename: 'd_retry2' });
    assert.equal(res2.symbols_succeeded, 1);
    assert.equal(calls.getOhlcv.filter(c => c.symbol === 'ASX:REC').length, 2);
  });

  it('(5b) pane switch failure is retried once then soft-failed', async () => {
    plan = { 'ASX:NOPE': 'fail-pane' };
    const res = await runDump({ symbols: ['ASX:NOPE'], filename: 'd_pane' });
    assert.equal(res.symbols_failed, 1);
    assert.equal(calls.setSymbol.filter(s => s === 'ASX:NOPE').length, 2);
    assert.equal(calls.getOhlcv.filter(c => c.symbol === 'ASX:NOPE').length, 0, 'getOhlcv never reached when switch fails');
  });
});

describe('dumpOhlcv — count & timeframe', () => {
  it('(6) requested count passed through; default is 350', async () => {
    await runDump({ symbols: ['ASX:RHC'], count: 350, filename: 'd_count' });
    assert.equal(calls.getOhlcv[0].count, 350);
    calls.getOhlcv.length = 0;
    await runDump({ symbols: ['ASX:RHC'], filename: 'd_count_def' });
    assert.equal(calls.getOhlcv[0].count, 350);
  });

  it('(7) timeframe is set exactly once regardless of symbol count', async () => {
    await runDump({ symbols: ['ASX:RHC', 'ASX:CLX', 'ASX:ANN'], timeframe: 'D', filename: 'd_tf' });
    assert.equal(calls.setTimeframe.length, 1);
    assert.equal(calls.setTimeframe[0], 'D');
  });
});

describe('dumpOhlcv — file, metadata, response', () => {
  it('(8) output file is valid JSON with the generic shape', async () => {
    const res = await runDump({ symbols: ['ASX:RHC'], filename: 'd_json' });
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(file.source, 'tradingview');
    assert.equal(file.timeframe, 'D');
    assert.equal(file.requested_count, 350);
    assert.ok(typeof file.captured_at === 'string');
    assert.ok(file.symbols && file.failures);
    // native getOhlcv bar fields preserved
    const b0 = file.symbols['ASX:RHC'].bars[0];
    assert.deepEqual(Object.keys(b0).sort(), ['close', 'high', 'low', 'open', 'time', 'volume']);
  });

  it('(9) response metadata matches the written file', async () => {
    const res = await runDump({ symbols: ['ASX:RHC', 'ASX:ANN'], filename: 'd_match' });
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    for (const sym of ['ASX:RHC', 'ASX:ANN']) {
      const bars = file.symbols[sym].bars;
      assert.equal(res.per_symbol[sym].bars, bars.length);
      assert.equal(res.per_symbol[sym].first_time, bars[0].time);
      assert.equal(res.per_symbol[sym].last_time, bars[bars.length - 1].time);
      assert.equal(res.per_symbol[sym].last_close, bars[bars.length - 1].close);
    }
  });

  it('(10) raw bars are ABSENT from the tool response', async () => {
    const res = await runDump({ symbols: ['ASX:RHC'], filename: 'd_noraw' });
    assert.equal(res.bars, undefined);
    assert.equal(res.symbols, undefined); // no per-symbol bar map in the response
    assert.equal(typeof res.per_symbol['ASX:RHC'].bars, 'number');
    // No bar-shaped payload anywhere in the serialized response.
    const serialized = JSON.stringify(res);
    assert.ok(!serialized.includes('"open"'), 'response must not contain OHLC bar objects');
    assert.ok(!serialized.includes('"volume"'));
  });

  it('(11) returned sha256 == sha256 of the final file bytes', async () => {
    const res = await runDump({ symbols: ['ASX:RHC', 'ASX:CLX'], filename: 'd_sha' });
    const bytes = readFileSync(res.path);
    const onDisk = createHash('sha256').update(bytes).digest('hex');
    assert.equal(res.sha256, onDisk);
  });

  it('(14) atomic write: final file present, no leftover .tmp', async () => {
    const res = await runDump({ symbols: ['ASX:RHC'], filename: 'd_atomic' });
    assert.ok(existsSync(res.path));
    assert.ok(!existsSync(`${res.path}.tmp`), 'temporary file must be renamed away');
  });
});

describe('resolveDumpPath — filename safety', () => {
  it('(12) rejects traversal filenames', () => {
    assert.throws(() => resolveDumpPath('../evil.json'), /\.\.|separator|escape/i);
    assert.throws(() => resolveDumpPath('..\\evil.json'), /\.\.|separator|escape/i);
    assert.throws(() => resolveDumpPath('sub/child.json'), /separator/i);
  });

  it('(13) rejects absolute paths', () => {
    assert.throws(() => resolveDumpPath('C:\\Windows\\evil.json'), /absolute|separator/i);
    assert.throws(() => resolveDumpPath('/etc/evil.json'), /absolute|separator/i);
  });

  it('(13b) rejects empty/invalid, accepts a plain name and appends .json inside dumps/', () => {
    assert.throws(() => resolveDumpPath(''), /required/i);
    assert.throws(() => resolveDumpPath('   '), /required/i);
    const p = resolveDumpPath('ok_name');
    assert.ok(p.startsWith(DUMP_DIR));
    assert.ok(p.endsWith('.json'));
  });

  it('rejects a bad filename before any acquisition work runs', async () => {
    await assert.rejects(() => dumpOhlcv({ symbols: ['ASX:RHC'], filename: '../escape' }), /\.\.|separator|escape/i);
    assert.equal(calls.setTimeframe.length, 0, 'must fail before setting timeframe / touching the chart');
    assert.equal(calls.getOhlcv.length, 0);
  });
});

describe('dumpOhlcv — reuses existing primitives (no duplicated OHLCV impl)', () => {
  it('(15) composes getOhlcv/pane.setSymbol/chart.setTimeframe and defines no fresh OHLCV read', async () => {
    await runDump({ symbols: ['ASX:RHC'], filename: 'd_reuse' });
    assert.ok(calls.getOhlcv.length > 0, 'must call the shared getOhlcv primitive');
    assert.ok(calls.setSymbol.length > 0, 'must reuse pane.setSymbol');
    assert.ok(calls.setTimeframe.length > 0, 'must reuse chart.setTimeframe');

    const src = readFileSync(DUMP_SRC, 'utf8');
    // Strip comments — mentioning these internals in DOCUMENTATION is fine; the
    // rule is that dump.js must not re-implement the raw bar read in CODE.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['mainSeries', 'valueAt', '.bars()', 'exportData', '_chartWidget']) {
      assert.ok(!code.includes(forbidden), `dump.js must not duplicate OHLCV internals (found "${forbidden}")`);
    }
    assert.match(code, /from '\.\/data\.js'/);
    assert.match(code, /getOhlcv/);
  });
});
