/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import {
  getClient, getClientUnchecked, disconnect, pinTarget, getPinnedTarget, markVerified,
  blockChartAccess, clearBlock, chartIdFromUrl, CDP_HOST, CDP_PORT,
} from '../connection.js';
import { list as listPanes } from './pane.js';

export { chartIdFromUrl };

export const LIVE_IDENTITY_EXPR = '({ url: window.location.href, title: document.title })';

// Saved-layout registry lookup: TradingViewApi.getSavedCharts() lists each saved
// layout with its numeric `id` and its chart short id in `url`.
const SAVED_LAYOUT_EXPR = `new Promise(function (resolve) {
  try {
    window.TradingViewApi.getSavedCharts(function (charts) {
      resolve((charts || []).map(function (c) { return { id: c.id, url: c.url || null, name: c.name || null }; }));
    });
    setTimeout(function () { resolve(null); }, 5000);
  } catch (e) { resolve(null); }
})`;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const pin = getPinnedTarget();
  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: chartIdFromUrl(t.url),
      pinned: !!pin && pin.id === t.id,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/** Evaluate through the UNGATED client (tab selection must read before it verifies). */
async function rawEvaluate(expression, awaitPromise = false) {
  const c = await getClientUnchecked();
  const r = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    throw new Error(`JS evaluation error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

/**
 * Bring a target to the front, then pin and reconnect the CDP client to it, so
 * every later read/write talks to THIS tab (activation alone does not move the
 * client). Returns the page's LIVE url/title, read through the new connection.
 */
async function activateAndPin(target) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
  if (!resp.ok) throw new Error(`Failed to activate tab ${target.id}: HTTP ${resp.status}`);
  await disconnect();
  pinTarget(target.id, target.chart_id);
  const live = await rawEvaluate(LIVE_IDENTITY_EXPR);
  return { url: live?.url || '', title: live?.title || '' };
}

/**
 * Switch to a tab by index. Pins and reconnects CDP to that tab and reports the
 * live identity. It does NOT verify which layout the tab holds (use selectTab);
 * with TV_REQUIRE_VERIFIED_TAB=1, chart access stays refused until selectTab verifies.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${index} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];
  const live = await activateAndPin(target);
  clearBlock(); // an explicit, unverified choice by the caller
  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id,
    live_url: live.url, live_title: live.title, live_chart_id: chartIdFromUrl(live.url), pinned: true, verified: false };
}

/**
 * Deterministically select the ONE open tab holding a saved layout, by the layout's
 * chart short id (the "/chart/<id>/" URL segment shown by tab_list).
 *
 *   VERIFIED   exactly one tab matched; after pinning, the page's LIVE url carries
 *              chart_id, its live title contains title_contains (if given) and the
 *              saved layout layout_id (if given) has that short id
 *   MISSING    no open tab has that chart id          (nothing activated)
 *   AMBIGUOUS  more than one open tab has it           (nothing activated)
 *   MISMATCH   the pinned page's live identity does not prove the layout
 *              (e.g. a different layout was loaded into that tab in place)
 *
 * success is true ONLY for VERIFIED. Any other outcome, or an error, BLOCKS chart
 * access in this process until a later selectTab verifies, so no read can continue
 * against an unverified tab. Tab activation alone is never treated as proof.
 */
export async function selectTab({ chart_id, title_contains, layout_id } = {}) {
  const wanted = String(chart_id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(wanted)) {
    throw new Error('chart_id required: the saved layout short id from a tab URL (/chart/<id>/), see tab_list');
  }
  const wantLayout = layout_id != null && layout_id !== '';
  if (wantLayout && !/^\d{1,15}$/.test(String(layout_id))) {
    throw new Error('layout_id must be the numeric saved layout id (see layout_list)');
  }
  blockChartAccess(`SELECTING ${wanted}`);
  try {
    const { tabs } = await list();
    const matches = tabs.filter(t => t.chart_id === wanted);
    const base = { chart_id: wanted, tab_count: tabs.length };
    if (matches.length === 0) {
      blockChartAccess(`MISSING: no open tab with chart ${wanted}`);
      return { success: false, status: 'MISSING', ...base };
    }
    if (matches.length > 1) {
      blockChartAccess(`AMBIGUOUS: ${matches.length} open tabs with chart ${wanted}`);
      return { success: false, status: 'AMBIGUOUS', ...base, tab_ids: matches.map(t => t.id) };
    }

    const target = matches[0];
    const live = await activateAndPin(target);
    const liveChartId = chartIdFromUrl(live.url);
    const checks = {
      live_url_chart_id: liveChartId === wanted,
      title_contains: title_contains ? live.title.includes(title_contains) : null,
      layout_id: null,
    };
    let savedLayout = null;
    if (wantLayout) {
      const saved = await rawEvaluate(SAVED_LAYOUT_EXPR, true);
      savedLayout = Array.isArray(saved) ? saved.find(c => String(c.id) === String(layout_id)) || null : null;
      checks.layout_id = !!savedLayout && savedLayout.url === wanted;
    }
    const ok = Object.values(checks).every(v => v !== false);
    if (ok) markVerified();
    else blockChartAccess(`MISMATCH: live identity of tab ${target.id} does not prove chart ${wanted}`);
    return {
      success: ok,
      status: ok ? 'VERIFIED' : 'MISMATCH',
      ...base,
      tab_id: target.id,
      index: target.index,
      pinned: true,
      verified: ok,
      live_url: live.url,
      live_title: live.title,
      live_chart_id: liveChartId,
      saved_layout: savedLayout,
      checks,
    };
  } catch (err) {
    blockChartAccess(`SELECT_ERROR: ${err.message}`);
    throw err;
  }
}

/**
 * Single-process chart preflight: select + verify the tab, then read its panes and
 * re-check its live identity, all through ONE pinned, verified connection. The pin
 * lives in this process only; a later, separate process (e.g. the next CLI call)
 * starts unpinned and must select again.
 *
 *   READY           identity verified, panes match `resolutions` (in pane order),
 *                   and the live url still carries chart_id after the pane read
 *   MISSING / AMBIGUOUS / MISMATCH   as selectTab
 *   PANES_MISMATCH  verified tab, wrong pane count or resolutions
 *   ERROR           connection/evaluation failure
 */
export async function preflight({ chart_id, title_contains, layout_id, resolutions } = {}) {
  const expected = (Array.isArray(resolutions) ? resolutions : String(resolutions || '').split(','))
    .map(r => String(r).trim()).filter(Boolean);
  if (expected.length === 0) throw new Error('resolutions required, e.g. "240,60"');
  let sel;
  try {
    sel = await selectTab({ chart_id, title_contains, layout_id });
  } catch (err) {
    return { success: false, ready: false, status: 'ERROR', chart_id, error: err.message };
  }
  if (!sel.success) return { ...sel, ready: false };
  try {
    const panes = await listPanes(); // gated: only reachable while verified
    const got = (panes.panes || []).map(p => (p.resolution == null ? null : String(p.resolution)));
    const panesOk = got.length === expected.length && got.every((r, i) => r === expected[i]);
    const after = await rawEvaluate(LIVE_IDENTITY_EXPR);
    const stillOk = chartIdFromUrl(after?.url) === sel.chart_id;
    if (!stillOk) blockChartAccess('MISMATCH: live identity changed during preflight');
    const status = !stillOk ? 'MISMATCH' : panesOk ? 'READY' : 'PANES_MISMATCH';
    return {
      success: status === 'READY',
      ready: status === 'READY',
      status,
      chart_id: sel.chart_id,
      tab_id: sel.tab_id,
      live_url: after?.url || sel.live_url,
      live_title: after?.title || sel.live_title,
      saved_layout: sel.saved_layout,
      checks: sel.checks,
      expected_resolutions: expected,
      pane_resolutions: got,
      panes: (panes.panes || []).map(p => ({ index: p.index, symbol: p.symbol, resolution: p.resolution })),
    };
  } catch (err) {
    blockChartAccess(`PREFLIGHT_ERROR: ${err.message}`);
    return { success: false, ready: false, status: 'ERROR', chart_id: sel.chart_id, error: err.message };
  }
}
