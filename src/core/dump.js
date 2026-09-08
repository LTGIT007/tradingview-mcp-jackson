/**
 * Core: server-side multi-symbol OHLCV dump.
 *
 * Fetches OHLCV for a list of symbols SEQUENTIALLY (a single active chart has
 * exactly one main series, so concurrency is impossible — not merely
 * undesirable) and writes the raw bars directly to a JSON file under the
 * MCP-owned dumps/ directory. This keeps large OHLCV payloads OUT of the model
 * context — only compact metadata is returned to the caller.
 *
 * This module does NOT re-implement symbol switching, readiness, or OHLCV
 * reading. It composes the existing, already-tested primitives:
 *   - pane.setSymbol()     → focus + chart.setSymbol + fail-closed
 *                            waitForActiveSymbol() (the series-identity guard)
 *   - chart.setTimeframe() → resolution set (done ONCE, up front)
 *   - data.getOhlcv()      → mainSeries.bars() read + active-symbol identity
 *                            guard (the SAME primitive data_get_ohlcv uses)
 *
 * Deliberately GENERIC TradingView infrastructure. It does not convert dates,
 * decide FORMING vs COMPLETED, compute indicators/RS, or understand any
 * strategy (Agent 1/2/3, developing/active, VCP). Those belong downstream.
 */
import { createHash } from 'crypto';
import { writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname, resolve, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { getOhlcv } from './data.js';
import { setSymbol as paneSetSymbol } from './pane.js';
import { setTimeframe } from './chart.js';
import { normalizeSymbol } from '../connection.js';

// Bounded post-switch data-readiness gate defaults. After a symbol switch the
// resident bar buffer can briefly still hold the PREVIOUS symbol's data even
// though the symbol label has already flipped (see readFreshBars). We poll the
// proven getOhlcv path a bounded number of times, exiting the INSTANT the data
// diverges — this is NOT a fixed sleep and never blocks the full window on a
// healthy switch.
const DEFAULT_READINESS_POLLS = 8;
const DEFAULT_READINESS_INTERVAL_MS = 150;

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/core/dump.js → repo root is two directories up from src/core.
const REPO_ROOT = dirname(dirname(__dirname));
export const DUMP_DIR = join(REPO_ROOT, 'dumps');

/**
 * Resolve a caller-supplied filename to a safe absolute path INSIDE DUMP_DIR.
 * The caller supplies a plain file name only — never a path. Rejects absolute
 * paths, "..", and any path separators (the dumps dir is flat), then verifies
 * the resolved path cannot escape DUMP_DIR (defence in depth).
 */
export function resolveDumpPath(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('filename is required (a plain file name, no path).');
  }
  const name = filename.trim();
  if (isAbsolute(name)) throw new Error(`filename must be a plain name, not an absolute path: ${filename}`);
  if (name.includes('..')) throw new Error(`filename must not contain "..": ${filename}`);
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`filename must not contain path separators: ${filename}`);
  }
  const withExt = name.toLowerCase().endsWith('.json') ? name : `${name}.json`;
  const base = resolve(DUMP_DIR);
  const full = resolve(base, withExt);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Resolved path escapes the dumps directory: ${full}`);
  }
  return full;
}

/**
 * Deterministic SHA-256 fingerprint over a series' native OHLCV fields, in the
 * order the bars are given (they are time-ordered). This is used ONLY to detect
 * stale-series contamination: two DIFFERENT requested symbols must never yield a
 * byte-identical series. It is not a data checksum for storage — just a compact,
 * order-sensitive identity for the read buffer.
 */
export function fingerprintBars(bars) {
  const h = createHash('sha256');
  for (const b of bars) {
    h.update(`${b.time}|${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}\n`);
  }
  return h.digest('hex');
}

/**
 * Read the active pane's series via the shared getOhlcv primitive and PROVE the
 * returned bars belong to the new binding — not the previous symbol's resident
 * buffer.
 *
 * The symbol-identity guards in pane.setSymbol()/getOhlcv() are necessary but
 * NOT sufficient: TradingView flips mainSeries().symbol() to the new ticker
 * BEFORE it swaps the resident bar buffer, so a read landing in that window sees
 * the NEW label over the PREVIOUS symbol's bars — the exact live ANN←CLX
 * corruption. This adds a bounded POSITIVE data-readiness gate: when the
 * requested symbol differs from the previous SUCCESSFUL symbol yet the returned
 * series is byte-identical to it (fingerprint match), the buffer has not yet
 * refreshed. We then poll the SAME getOhlcv path until the series demonstrably
 * diverges (data now belongs to the new binding) and return that, or FAIL CLOSED
 * with an explicit STALE_SERIES_AFTER_SYMBOL_SWITCH error if it never diverges.
 * Bounded (no infinite retries) and exits early the instant data changes (not a
 * fixed multi-second sleep).
 *
 * Returns { bars, fingerprint }. Throws on empty data or persistent staleness.
 */
async function readFreshBars({ symbol, count, prevSymbol, prevFingerprint, maxPolls, intervalMs }) {
  const read = async () => {
    const r = await getOhlcv({ symbol, count });
    if (!r || !Array.isArray(r.bars) || r.bars.length === 0) {
      throw new Error(`No bars returned for ${symbol}`);
    }
    return r.bars;
  };

  let bars = await read();
  let fp = fingerprintBars(bars);

  const crossSymbol =
    prevSymbol != null && normalizeSymbol(symbol) !== normalizeSymbol(prevSymbol);

  // Only a cross-symbol byte-identical series is suspicious. Identical data for
  // the SAME requested instrument (e.g. re-read, or two feed prefixes of one
  // ticker) is legitimate and never flagged.
  if (crossSymbol && prevFingerprint != null && fp === prevFingerprint) {
    for (let poll = 0; poll < maxPolls; poll++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const next = await read();
      const nextFp = fingerprintBars(next);
      if (nextFp !== prevFingerprint) {
        return { bars: next, fingerprint: nextFp }; // diverged → new binding proven
      }
      bars = next;
      fp = nextFp;
    }
    throw new Error(
      `STALE_SERIES_AFTER_SYMBOL_SWITCH: ${symbol} returned a series byte-identical to the previous `
        + `symbol ${JSON.stringify(prevSymbol)} through ${maxPolls} readiness polls — the resident bar `
        + `buffer never refreshed to the new binding. Refusing to write ${JSON.stringify(prevSymbol)}'s `
        + `bars under ${symbol}.`
    );
  }

  return { bars, fingerprint: fp };
}

/**
 * Acquire one symbol: switch the active chart to it (with fail-closed
 * readiness) then read its bars via the shared getOhlcv primitive, proving the
 * bars belong to the new binding (readFreshBars). Throws on any failure so the
 * caller can apply its retry / soft-fail policy.
 */
async function acquireSymbol({ symbol, count, timeoutMs, prevSymbol, prevFingerprint, maxPolls, intervalMs }) {
  await paneSetSymbol({ index: 0, symbol, timeoutMs });
  return readFreshBars({ symbol, count, prevSymbol, prevFingerprint, maxPolls, intervalMs });
}

export async function dumpOhlcv({
  symbols,
  timeframe = 'D',
  count = 350,
  filename,
  timeoutMs,
  readinessPolls = DEFAULT_READINESS_POLLS,
  readinessIntervalMs = DEFAULT_READINESS_INTERVAL_MS,
} = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error('symbols must be a non-empty array.');
  }
  // Validate the destination BEFORE doing any slow acquisition work.
  const finalPath = resolveDumpPath(filename);
  const started = Date.now();

  // 1. Set the requested timeframe ONCE. Resolution persists across the
  //    per-symbol setSymbol() calls below, so this need not repeat.
  await setTimeframe({ timeframe });

  const okSymbols = {}; // file: { symbol: { bars: [...] } } — successful only
  const failures = {};  // file: { symbol: "error message" }
  const perSymbol = {}; // response metadata for EVERY requested symbol

  // Identity of the last SUCCESSFULLY acquired series — the reference the
  // post-switch contamination guard compares each NEW symbol against. Updated
  // only on success, so a failed symbol never poisons the reference.
  let prevSymbol = null;
  let prevFingerprint = null;

  // 2. Sequential acquisition. One symbol failing never aborts the rest.
  for (const symbol of symbols) {
    let acquired = null;
    let lastErr = null;
    // One initial attempt + at most ONE rebind retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        acquired = await acquireSymbol({
          symbol,
          count,
          timeoutMs,
          prevSymbol,
          prevFingerprint,
          maxPolls: readinessPolls,
          intervalMs: readinessIntervalMs,
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        acquired = null;
      }
    }

    if (acquired) {
      const bars = acquired.bars;
      okSymbols[symbol] = { bars };
      const first = bars[0];
      const last = bars[bars.length - 1];
      perSymbol[symbol] = {
        bars: bars.length,
        first_time: first.time,
        last_time: last.time,
        last_close: last.close,
        error: null,
      };
      prevSymbol = symbol;
      prevFingerprint = acquired.fingerprint;
    } else {
      const msg = lastErr ? lastErr.message : 'unknown error';
      failures[symbol] = msg;
      perSymbol[symbol] = { bars: 0, first_time: null, last_time: null, last_close: null, error: msg };
    }
  }

  // 3. Build the generic raw file object (native getOhlcv bar fields intact).
  const fileObj = {
    source: 'tradingview',
    captured_at: new Date().toISOString(),
    timeframe,
    requested_count: count,
    symbols: okSymbols,
    failures,
  };
  const bytes = Buffer.from(JSON.stringify(fileObj, null, 2), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // 4. Atomic write: write a temp file on the same filesystem, then rename.
  mkdirSync(DUMP_DIR, { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  try {
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }

  // 5. Compact metadata ONLY — raw bars are never returned to the caller.
  return {
    path: finalPath,
    source: 'tradingview',
    timeframe,
    requested_count: count,
    captured_at: fileObj.captured_at,
    symbols_requested: symbols.length,
    symbols_succeeded: Object.keys(okSymbols).length,
    symbols_failed: Object.keys(failures).length,
    per_symbol: perSymbol,
    elapsed_ms: Date.now() - started,
    sha256,
  };
}
