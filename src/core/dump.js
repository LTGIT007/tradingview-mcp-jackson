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
 * Acquire one symbol: switch the active chart to it (with fail-closed
 * readiness) then read its bars via the shared getOhlcv primitive. Throws on
 * any failure so the caller can apply its retry / soft-fail policy.
 */
async function acquireSymbol({ symbol, count, timeoutMs }) {
  await paneSetSymbol({ index: 0, symbol, timeoutMs });
  const r = await getOhlcv({ symbol, count });
  if (!r || !Array.isArray(r.bars) || r.bars.length === 0) {
    throw new Error(`No bars returned for ${symbol}`);
  }
  return r.bars;
}

export async function dumpOhlcv({ symbols, timeframe = 'D', count = 350, filename, timeoutMs } = {}) {
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

  // 2. Sequential acquisition. One symbol failing never aborts the rest.
  for (const symbol of symbols) {
    let bars = null;
    let lastErr = null;
    // One initial attempt + at most ONE retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        bars = await acquireSymbol({ symbol, count, timeoutMs });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        bars = null;
      }
    }

    if (bars) {
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
