/**
 * Fake CDP client for testing the symbol-binding identity guard without a
 * live TradingView connection. Dispatches Runtime.evaluate() calls based on
 * distinguishing substrings in the evaluated expression, mirroring what
 * src/core/pane.js / src/core/data.js / src/connection.js actually send.
 *
 * `state` is intentionally mutable and exposed directly so each test can set
 * up the "currently bound" chart symbol/bars before exercising the function
 * under test, and simulate an async settle via `state.pendingSwitch`.
 */

function defaultBars(symbol, basePrice) {
  return Array.from({ length: 20 }, (_, i) => ({
    time: 1700000000 + i * 3600,
    open: basePrice,
    high: basePrice + 0.1,
    low: basePrice - 0.1,
    close: basePrice + 0.02,
    volume: 1000 + i,
  }));
}

export function createFakeCdp({ initialSymbol = 'ASX:TNE', initialBasePrice = 32 } = {}) {
  const state = {
    activeSymbol: initialSymbol,
    bars: defaultBars(initialSymbol, initialBasePrice),
    pendingSwitch: null, // { symbol, basePrice, settleAfterReads, reads }
    focusedIndex: 0,
    totalPanes: 2,
    sessionDisconnected: false,
  };

  const evaluateLog = [];

  function applyPendingSwitchIfSettled() {
    const p = state.pendingSwitch;
    if (!p) return;
    p.reads += 1;
    if (p.reads >= p.settleAfterReads) {
      state.activeSymbol = p.symbol;
      state.bars = defaultBars(p.symbol, p.basePrice);
      state.pendingSwitch = null;
    }
  }

  async function handleEvaluate({ expression }) {
    evaluateLog.push(expression);

    if (expression === '1') return { result: { value: 1 } };

    // session.js sessionState() — the "Session disconnected" modal check
    if (/session disconnected/i.test(expression)) {
      return { result: { value: state.sessionDisconnected ? 'DISCONNECTED' : 'OK' } };
    }

    if (expression.includes('_mainDiv.click()')) {
      const m = expression.match(/all\[(\d+)\]/);
      const idx = m ? Number(m[1]) : 0;
      state.focusedIndex = idx;
      return { result: { value: { focused: idx, total: state.totalPanes } } };
    }

    if (expression.includes('chart.setSymbol(')) {
      const m = expression.match(/chart\.setSymbol\('([^']*)'/);
      const requested = m ? m[1] : null;
      if (requested && state.nextSettle) {
        state.pendingSwitch = { symbol: requested, reads: 0, ...state.nextSettle };
        state.nextSettle = null;
      }
      return { result: { value: true } };
    }

    // connection.js getActiveMainSeriesIdentity() poll read
    if (expression.includes('series.bars()') && expression.includes('barCount')) {
      applyPendingSwitchIfSettled();
      return { result: { value: { symbol: state.activeSymbol, barCount: state.bars.length } } };
    }

    // data.js getOhlcv() read
    if (expression.includes('active_symbol: activeSymbol')) {
      applyPendingSwitchIfSettled();
      return {
        result: {
          value: {
            bars: state.bars,
            total_bars: state.bars.length,
            source: 'direct_bars',
            active_symbol: state.activeSymbol,
          },
        },
      };
    }

    // data.js getQuote() read
    if (expression.includes('headerRow')) {
      applyPendingSwitchIfSettled();
      const last = state.bars[state.bars.length - 1];
      return {
        result: {
          value: {
            symbol: state.activeSymbol,
            time: last.time, open: last.open, high: last.high, low: last.low,
            close: last.close, last: last.close, volume: last.volume,
          },
        },
      };
    }

    return { result: { value: null } };
  }

  const client = {
    Runtime: { evaluate: handleEvaluate, enable: async () => {} },
    Page: { enable: async () => {} },
    DOM: { enable: async () => {} },
    close: async () => {},
  };

  return {
    client,
    state,
    evaluateLog,
    /** Arm a pending chart.setSymbol() call to settle after N subsequent identity reads. */
    scheduleSettle(symbol, { basePrice = 4, settleAfterReads = 1 } = {}) {
      state.nextSettle = { symbol, basePrice, settleAfterReads };
    },
    /** Arm a pending switch that NEVER settles (simulates a stuck/failed transition). */
    scheduleNeverSettle() {
      state.nextSettle = { symbol: '__NEVER__', basePrice: 0, settleAfterReads: Infinity };
    },
  };
}
