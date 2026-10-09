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
import { assertSessionConnected } from './session.js';
import { verifyIdentity } from './identity.js';

// Bounded post-switch data-readiness gate defaults. After a symbol switch the
// resident bar buffer can briefly still hold the PREVIOUS symbol's data even
// though the symbol label has already flipped (see readFreshBars). We poll the
// proven getOhlcv path a bounded number of times, exiting the INSTANT the data
// diverges — this is NOT a fixed sleep and never blocks the full window on a
// healthy switch.
const DEFAULT_READINESS_POLLS = 8;
const DEFAULT_READINESS_INTERVAL_MS = 150;

// Minimum number of COMPLETED (non-final) bars required for the binding
// fingerprint (see bindingFingerprint) to be a trustworthy cross-symbol
// identifier. Below this we cannot safely distinguish two instruments by their
// completed history alone and fall back to the full series rather than silently
// accept an ambiguous match.
const MIN_COMPLETED_BARS = 2;

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
 * Binding/contamination identity for the cross-symbol readiness guard.
 *
 * The guard must answer one question: "do these bars still belong to the
 * PREVIOUS symbol's resident buffer?" The FINAL bar is the worst possible basis
 * for that: during an open session it is the live FORMING bar whose
 * close/high/low/volume tick continuously, evolving INDEPENDENTLY of which
 * instrument is bound. A full-series fingerprint therefore changes merely
 * because the forming bar ticked — which falsely "proves" a new binding even
 * though the resident buffer is still the previous symbol's (the live DPM→A1M
 * contamination: A1M returned DPM's completed history with a slightly different
 * forming-bar volume, so the full fingerprint differed and stale data was
 * accepted).
 *
 * So we fingerprint every bar EXCEPT the final one. Hundreds of COMPLETED
 * historical bars are a far stronger, stable binding identifier, and an evolving
 * final/forming bar can no longer mask that two different symbols share the same
 * completed history. This is GENERIC: it never inspects dates, session hours, or
 * holidays — it simply excludes the most-mutable last bar.
 *
 * When the series is too short to have MIN_COMPLETED_BARS completed bars we fall
 * back to the full-series fingerprint — the strongest signal available for such
 * a short series. The cross-symbol guard still runs on it, so a genuinely
 * identical short series still polls / fails closed rather than being silently
 * relabeled.
 *
 * NOTE: this is ONLY the internal readiness/contamination guard. It is NOT the
 * dump-file checksum — the output file's SHA-256 always covers the exact
 * complete bytes, including the final live/forming bar.
 */
export function bindingFingerprint(bars) {
  const completed = bars.slice(0, -1);
  if (completed.length >= MIN_COMPLETED_BARS) return fingerprintBars(completed);
  return fingerprintBars(bars);
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
 * series' COMPLETED HISTORY is byte-identical to it (binding-fingerprint match),
 * the buffer has not yet refreshed. We then poll the SAME getOhlcv path until the
 * completed history demonstrably diverges (data now belongs to the new binding)
 * and return that, or FAIL CLOSED with an explicit STALE_SERIES_AFTER_SYMBOL_SWITCH
 * error if it never diverges. Bounded (no infinite retries) and exits early the
 * instant the completed history changes (not a fixed multi-second sleep).
 *
 * CRITICAL: the comparison uses bindingFingerprint (completed history, final bar
 * excluded) — NOT the full series. During an open session the previous symbol's
 * forming bar ticks between reads, so a full-series fingerprint would differ even
 * while the resident buffer is still stale, defeating the guard (the live DPM→A1M
 * contamination). A mutating final/forming bar must never be accepted as proof of
 * a new binding.
 *
 * Returns { bars, fingerprint }, where `fingerprint` is the BINDING fingerprint
 * (completed history) used as the reference for the next symbol's guard. Throws
 * on empty data or persistent staleness.
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
  let fp = bindingFingerprint(bars);

  const crossSymbol =
    prevSymbol != null && normalizeSymbol(symbol) !== normalizeSymbol(prevSymbol);

  // Only a cross-symbol COMPLETED-history match is suspicious. Identical data for
  // the SAME requested instrument (e.g. re-read, or two feed prefixes of one
  // ticker) is legitimate and never flagged. A differing current/forming bar does
  // NOT clear the suspicion — only a divergent completed history does.
  if (crossSymbol && prevFingerprint != null && fp === prevFingerprint) {
    for (let poll = 0; poll < maxPolls; poll++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const next = await read();
      const nextFp = bindingFingerprint(next);
      if (nextFp !== prevFingerprint) {
        return { bars: next, fingerprint: nextFp }; // completed history diverged → new binding proven
      }
      bars = next;
      fp = nextFp;
    }
    throw new Error(
      `STALE_SERIES_AFTER_SYMBOL_SWITCH: ${symbol} returned a COMPLETED-history series byte-identical to `
        + `the previous symbol ${JSON.stringify(prevSymbol)} through ${maxPolls} readiness polls — the `
        + `resident bar buffer never refreshed to the new binding (a mutating final/forming bar does not `
        + `prove a new binding). Refusing to write ${JSON.stringify(prevSymbol)}'s bars under ${symbol}.`
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
  const got = await readFreshBars({ symbol, count, prevSymbol, prevFingerprint, maxPolls, intervalMs });
  // Independent identity: the label/fingerprint guards above use the chart's own
  // state, which a frozen or half-switched chart can make agree with itself (RMS
  // label over COH bars, 2026-10-09). Compare the captured close with a reference
  // that does not come from the chart. A mismatch or an unavailable reference is a
  // failed attempt (retried once by the caller, then failed closed).
  const last = got.bars[got.bars.length - 1];
  const identity = await verifyIdentity(symbol, last.close);
  if (identity.status === 'MISMATCH') {
    throw new Error(
      `IDENTITY_MISMATCH: ${symbol} captured last close ${identity.captured_close} but the independent `
        + `reference for ${identity.symbol} is ${identity.reference_close} (ratio ${identity.ratio}) — these bars `
        + `belong to another instrument. Refusing to write them under ${symbol}.`
    );
  }
  if (identity.status === 'UNAVAILABLE') {
    throw new Error(
      `IDENTITY_UNVERIFIED: independent price reference for ${identity.symbol} unavailable (${identity.reason}); `
        + `cannot prove these bars belong to ${symbol}. Refusing to write them.`
    );
  }
  return { ...got, identity };
}

/**
 * Capture the PRE-CALL active-chart binding to seed the contamination guard for
 * the FIRST requested symbol. Every symbol switch needs a previous binding
 * reference — including symbols[0]. When this call begins the chart is already
 * parked on some instrument; that resident series is the implicit "previous
 * successful" binding for the first requested symbol. Without it symbols[0] is
 * unguarded and can silently inherit the pre-existing buffer (the live 2026-09-09
 * A1M→RHC contamination). We read it through the SAME getOhlcv primitive — no
 * `symbol` arg means "whatever is active", which never relabels data.
 *
 * A trustworthy baseline is symbol-present + at least MIN_COMPLETED_BARS bars (a
 * mid-load single/empty buffer is not trustworthy). If the active series is only
 * TEMPORARILY unavailable (chart still loading) we do a SMALL BOUNDED readiness
 * retry on the SAME cadence as the per-symbol readiness gate, exiting the INSTANT
 * a usable series appears — never an arbitrary long sleep. If a trustworthy
 * baseline still cannot be obtained we FAIL CLOSED with PRECALL_BINDING_UNAVAILABLE
 * so the caller aborts BEFORE switching/acquiring/writing any requested symbol:
 * without a safe reference the first symbol cannot be verified, and accepting it
 * unguarded would recreate the A1M→RHC integrity hole. This is an acquisition-safety
 * failure, not a per-ticker analytical failure.
 *
 * Returns { symbol, fingerprint } (fingerprint = COMPLETED-history bindingFingerprint).
 */
async function captureActiveBinding({ count, maxPolls, intervalMs }) {
  const tryRead = async () => {
    let r;
    try {
      r = await getOhlcv({ count });
    } catch {
      return null; // series/data not ready yet — treated as "not available yet"
    }
    if (r && r.symbol && Array.isArray(r.bars) && r.bars.length >= MIN_COMPLETED_BARS) {
      return { symbol: r.symbol, fingerprint: bindingFingerprint(r.bars) };
    }
    return null; // symbol/bars insufficient to be a trustworthy baseline
  };

  // Initial read + bounded readiness polling (exit the instant a usable series
  // appears; never loops beyond maxPolls).
  let baseline = await tryRead();
  for (let poll = 0; baseline == null && poll < maxPolls; poll++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    baseline = await tryRead();
  }
  if (baseline == null) {
    throw new Error(
      `PRECALL_BINDING_UNAVAILABLE: could not read a trustworthy active chart series `
        + `(a bound symbol with >= ${MIN_COMPLETED_BARS} bars) through an initial read + ${maxPolls} readiness `
        + `polls, so there is no safe reference to verify the first requested symbol against. Refusing to acquire `
        + `an UNGUARDED symbols[0] — that would recreate the A1M→RHC integrity hole where the first symbol `
        + `silently inherits the pre-existing chart buffer. Failing the whole dump before switching or writing `
        + `any symbol. Ensure TradingView is loaded with an active chart and retry.`
    );
  }
  return baseline;
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

  // 0. A disconnected TradingView session freezes the data feed while symbol switches
  //    still relabel the chart — nothing read in that state can be trusted.
  await assertSessionConnected();

  // 1. Set the requested timeframe ONCE. Resolution persists across the
  //    per-symbol setSymbol() calls below, so this need not repeat.
  await setTimeframe({ timeframe });

  const okSymbols = {}; // file: { symbol: { bars: [...] } } — successful only
  const failures = {};  // file: { symbol: "error message" }
  const perSymbol = {}; // response metadata for EVERY requested symbol

  // Binding identity of the last SUCCESSFULLY acquired series — the reference the
  // post-switch contamination guard compares each NEW symbol against. This is the
  // COMPLETED-history (bindingFingerprint) value, never the full series, so an
  // evolving forming bar cannot mask stale data. Updated only on success, so a
  // failed symbol never poisons the reference.
  //
  // SEED IT WITH THE PRE-CALL ACTIVE BINDING so the FIRST requested symbol is
  // guarded exactly like every in-call transition (see captureActiveBinding). The
  // capture runs AFTER setTimeframe so the baseline is on the same resolution as the
  // per-symbol reads. If a trustworthy baseline cannot be established — even after
  // bounded readiness polling — captureActiveBinding THROWS PRECALL_BINDING_UNAVAILABLE
  // and this whole dump fails closed BEFORE any requested symbol is switched,
  // acquired or written. We never fall back to an unguarded symbols[0]: without a
  // safe reference the first symbol cannot be verified and would recreate the
  // A1M→RHC integrity hole.
  const baseline = await captureActiveBinding({
    count,
    maxPolls: readinessPolls,
    intervalMs: readinessIntervalMs,
  });
  let prevSymbol = baseline.symbol;
  let prevFingerprint = baseline.fingerprint;

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
        identity: acquired.identity ? acquired.identity.status : null,
        identity_reference_close: acquired.identity ? acquired.identity.reference_close ?? null : null,
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

  // A session that dropped DURING acquisition taints everything read in this call.
  await assertSessionConnected();

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
