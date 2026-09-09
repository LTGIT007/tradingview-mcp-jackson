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
let staleReads = {};        // symbol -> { asSymbol, remaining }  (simulates stale buffer)
let activeChart = null;     // symbol the chart is PARKED on before the call (pre-call binding)
let preCallUnavailable = 0; // number of INITIAL no-symbol reads to treat as "not ready yet"

// Bare-ticker normalization mirroring src/connection.js normalizeSymbol, so
// that "ASX:RHC" and "ASX_DLY:RHC" resolve to the SAME instrument and therefore
// the SAME bars (a real feed-prefix alias), while distinct tickers get distinct,
// deterministic bars (distinct fingerprints).
function ticker(symbol) {
  const parts = String(symbol).split(':');
  return parts[parts.length - 1].toUpperCase();
}
function seed(symbol) {
  const t = ticker(symbol);
  let s = 0;
  for (let i = 0; i < t.length; i++) s = (s * 31 + t.charCodeAt(i)) % 100000;
  return s;
}
function makeBars(symbol, n = 5) {
  const base = 10 + (seed(symbol) % 90); // distinct base price per instrument
  return Array.from({ length: n }, (_, i) => ({
    time: 1788000000 + i * 86400,
    open: base + i, high: base + 0.5 + i, low: base - 0.5 + i, close: base + 0.2 + i, volume: 1000 + i,
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
      // No `symbol` → "read whatever the chart is currently parked on". This is the
      // pre-call active-binding capture: it returns the resident active series
      // (activeChart). `preCallUnavailable` simulates a chart that is still loading
      // for the first N reads (throws like the real getOhlcv on an unready series);
      // a persistently blank chart (activeChart == null) always throws.
      if (symbol == null) {
        if (preCallUnavailable > 0) {
          preCallUnavailable -= 1;
          throw new Error('Could not extract OHLCV data. The chart may still be loading.');
        }
        if (activeChart == null) throw new Error('Could not extract OHLCV data. The chart may still be loading.');
        return { success: true, symbol: activeChart, bar_count: 5, bars: makeBars(activeChart) };
      }
      attempts[symbol] = (attempts[symbol] || 0) + 1;
      const p = plan[symbol] || 'ok';
      if (p === 'fail') throw new Error(`boom ${symbol}`);
      if (p === 'fail-then-ok' && attempts[symbol] === 1) throw new Error(`transient ${symbol}`);
      // Simulate the live race: the symbol label has flipped to `symbol` but the
      // resident bar buffer still holds `asSymbol`'s (previous) bars for the
      // first `remaining` reads. getOhlcv's own label guard passes (label==symbol)
      // yet the BARS are stale — exactly the ANN←CLX corruption.
      const stale = staleReads[symbol];
      if (stale && stale.remaining > 0) {
        stale.remaining -= 1;
        const staleBars = makeBars(stale.asSymbol);
        // Reproduce the live DPM→A1M failure: the resident buffer still holds the
        // previous symbol's COMPLETED history, but the final (forming) bar ticks
        // on every read during an open session. This makes the FULL-series
        // fingerprint differ between reads while the completed history stays the
        // previous symbol's — the exact condition that defeated a full-series guard.
        if (stale.evolveFinalBar) {
          stale.tick = (stale.tick || 0) + 1;
          const last = { ...staleBars[staleBars.length - 1] };
          last.volume += stale.tick; // forming-bar volume evolves; completed history unchanged
          staleBars[staleBars.length - 1] = last;
        }
        return { success: true, symbol, bar_count: staleBars.length, bars: staleBars };
      }
      return { success: true, symbol, bar_count: 5, bars: makeBars(symbol) };
    },
  },
});

const { dumpOhlcv, resolveDumpPath, DUMP_DIR, fingerprintBars, bindingFingerprint } = await import('../src/core/dump.js');

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
  staleReads = {};
  // Default: the chart is parked on a distinct instrument before every call, so the
  // pre-call binding baseline is trustworthy and the guard can protect symbols[0].
  // Tests exercising an unavailable baseline override this (activeChart=null and/or
  // preCallUnavailable). 'ASX:SEED' is a distinct ticker that never collides with a
  // requested symbol's deterministic bars.
  activeChart = 'ASX:SEED';
  preCallUnavailable = 0;
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

// ── Symbol-data binding race regression (reproduces the live ANN←CLX bug) ────
//
// LIVE FAILURE (2026-09-08): requested RHC, CLX, ANN sequentially; ANN came back
// byte-identical to CLX because TradingView flipped the symbol LABEL to ANN
// before swapping the resident bar buffer, so the first ANN read returned CLX's
// bars under the ANN label. The symbol-identity guards alone accepted it. The
// post-switch data-readiness gate + fail-closed contamination guard must catch
// this. `readinessIntervalMs: 0` keeps these deterministic and fast.
describe('dumpOhlcv — symbol-data binding race (readiness + contamination guard)', () => {
  it('(A) stale first read → readiness poll re-reads → correct symbol succeeds', async () => {
    // ANN's first read is contaminated with CLX's bars; the next read is the
    // genuine ANN series.
    staleReads = { 'ASX:ANN': { asSymbol: 'ASX:CLX', remaining: 1 } };
    const res = await runDump({
      symbols: ['ASX:CLX', 'ASX:ANN'],
      filename: 'd_race_recover',
      readinessPolls: 4,
      readinessIntervalMs: 0,
    });

    assert.equal(res.symbols_succeeded, 2);
    assert.equal(res.symbols_failed, 0);

    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    const annFp = fingerprintBars(file.symbols['ASX:ANN'].bars);
    const clxFp = fingerprintBars(file.symbols['ASX:CLX'].bars);
    // ANN must hold the REAL ANN series, never CLX's.
    assert.notEqual(annFp, clxFp, 'ANN must not be written as CLX');
    assert.equal(annFp, fingerprintBars(makeBars('ASX:ANN')));

    // Exactly one extra read happened for ANN (initial stale + one poll), and
    // NO rebind was needed (one setSymbol).
    assert.equal(calls.getOhlcv.filter((c) => c.symbol === 'ASX:ANN').length, 2);
    assert.equal(calls.setSymbol.filter((s) => s === 'ASX:ANN').length, 1);
  });

  it('(B) stale first read + stale retry → ANN fails CLOSED (never written)', async () => {
    staleReads = { 'ASX:ANN': { asSymbol: 'ASX:CLX', remaining: Infinity } };
    const res = await runDump({
      symbols: ['ASX:CLX', 'ASX:ANN'],
      filename: 'd_race_failclosed',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });

    assert.equal(res.symbols_succeeded, 1); // only CLX
    assert.equal(res.symbols_failed, 1);
    assert.match(res.per_symbol['ASX:ANN'].error, /STALE_SERIES_AFTER_SYMBOL_SWITCH/);
    assert.equal(res.per_symbol['ASX:ANN'].bars, 0);

    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(file.symbols['ASX:ANN'], undefined, 'contaminated ANN must not be written');
    assert.ok(file.failures['ASX:ANN']);
  });

  it('(C) a failed contaminated symbol does not abort a following valid symbol', async () => {
    staleReads = { 'ASX:ANN': { asSymbol: 'ASX:CLX', remaining: Infinity } };
    const res = await runDump({
      symbols: ['ASX:CLX', 'ASX:ANN', 'ASX:WBC'],
      filename: 'd_race_continue',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });

    assert.equal(res.per_symbol['ASX:ANN'].error !== null, true);
    assert.equal(res.per_symbol['ASX:WBC'].error, null);
    assert.equal(res.symbols_succeeded, 2); // CLX + WBC
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.deepEqual(Object.keys(file.symbols).sort(), ['ASX:CLX', 'ASX:WBC']);
  });

  it('(D) identical fingerprint for the SAME instrument (feed-prefix alias) is allowed', async () => {
    // ASX:RHC and ASX_DLY:RHC are the same instrument → identical bars → identical
    // fingerprint, but they must NOT trip the cross-symbol guard.
    assert.equal(
      fingerprintBars(makeBars('ASX:RHC')),
      fingerprintBars(makeBars('ASX_DLY:RHC')),
      'sanity: aliases must produce identical bars',
    );
    const res = await runDump({
      symbols: ['ASX:RHC', 'ASX_DLY:RHC'],
      filename: 'd_race_alias',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 2);
    assert.equal(res.symbols_failed, 0);
  });

  it('(E) identical fingerprint across DIFFERENT symbols triggers the guard (never relabeled)', async () => {
    staleReads = { 'ASX:ANN': { asSymbol: 'ASX:CLX', remaining: Infinity } };
    const res = await runDump({
      symbols: ['ASX:CLX', 'ASX:ANN'],
      filename: 'd_race_guard',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    // The guard fires precisely because ANN's series == CLX's series.
    assert.match(res.per_symbol['ASX:ANN'].error, /byte-identical|STALE_SERIES_AFTER_SYMBOL_SWITCH/);
    assert.match(res.per_symbol['ASX:ANN'].error, /CLX/);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    // CLX's bars are never written under ANN.
    assert.equal(file.symbols['ASX:ANN'], undefined);
  });

  it('(F) no raw bars enter the tool response even on the readiness/poll path', async () => {
    staleReads = { 'ASX:ANN': { asSymbol: 'ASX:CLX', remaining: 1 } };
    const res = await runDump({
      symbols: ['ASX:CLX', 'ASX:ANN'],
      filename: 'd_race_noraw',
      readinessPolls: 4,
      readinessIntervalMs: 0,
    });
    const serialized = JSON.stringify(res);
    assert.ok(!serialized.includes('"open"'), 'response must not contain OHLC bar objects');
    assert.ok(!serialized.includes('"volume"'));
    assert.equal(typeof res.per_symbol['ASX:ANN'].bars, 'number');
  });

  it('(G) existing single-symbol behaviour is unchanged (no gate, no extra reads)', async () => {
    const res = await runDump({ symbols: ['ASX:RHC'], filename: 'd_race_single' });
    assert.equal(res.symbols_succeeded, 1);
    // Exactly one read, one switch — the contamination gate never engages with
    // no previous symbol.
    assert.equal(calls.getOhlcv.filter((c) => c.symbol === 'ASX:RHC').length, 1);
    assert.equal(calls.setSymbol.filter((s) => s === 'ASX:RHC').length, 1);
  });

  it('(H) retry stays bounded to one rebind after persistent contamination', async () => {
    staleReads = { 'ASX:ANN': { asSymbol: 'ASX:CLX', remaining: Infinity } };
    await runDump({
      symbols: ['ASX:CLX', 'ASX:ANN'],
      filename: 'd_race_bounded',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    // ONE initial switch + exactly ONE rebind retry = 2 setSymbol calls for ANN.
    assert.equal(calls.setSymbol.filter((s) => s === 'ASX:ANN').length, 2);
    // Each attempt: 1 initial read + 2 bounded readiness polls = 3; two attempts = 6.
    assert.equal(calls.getOhlcv.filter((c) => c.symbol === 'ASX:ANN').length, 6);
  });
});

// ── Forming-bar evolution regression (reproduces the live DPM→A1M contamination) ─
//
// LIVE FAILURE (2026-09-08, ASX open): full acquisition DPM→A1M. A1M was written
// with DPM's bars. A1M's COMPLETED history was byte-identical to DPM's, but DPM's
// current 2026-09-08 FORMING bar volume ticked between reads (13,936 → 13,956), so
// the FULL-series fingerprint differed and the old guard accepted the stale series.
// The binding guard must compare COMPLETED history (final/forming bar excluded) so
// a mutating forming bar can never prove a new binding.
describe('dumpOhlcv — forming-bar evolution (DPM→A1M contamination regression)', () => {
  it('(A) stale completed history + EVOLVING forming volume → not accepted; polls to genuine A1M', async () => {
    // A1M's buffer holds DPM's completed history for the first two reads, each with
    // a DIFFERENT forming-bar volume (full fingerprint differs every read), then the
    // genuine A1M series arrives. A full-series guard would have accepted read #1.
    staleReads = { 'ASX:A1M': { asSymbol: 'ASX:DPM', remaining: 2, evolveFinalBar: true } };
    const res = await runDump({
      symbols: ['ASX:DPM', 'ASX:A1M'],
      filename: 'd_forming_recover',
      readinessPolls: 4,
      readinessIntervalMs: 0,
    });

    assert.equal(res.symbols_succeeded, 2);
    assert.equal(res.symbols_failed, 0);

    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    // A1M must hold the REAL A1M series, never DPM's (at any price scale).
    assert.equal(fingerprintBars(file.symbols['ASX:A1M'].bars), fingerprintBars(makeBars('ASX:A1M')));
    assert.notEqual(
      bindingFingerprint(file.symbols['ASX:A1M'].bars),
      bindingFingerprint(file.symbols['ASX:DPM'].bars),
      'A1M completed history must differ from DPM',
    );
    // Proof the evolving forming bar did NOT short-circuit the guard: A1M was read
    // three times (initial stale + 1 stale poll + 1 genuine) before acceptance.
    assert.equal(calls.getOhlcv.filter((c) => c.symbol === 'ASX:A1M').length, 3);
    assert.equal(calls.setSymbol.filter((s) => s === 'ASX:A1M').length, 1, 'no rebind needed');
  });

  it('(B) persistent stale completed history + evolving forming bar → FAIL CLOSED (A1M never written)', async () => {
    staleReads = { 'ASX:A1M': { asSymbol: 'ASX:DPM', remaining: Infinity, evolveFinalBar: true } };
    const res = await runDump({
      symbols: ['ASX:DPM', 'ASX:A1M'],
      filename: 'd_forming_failclosed',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });

    assert.equal(res.symbols_succeeded, 1); // only DPM
    assert.equal(res.symbols_failed, 1);
    assert.match(res.per_symbol['ASX:A1M'].error, /STALE_SERIES_AFTER_SYMBOL_SWITCH/);
    assert.match(res.per_symbol['ASX:A1M'].error, /DPM/);
    assert.equal(res.per_symbol['ASX:A1M'].bars, 0);

    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(file.symbols['ASX:A1M'], undefined, "DPM's bars must never be written under A1M");
    assert.ok(file.failures['ASX:A1M']);
    // Bounded: one initial switch + one rebind retry for A1M.
    assert.equal(calls.setSymbol.filter((s) => s === 'ASX:A1M').length, 2);
  });

  it('(C) once completed history becomes the genuine symbol, it is accepted', async () => {
    // remaining:1 → one stale read (evolving forming bar), then the real A1M.
    staleReads = { 'ASX:A1M': { asSymbol: 'ASX:DPM', remaining: 1, evolveFinalBar: true } };
    const res = await runDump({
      symbols: ['ASX:DPM', 'ASX:A1M'],
      filename: 'd_forming_accept',
      readinessPolls: 4,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 2);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(fingerprintBars(file.symbols['ASX:A1M'].bars), fingerprintBars(makeBars('ASX:A1M')));
  });

  it('(E) SAME normalized instrument with an evolving forming bar is allowed (no false stale)', async () => {
    // ASX:DPM then ASX_DLY:DPM (feed-prefix alias). Even with an evolving forming
    // bar the cross-symbol guard must not engage for the same instrument.
    staleReads = { 'ASX_DLY:DPM': { asSymbol: 'ASX:DPM', remaining: Infinity, evolveFinalBar: true } };
    const res = await runDump({
      symbols: ['ASX:DPM', 'ASX_DLY:DPM'],
      filename: 'd_forming_alias',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 2);
    assert.equal(res.symbols_failed, 0);
    // Alias never triggers the guard → single read for the second symbol.
    assert.equal(calls.getOhlcv.filter((c) => c.symbol === 'ASX_DLY:DPM').length, 1);
  });

  it('(F) raw output still includes the final forming bar (never dropped)', async () => {
    const res = await runDump({ symbols: ['ASX:DPM', 'ASX:A1M'], filename: 'd_forming_rawtail' });
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    const bars = file.symbols['ASX:A1M'].bars;
    // makeBars produces 5 bars; the binding fingerprint uses only the first 4, but
    // the stored file must retain all 5 including the final (forming) bar.
    assert.equal(bars.length, 5);
    assert.equal(res.per_symbol['ASX:A1M'].last_time, bars[4].time);
    assert.notEqual(fingerprintBars(bars), bindingFingerprint(bars), 'final bar is part of the file but excluded from the binding fp');
  });

  it('(I) a forming-contaminated symbol failing closed does not abort a following valid symbol', async () => {
    staleReads = { 'ASX:A1M': { asSymbol: 'ASX:DPM', remaining: Infinity, evolveFinalBar: true } };
    const res = await runDump({
      symbols: ['ASX:DPM', 'ASX:A1M', 'ASX:WAF'],
      filename: 'd_forming_continue',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.per_symbol['ASX:A1M'].error !== null, true);
    assert.equal(res.per_symbol['ASX:WAF'].error, null);
    assert.equal(res.symbols_succeeded, 2); // DPM + WAF
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.deepEqual(Object.keys(file.symbols).sort(), ['ASX:DPM', 'ASX:WAF']);
  });
});

// ── First-symbol-of-call binding regression (reproduces the live A1M→RHC bug) ──
//
// LIVE FAILURE (2026-09-09, ASX open): the chart was already parked on ASX_DLY:A1M
// when a fresh data_dump_ohlcv call opened with ASX:RHC. RHC was silently written
// with A1M's full bar history (comp_fp identical, RHC ~$0.83 vs its true ~$50). The
// in-call guard correctly protected a later DPM→A1M transition — but symbols[0] had
// NO previous binding reference, so it inherited the pre-existing chart buffer. The
// fix seeds the contamination guard with the PRE-CALL active binding so the first
// requested symbol is guarded exactly like symbol N→N+1. `readinessIntervalMs: 0`
// keeps these deterministic and fast.
describe('dumpOhlcv — first symbol vs pre-call active binding (A1M→RHC regression)', () => {
  it('(A/C/D) first symbol returns the pre-call active history → detected & FAILS CLOSED (never written)', async () => {
    activeChart = 'ASX_DLY:A1M';
    // RHC's every read is contaminated with the pre-call A1M buffer.
    staleReads = { 'ASX:RHC': { asSymbol: 'ASX_DLY:A1M', remaining: Infinity } };
    const res = await runDump({
      symbols: ['ASX:RHC'],
      filename: 'd_first_failclosed',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 0);
    assert.equal(res.symbols_failed, 1);
    // Detected from the PRE-CALL baseline and named against the active symbol.
    assert.match(res.per_symbol['ASX:RHC'].error, /STALE_SERIES_AFTER_SYMBOL_SWITCH/);
    assert.match(res.per_symbol['ASX:RHC'].error, /A1M/);
    assert.equal(res.per_symbol['ASX:RHC'].bars, 0);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(file.symbols['ASX:RHC'], undefined, "A1M's bars must never be written under RHC");
    assert.ok(file.failures['ASX:RHC']);
    // Bounded: one initial switch + exactly one rebind retry.
    assert.equal(calls.setSymbol.filter((s) => s === 'ASX:RHC').length, 2);
  });

  it('(B) once the genuine RHC completed history appears, the first symbol succeeds', async () => {
    activeChart = 'ASX_DLY:A1M';
    // One stale read (pre-call A1M) then the real RHC series.
    staleReads = { 'ASX:RHC': { asSymbol: 'ASX_DLY:A1M', remaining: 1 } };
    const res = await runDump({
      symbols: ['ASX:RHC'],
      filename: 'd_first_recover',
      readinessPolls: 4,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 1);
    assert.equal(res.symbols_failed, 0);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(fingerprintBars(file.symbols['ASX:RHC'].bars), fingerprintBars(makeBars('ASX:RHC')));
    // Recovered via the readiness poll — no rebind needed (single setSymbol).
    assert.equal(calls.getOhlcv.filter((c) => c.symbol === 'ASX:RHC').length, 2);
    assert.equal(calls.setSymbol.filter((s) => s === 'ASX:RHC').length, 1);
  });

  it('(E) a failed first symbol does not abort a following valid symbol', async () => {
    activeChart = 'ASX_DLY:A1M';
    staleReads = { 'ASX:RHC': { asSymbol: 'ASX_DLY:A1M', remaining: Infinity } };
    const res = await runDump({
      symbols: ['ASX:RHC', 'ASX:L1G'],
      filename: 'd_first_continue',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.per_symbol['ASX:RHC'].error !== null, true);
    assert.equal(res.per_symbol['ASX:L1G'].error, null);
    assert.equal(res.symbols_succeeded, 1); // L1G only
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.deepEqual(Object.keys(file.symbols).sort(), ['ASX:L1G']);
  });

  it('(F) first requested symbol == the SAME normalized active instrument is allowed', async () => {
    // Chart parked on ASX_DLY:A1M; call opens with ASX:A1M (same instrument). Its
    // history legitimately equals the pre-call baseline → must NOT trip the guard.
    activeChart = 'ASX_DLY:A1M';
    const res = await runDump({
      symbols: ['ASX:A1M'],
      filename: 'd_first_alias',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 1);
    assert.equal(res.symbols_failed, 0);
    // Same instrument → cross-symbol guard never engages → single read, no poll.
    assert.equal(calls.getOhlcv.filter((c) => c.symbol === 'ASX:A1M').length, 1);
  });

  it('(G) an evolving forming bar cannot defeat the pre-call completed-history comparison', async () => {
    activeChart = 'ASX_DLY:A1M';
    // Every RHC read returns A1M's completed history with a DIFFERENT forming-bar
    // volume, so a full-series fingerprint would differ each read — the completed
    // history still matches the pre-call baseline and must keep failing closed.
    staleReads = { 'ASX:RHC': { asSymbol: 'ASX_DLY:A1M', remaining: Infinity, evolveFinalBar: true } };
    const res = await runDump({
      symbols: ['ASX:RHC'],
      filename: 'd_first_forming',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 0);
    assert.match(res.per_symbol['ASX:RHC'].error, /STALE_SERIES_AFTER_SYMBOL_SWITCH/);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(file.symbols['ASX:RHC'], undefined);
  });

  it('(H) first-symbol guard AND in-call DPM→A1M guard both fire in one call', async () => {
    // Pre-call chart on A1M. RHC (first) inherits A1M → fails. DPM is genuine and
    // succeeds. A1M (last) inherits DPM in-call → fails. This proves the new
    // first-symbol seed and the existing in-call completed-history guard coexist.
    activeChart = 'ASX_DLY:A1M';
    staleReads = {
      'ASX:RHC': { asSymbol: 'ASX_DLY:A1M', remaining: Infinity, evolveFinalBar: true },
      'ASX:A1M': { asSymbol: 'ASX:DPM', remaining: Infinity, evolveFinalBar: true },
    };
    const res = await runDump({
      symbols: ['ASX:RHC', 'ASX:DPM', 'ASX:A1M'],
      filename: 'd_first_and_incall',
      readinessPolls: 2,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 1); // DPM only
    assert.equal(res.symbols_failed, 2);
    assert.match(res.per_symbol['ASX:RHC'].error, /STALE_SERIES_AFTER_SYMBOL_SWITCH/);
    assert.match(res.per_symbol['ASX:RHC'].error, /A1M/);
    assert.match(res.per_symbol['ASX:A1M'].error, /STALE_SERIES_AFTER_SYMBOL_SWITCH/);
    assert.match(res.per_symbol['ASX:A1M'].error, /DPM/);
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.deepEqual(Object.keys(file.symbols).sort(), ['ASX:DPM']);
  });

  it('(I-A) pre-call series temporarily unavailable then appears within bounded polling → proceeds', async () => {
    // The active chart is loading: the first two pre-call reads are unavailable, then
    // the genuine baseline appears. Acquisition must proceed normally.
    activeChart = 'ASX_DLY:A1M';
    preCallUnavailable = 2;
    const res = await runDump({
      symbols: ['ASX:RHC'],
      filename: 'd_precall_recover',
      readinessPolls: 4,
      readinessIntervalMs: 0,
    });
    assert.equal(res.symbols_succeeded, 1);
    assert.equal(res.symbols_failed, 0);
    // Exactly initial read + 2 readiness polls = 3 no-symbol pre-call reads.
    assert.equal(calls.getOhlcv.filter((c) => c.symbol == null).length, 3);
    // The first symbol was still guarded against the (recovered) A1M baseline.
    const file = JSON.parse(readFileSync(res.path, 'utf8'));
    assert.equal(fingerprintBars(file.symbols['ASX:RHC'].bars), fingerprintBars(makeBars('ASX:RHC')));
  });

  it('(I-B) pre-call series persistently unavailable → whole dump FAILS CLOSED, nothing switched or written', async () => {
    activeChart = null; // chart never yields a usable series
    const filename = 'd_precall_failclosed';
    await assert.rejects(
      () => dumpOhlcv({
        symbols: ['ASX:RHC', 'ASX:L1G'],
        filename,
        readinessPolls: 2,
        readinessIntervalMs: 0,
      }),
      /PRECALL_BINDING_UNAVAILABLE/,
    );
    // No requested symbol was switched or acquired.
    assert.equal(calls.setSymbol.length, 0, 'no symbol may be switched without a baseline');
    assert.equal(calls.getOhlcv.filter((c) => c.symbol != null).length, 0, 'no per-symbol acquisition read');
    // No output file (not even a leftover temp) was written.
    const p = resolveDumpPath(filename);
    assert.ok(!existsSync(p), 'no dump file may be written when the baseline fails');
    assert.ok(!existsSync(`${p}.tmp`));
  });

  it('(I-C) bounded pre-call polling does not loop indefinitely (initial read + exactly maxPolls)', async () => {
    activeChart = null;
    await assert.rejects(
      () => dumpOhlcv({
        symbols: ['ASX:RHC'],
        filename: 'd_precall_bounded',
        readinessPolls: 3,
        readinessIntervalMs: 0,
      }),
      /PRECALL_BINDING_UNAVAILABLE/,
    );
    // 1 initial read + exactly 3 readiness polls = 4 no-symbol reads, then it stops.
    assert.equal(calls.getOhlcv.filter((c) => c.symbol == null).length, 4);
  });

  it('(I-F) a healthy pre-call baseline adds no delay beyond the single initial read', async () => {
    // Default activeChart is available immediately → exactly ONE no-symbol pre-call
    // read, no readiness polling (even though readinessIntervalMs defaults to 150ms).
    const res = await runDump({ symbols: ['ASX:RHC'], filename: 'd_precall_fast' });
    assert.equal(res.symbols_succeeded, 1);
    assert.equal(calls.getOhlcv.filter((c) => c.symbol == null).length, 1, 'healthy baseline = one read, no polling');
  });
});
