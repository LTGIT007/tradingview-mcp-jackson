/**
 * Deterministic, offline tests for the symbol-binding identity guard.
 *
 * Reproduces the demonstrated RMS/TNE stale-symbol race (a chart.setSymbol()
 * call reporting success while the resident bar buffer still belonged to the
 * PREVIOUS symbol) and proves pane.setSymbol() / getQuote() / getOhlcv() now
 * fail closed instead of silently returning mismatched data.
 *
 * No live TradingView connection needed: the CDP client is faked at the
 * chrome-remote-interface boundary (see tests/helpers/fake_cdp.js), so the
 * REAL src/connection.js, src/core/pane.js, src/core/data.js all run
 * unmodified against a controllable fake TradingView object model.
 *
 * Run: node --test tests/symbol_binding.test.js
 */

import { describe, it, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCdp } from './helpers/fake_cdp.js';

const fake = createFakeCdp({ initialSymbol: 'ASX:TNE', initialBasePrice: 32 });

// Independent scanner reference closes (what scanner.tradingview.com reports for the
// GENUINE instrument). Fake bars close at basePrice + 0.02.
const scannerRefs = { TNE: 32.02, RMS: 4.02, COH: 128.02 };
let scannerDown = false;
const scannerCalls = [];

mock.method(globalThis, 'fetch', async (url) => {
  if (String(url).includes('scanner.tradingview.com')) {
    const sym = decodeURIComponent(String(url).match(/symbol=([^&]+)/)[1]);
    scannerCalls.push(sym);
    if (scannerDown) throw new Error('ECONNREFUSED');
    const t = sym.split(':')[1];
    if (!(t in scannerRefs)) return { ok: false, status: 404, json: async () => ({ code: 'symbol_not_exists' }) };
    return { ok: true, status: 200, json: async () => ({ close: scannerRefs[t], description: t }) };
  }
  return {
    ok: true,
    json: async () => [{ type: 'page', url: 'https://www.tradingview.com/chart/abc', id: 'MOCK_TARGET' }],
  };
});

mock.module('chrome-remote-interface', {
  exports: { default: async () => fake.client },
});

const { setSymbol, focus } = await import('../src/core/pane.js');
const { getQuote, getOhlcv } = await import('../src/core/data.js');

// Bind the fake chart directly: `label` is what series.symbol() reports, `basePrice`
// sets whose bars are resident (bars close at basePrice + 0.02).
function setChart(label, basePrice) {
  resetState(label, basePrice);
  fake.state.nextSettle = null;
  fake.state.pendingSwitch = null;
  fake.state.activeSymbol = label;
  fake.state.bars = Array.from({ length: 20 }, (_, i) => ({
    time: 1700000000 + i * 3600, open: basePrice, high: basePrice + 0.1, low: basePrice - 0.1,
    close: basePrice + 0.02, volume: 1000 + i,
  }));
}

function resetState(symbol = 'ASX:TNE', basePrice = 32) {
  fake.state.activeSymbol = symbol;
  fake.state.bars = fake.state.bars.map((b) => ({ ...b })); // no-op, just for clarity
  fake.state.pendingSwitch = null;
  fake.state.nextSettle = null;
  fake.evaluateLog.length = 0;
  // Rebuild bars for the reset symbol directly via a synthetic settle.
  fake.scheduleSettle(symbol, { basePrice, settleAfterReads: 0 });
}

describe('pane.setSymbol() — settle verification (no fixed-timer success)', () => {
  it('does not report success before the active mainSeries symbol actually changes, and succeeds once it does', async () => {
    resetState('ASX:TNE', 32);
    fake.state.activeSymbol = 'ASX:TNE';
    fake.state.pendingSwitch = null;

    // Arm the switch to settle only after 3 identity polls (simulates the
    // real async gap between chart.setSymbol() returning and the bar buffer
    // actually swapping).
    fake.scheduleSettle('ASX:RMS', { basePrice: 4, settleAfterReads: 3 });

    const result = await setSymbol({ index: 0, symbol: 'ASX:RMS', timeoutMs: 5000 });

    assert.equal(result.success, true);
    assert.equal(result.symbol, 'ASX:RMS');
    assert.equal(fake.state.activeSymbol, 'ASX:RMS');

    // Confirm the identity read really was polled more than once (i.e. the
    // first read(s) did NOT already show RMS — the settle genuinely took
    // multiple polls, proving this isn't just a fixed sleep in disguise).
    const identityReads = fake.evaluateLog.filter(
      (e) => e.includes('series.bars()') && e.includes('barCount')
    );
    assert.ok(identityReads.length >= 3, `expected >=3 identity polls, got ${identityReads.length}`);
  });

  it('fails closed (throws, no success=true) if the requested symbol never settles within the timeout', async () => {
    resetState('ASX:TNE', 32);
    fake.scheduleNeverSettle();

    await assert.rejects(
      () => setSymbol({ index: 0, symbol: 'ASX:RMS', timeoutMs: 400 }),
      /Timed out.*ASX:RMS/s
    );
    // The chart must still be reporting the OLD symbol — no partial/implied success.
    assert.equal(fake.state.activeSymbol, 'ASX:TNE');
  });

  it('settles immediately when the active series is already on the requested symbol', async () => {
    resetState('ASX:RMS', 4);
    fake.state.activeSymbol = 'ASX:RMS';
    fake.state.pendingSwitch = null;

    const result = await setSymbol({ index: 1, symbol: 'ASX:RMS', timeoutMs: 2000 });
    assert.equal(result.success, true);
    assert.equal(result.symbol, 'ASX:RMS');
  });
});

describe('getQuote() — identity guard', () => {
  it('rejects requested RMS while the active chart is genuinely bound to TNE', async () => {
    resetState('ASX:TNE', 32);
    fake.state.pendingSwitch = null;

    await assert.rejects(
      () => getQuote({ symbol: 'ASX_DLY:RMS' }),
      /Symbol identity mismatch.*RMS.*TNE/s
    );
  });

  it('succeeds when requested RMS reconciles with the active RMS series (prefix-insensitive)', async () => {
    resetState('ASX:RMS', 4);
    fake.state.pendingSwitch = null;

    const quote = await getQuote({ symbol: 'ASX_DLY:RMS' });
    assert.equal(quote.success, true);
    assert.ok(quote.close > 3 && quote.close < 5, `expected an RMS-magnitude price, got ${quote.close}`);
  });

  it('never echoes the requested symbol string over the real bound identity (cosmetic-echo guard)', async () => {
    resetState('ASX:RMS', 4);
    fake.state.pendingSwitch = null;

    const quote = await getQuote({ symbol: 'ASX_DLY:RMS' });
    // The response's symbol field must be the ACTUAL bound symbol
    // ("ASX:RMS", as reported by the fake series), not a re-statement of
    // whatever string the caller passed in ("ASX_DLY:RMS").
    assert.equal(quote.symbol, 'ASX:RMS');
    assert.notEqual(quote.symbol, 'ASX_DLY:RMS');
  });

  it('reproduces the ORIGINAL bug shape once more explicitly: requested RMS, active still TNE at $32-ish, must not silently return that as an RMS quote', async () => {
    resetState('ASX:TNE', 32.5);
    fake.state.pendingSwitch = null;

    let caught = null;
    try {
      await getQuote({ symbol: 'RMS' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected getQuote to throw rather than return TNE-priced data labeled RMS');
    assert.match(caught.message, /mismatch/i);
  });
});

describe('getOhlcv() — identity guard', () => {
  it('rejects requested RMS while the active chart is genuinely bound to TNE', async () => {
    resetState('ASX:TNE', 32);
    fake.state.pendingSwitch = null;

    await assert.rejects(
      () => getOhlcv({ symbol: 'ASX_DLY:RMS', summary: true }),
      /Symbol identity mismatch.*RMS.*TNE/s
    );
  });

  it('succeeds when requested RMS reconciles with the active RMS series', async () => {
    resetState('ASX:RMS', 4);
    fake.state.pendingSwitch = null;

    const result = await getOhlcv({ symbol: 'ASX_DLY:RMS', summary: true });
    assert.equal(result.success, true);
    assert.equal(result.symbol, 'ASX:RMS');
    assert.ok(result.close > 3 && result.close < 5, `expected an RMS-magnitude close, got ${result.close}`);
  });

  it('with no symbol requested, still verifies the bars against the active label\'s independent reference', async () => {
    setChart('ASX:TNE', 32);
    scannerCalls.length = 0;

    const result = await getOhlcv({ summary: true });
    assert.equal(result.success, true);
    assert.equal(result.symbol, 'ASX:TNE');
    assert.equal(result.identity, 'VERIFIED');
    assert.deepEqual(scannerCalls, ['ASX:TNE']);
  });
});

// 2026-10-09 (ED #47): TradingView Desktop showed "Session disconnected", the bar
// buffer froze on COH (~$128) and a symbol switch relabelled the chart RMS. The label
// guard above then AGREED with the request, so COH's bars were accepted as RMS.
describe('getOhlcv() — independent identity + session (RMS←COH, 2026-10-09)', () => {
  // Chart label says RMS, but the resident bars are COH's.
  const contaminate = () => setChart('ASX_DLY:RMS', 128);

  it('rejects COH bars under an RMS label even though the label matches the request', async () => {
    contaminate();
    await assert.rejects(
      () => getOhlcv({ symbol: 'ASX_DLY:RMS', summary: true }),
      /IDENTITY_MISMATCH.*ASX:RMS.*4\.02/s
    );
  });

  it('rejects the same contamination when no symbol is passed (no label-only bypass)', async () => {
    contaminate();
    await assert.rejects(() => getOhlcv({ count: 50 }), /IDENTITY_MISMATCH/);
  });

  it('fails closed with IDENTITY_UNVERIFIED when the independent reference is unavailable', async () => {
    setChart('ASX:RMS', 4);
    scannerDown = true;
    try {
      await assert.rejects(() => getOhlcv({ symbol: 'ASX_DLY:RMS' }), /IDENTITY_UNVERIFIED.*ECONNREFUSED/s);
    } finally {
      scannerDown = false;
    }
  });

  it('returns VERIFIED identity and the reference close on genuine bars', async () => {
    setChart('ASX:RMS', 4);
    const result = await getOhlcv({ symbol: 'ASX_DLY:RMS' });
    assert.equal(result.identity, 'VERIFIED');
    assert.equal(result.identity_reference_close, 4.02);
    assert.ok(result.bars.length > 0);
  });

  it('passes an index the scanner does not know as NO_REFERENCE (label guard still applies)', async () => {
    setChart('ASX:XJO', 8700);
    const result = await getOhlcv({ symbol: 'ASX_DLY:XJO', summary: true });
    assert.equal(result.identity, 'NO_REFERENCE');
  });

  it('fails closed on a disconnected session BEFORE reading any bars', async () => {
    setChart('ASX:RMS', 4);
    fake.state.sessionDisconnected = true;
    fake.evaluateLog.length = 0;
    try {
      await assert.rejects(() => getOhlcv({ symbol: 'ASX_DLY:RMS' }), /TV_SESSION_DISCONNECTED/);
      await assert.rejects(() => getOhlcv({ summary: true }), /TV_SESSION_DISCONNECTED/);
      assert.equal(fake.evaluateLog.filter((e) => e.includes('active_symbol: activeSymbol')).length, 0);
    } finally {
      fake.state.sessionDisconnected = false;
    }
  });

  it('verify:false (dumpOhlcv internal polling only) skips both checks', async () => {
    contaminate();
    fake.state.sessionDisconnected = true;
    scannerCalls.length = 0;
    try {
      const result = await getOhlcv({ symbol: 'ASX_DLY:RMS', verify: false, summary: true });
      assert.equal(result.success, true);
      assert.equal(result.identity, undefined);
      assert.equal(scannerCalls.length, 0);
    } finally {
      fake.state.sessionDisconnected = false;
    }
  });
});
