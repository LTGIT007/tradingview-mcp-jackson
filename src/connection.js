import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  mainSeries: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}

// --- Symbol-binding identity guard ---------------------------------------
// The active chart widget's declared symbol (mainSeries().symbol()) and its
// resident bar buffer (mainSeries().bars()) update asynchronously and NOT
// atomically after chart.setSymbol()/pane focus+setSymbol. A read that lands
// mid-transition can see a symbol label that has already changed while the
// bar buffer still belongs to the PREVIOUS instrument (or vice versa). This
// is the single, reused source of truth for "what is the chart ACTUALLY
// bound to right now" — every symbol-identity check in this codebase should
// go through it rather than re-deriving its own notion of "current symbol".

/**
 * Reduce a TradingView symbol string to a bare ticker for comparison, e.g.
 * "ASX_DLY:RMS" / "ASX:RMS" / "rms" -> "RMS". Deliberately lenient about
 * exchange/feed prefixes (delayed vs realtime feeds for the same instrument
 * must compare equal) but never merges two DIFFERENT tickers.
 */
export function normalizeSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return null;
  const trimmed = symbol.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  return parts[parts.length - 1].toUpperCase();
}

/**
 * Read the symbol and bar-readiness ACTUALLY bound to the active chart
 * widget's main series, in one atomic evaluate() round trip (reading symbol
 * and bar count in separate calls would reopen the exact race this guards
 * against).
 */
export async function getActiveMainSeriesIdentity() {
  const data = await evaluate(`
    (function() {
      var symbol = null, barCount = 0;
      try {
        var series = ${KNOWN_PATHS.mainSeries};
        try { symbol = series.symbol(); } catch(e) {}
        try {
          var bars = series.bars();
          if (bars && typeof bars.size === 'function') barCount = bars.size();
        } catch(e) {}
      } catch(e) {}
      return { symbol: symbol, barCount: barCount };
    })()
  `);
  return {
    symbol: data?.symbol ?? null,
    barCount: data?.barCount ?? 0,
    ready: !!data?.symbol && (data?.barCount ?? 0) > 0,
  };
}

/**
 * Poll (bounded) until the active main series is genuinely bound to
 * `requestedSymbol` AND has bars available. Returns the settled identity on
 * success; throws (fail closed — never resolves as "probably fine") if the
 * requested symbol never settles within the timeout.
 */
export async function waitForActiveSymbol(
  requestedSymbol,
  { timeoutMs = 5000, intervalMs = 150 } = {}
) {
  const wanted = normalizeSymbol(requestedSymbol);
  if (!wanted) {
    throw new Error(`waitForActiveSymbol requires a non-empty symbol, got ${JSON.stringify(requestedSymbol)}.`);
  }
  const deadline = Date.now() + timeoutMs;
  let last = { symbol: null, barCount: 0, ready: false };
  while (Date.now() < deadline) {
    last = await getActiveMainSeriesIdentity();
    if (last.ready && normalizeSymbol(last.symbol) === wanted) {
      return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the active chart to settle on ${JSON.stringify(requestedSymbol)} `
      + `(last observed: symbol=${JSON.stringify(last.symbol)}, barCount=${last.barCount}). `
      + `Refusing to report success — the chart may still be bound to a previous symbol.`
  );
}

/**
 * Verify that `requestedSymbol` reconciles with what is ACTUALLY bound to
 * the active main series right now (no polling — a point-in-time identity
 * check used by read tools like quote/OHLCV, which must never silently
 * relabel stale data). Returns the settled identity on match; throws on
 * mismatch or if the requested symbol is empty.
 */
export function assertActiveSymbolMatches(requestedSymbol, identity) {
  const wanted = normalizeSymbol(requestedSymbol);
  if (!wanted) return; // no symbol requested -> caller wants "whatever is active", nothing to verify
  const actual = normalizeSymbol(identity.symbol);
  if (!identity.ready || actual !== wanted) {
    throw new Error(
      `Symbol identity mismatch: requested ${JSON.stringify(requestedSymbol)} but the active chart is `
        + `bound to ${JSON.stringify(identity.symbol)} (barCount=${identity.barCount}). `
        + `Refusing to return data under the wrong ticker — switch the chart/pane to the requested `
        + `symbol and retry.`
    );
  }
}
