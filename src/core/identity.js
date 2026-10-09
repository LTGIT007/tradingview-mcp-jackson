/**
 * Core: independent symbol-identity reference for captured OHLCV.
 *
 * The chart's own label, quote and bar buffer all come from the SAME page state, so
 * none of them can prove that bars belong to the requested instrument (a frozen or
 * half-switched chart shows "RMS" over COH's bars — 2026-10-09). This module asks
 * TradingView's public scanner, which is independent of the chart session, for the
 * instrument's current close and compares it with the captured last close.
 *
 *   VERIFIED              captured close within IDENTITY_TOLERANCE of the reference
 *   MISMATCH              outside tolerance → caller must fail the symbol closed
 *   UNAVAILABLE           reference lookup failed (network/timeout/bad response)
 *                         → caller must fail the symbol closed (identity unproven)
 *   NO_REFERENCE          the scanner does not know the symbol (e.g. ASX indices);
 *                         the caller keeps its other guards and reports it
 */

export const IDENTITY_TOLERANCE = Number(process.env.TV_DUMP_IDENTITY_TOLERANCE || 0.15);
const TIMEOUT_MS = 8000;

/** "ASX_DLY:RMS" / "ASX:RMS" / "RMS" → "ASX:RMS" (scanner symbol). */
export function scannerSymbol(symbol, defaultExchange = 'ASX') {
  const parts = String(symbol).trim().toUpperCase().split(':');
  const ticker = parts[parts.length - 1];
  const exchange = parts.length > 1 ? parts[0].replace(/_DLY$/, '') : defaultExchange;
  return `${exchange}:${ticker}`;
}

export async function independentClose(symbol, { fetchImpl = globalThis.fetch } = {}) {
  const sym = scannerSymbol(symbol);
  const url = `https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(sym)}&fields=close,description`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    const body = await res.json().catch(() => null);
    if (body && body.code === 'symbol_not_exists') return { status: 'NO_REFERENCE', symbol: sym };
    if (!res.ok || !body || typeof body.close !== 'number' || !(body.close > 0)) {
      return { status: 'UNAVAILABLE', symbol: sym, reason: `HTTP ${res.status}` };
    }
    return { status: 'OK', symbol: sym, close: body.close, description: body.description };
  } catch (e) {
    return { status: 'UNAVAILABLE', symbol: sym, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Compare a captured last close with the independent reference. */
export async function verifyIdentity(symbol, lastClose, opts = {}) {
  const ref = await independentClose(symbol, opts);
  if (ref.status !== 'OK') return { ...ref, captured_close: lastClose };
  const ratio = lastClose / ref.close;
  const ok = Number.isFinite(ratio) && Math.abs(ratio - 1) <= IDENTITY_TOLERANCE;
  return { status: ok ? 'VERIFIED' : 'MISMATCH', symbol: ref.symbol, reference_close: ref.close,
    captured_close: lastClose, ratio: Number.isFinite(ratio) ? Math.round(ratio * 10000) / 10000 : null };
}
