/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate, disconnect, pinTarget, getPinnedTarget } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/** The saved-layout short id in a chart URL (".../chart/<id>/"), or null. */
export function chartIdFromUrl(url) {
  return String(url || '').match(/\/chart\/([^/?#]+)/)?.[1] || null;
}

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
  await getClient();
  const live = await evaluate('({ url: window.location.href, title: document.title })');
  return { url: live?.url || '', title: live?.title || '' };
}

/**
 * Switch to a tab by index. Pins and reconnects CDP to that tab and reports the
 * live identity; it does not verify WHICH layout the tab holds (use selectTab).
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${index} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];
  const live = await activateAndPin(target);
  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id,
    live_url: live.url, live_title: live.title, live_chart_id: chartIdFromUrl(live.url), pinned: true };
}

/**
 * Deterministically select the ONE open tab holding a saved layout, by the layout's
 * chart short id (the "/chart/<id>/" URL segment shown by tab_list).
 *
 *   VERIFIED   exactly one tab matched; after pinning, the page's LIVE url carries
 *              chart_id (and its live title contains title_contains, if given)
 *   MISSING    no open tab has that chart id          (nothing activated)
 *   AMBIGUOUS  more than one open tab has it           (nothing activated)
 *   MISMATCH   the pinned page's live url/title do not prove the identity
 *              (e.g. a different layout was loaded into that tab in place)
 *
 * success is true ONLY for VERIFIED. Callers must treat anything else as "do not
 * use the chart". The tab activation response alone is never treated as proof.
 */
export async function selectTab({ chart_id, title_contains } = {}) {
  const wanted = String(chart_id || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(wanted)) {
    throw new Error('chart_id required: the saved layout short id from a tab URL (/chart/<id>/), see tab_list');
  }
  const { tabs } = await list();
  const matches = tabs.filter(t => t.chart_id === wanted);
  const base = { chart_id: wanted, tab_count: tabs.length };
  if (matches.length === 0) return { success: false, status: 'MISSING', ...base };
  if (matches.length > 1) {
    return { success: false, status: 'AMBIGUOUS', ...base, tab_ids: matches.map(t => t.id) };
  }

  const target = matches[0];
  const live = await activateAndPin(target);
  const liveChartId = chartIdFromUrl(live.url);
  const urlOk = liveChartId === wanted;
  const titleOk = title_contains == null || title_contains === '' || live.title.includes(title_contains);
  const status = urlOk && titleOk ? 'VERIFIED' : 'MISMATCH';
  return {
    success: status === 'VERIFIED',
    status,
    ...base,
    tab_id: target.id,
    index: target.index,
    pinned: true,
    live_url: live.url,
    live_title: live.title,
    live_chart_id: liveChartId,
    checks: { live_url_chart_id: urlOk, title_contains: title_contains ? titleOk : null },
  };
}
