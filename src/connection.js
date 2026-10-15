import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// Tab pinning and verification (process-local, by design: every new process,
// e.g. each CLI invocation or MCP server start, begins unpinned and unverified).
//
// pinned:   once a tab is selected (tab_select / tab_switch), every (re)connection
//           attaches to THAT CDP target id and never falls back to another tab.
// verified: tab_select proved the pinned page's LIVE url carries chartId. Every
//           liveness check and reconnect re-reads the live url; a change revokes it.
// blocked:  set when a selection failed (MISSING/AMBIGUOUS/MISMATCH/error), the
//           pinned tab closed, or its live identity changed. While set, every
//           getClient() (so every chart read/write) fails until a new tab_select
//           verifies. Unpinned, never-selected processes behave as before unless
//           TV_REQUIRE_VERIFIED_TAB=1, which refuses all chart access until a
//           tab_select has VERIFIED in this process.
let pinned = null; // { id, chartId, verified }
let blocked = null; // reason string
const CDP_HOST = process.env.TV_CDP_HOST || 'localhost';
const CDP_PORT = Number(process.env.TV_CDP_PORT || 9222);
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

export { CDP_HOST, CDP_PORT };
export const LOCATION_EXPR = 'window.location.href';

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

export function requireVerifiedTab() {
  return process.env.TV_REQUIRE_VERIFIED_TAB === '1';
}

export function chartIdFromUrl(url) {
  return String(url || '').match(/\/chart\/([^/?#]+)/)?.[1] || null;
}

/** Chart access gate: every tool reaches the page through this. */
export async function getClient() {
  if (blocked) {
    throw new Error(`TradingView tab not verified (${blocked}); call tab_select to select and verify a tab.`);
  }
  if (requireVerifiedTab() && !pinned?.verified) {
    throw new Error('No verified TradingView tab in this process (TV_REQUIRE_VERIFIED_TAB=1); call tab_select first.');
  }
  return getClientUnchecked();
}

/** Raw connection for tab selection itself; bypasses the gate but still pins. */
export async function getClientUnchecked() {
  if (client) {
    let alive = false;
    try {
      // Liveness check; for a verified pin it is also a live identity check.
      const r = await client.Runtime.evaluate({ expression: pinned?.verified ? LOCATION_EXPR : '1', returnByValue: true });
      alive = true;
      if (pinned?.verified) assertLiveIdentity(r.result?.value);
      return client;
    } catch (err) {
      if (alive) throw err; // identity revoked: do not reconnect around it
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

function assertLiveIdentity(liveUrl) {
  const live = chartIdFromUrl(liveUrl);
  if (live !== pinned.chartId) {
    pinned.verified = false;
    blocked = `IDENTITY_CHANGED: pinned tab now shows ${live || 'no chart'}, expected ${pinned.chartId}`;
    throw new Error(`TradingView tab not verified (${blocked}); call tab_select to select and verify a tab.`);
  }
}

export function pinTarget(id, chartId = null, { verified = false } = {}) {
  pinned = id ? { id, chartId, verified: !!verified } : null;
}

export function markVerified() {
  if (!pinned) throw new Error('markVerified: no pinned tab');
  pinned.verified = true;
  blocked = null;
}

/** Revoke chart access until a new tab_select verifies (fail closed). */
export function blockChartAccess(reason) {
  if (pinned) pinned.verified = false;
  blocked = String(reason || 'UNVERIFIED');
}

export function clearBlock() {
  blocked = null;
}

export function unpinTarget() {
  pinned = null;
  blocked = null;
}

export function getPinnedTarget() {
  return pinned ? { ...pinned } : null;
}

export function getAccessState() {
  return { pinned: getPinnedTarget(), blocked, require_verified_tab: requireVerifiedTab() };
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

      if (pinned?.verified) {
        // A reconnect must land on the SAME live layout, not merely the same tab id.
        const r = await client.Runtime.evaluate({ expression: LOCATION_EXPR, returnByValue: true });
        try {
          assertLiveIdentity(r.result?.value);
        } catch (err) {
          err.noRetry = true;
          throw err;
        }
      }
      return client;
    } catch (err) {
      lastError = err;
      if (err.pinnedTargetGone || err.noRetry) break; // fail fast: never retry onto another tab
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  if (lastError?.pinnedTargetGone || lastError?.noRetry) {
    if (client) { try { await client.close(); } catch {} client = null; targetInfo = null; }
    throw lastError;
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  if (pinned) {
    const t = targets.find(x => x.id === pinned.id);
    if (!t) {
      blockChartAccess(`TAB_CLOSED: pinned tab ${pinned.id} is no longer open`);
      const err = new Error(`Pinned TradingView tab ${pinned.id} is no longer open; select a tab again (tab_select).`);
      err.pinnedTargetGone = true;
      throw err;
    }
    return t;
  }
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
