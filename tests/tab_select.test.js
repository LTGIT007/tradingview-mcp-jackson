/**
 * Deterministic, offline, in-process tests for tab selection with a pinned and
 * verified CDP connection (see tests/tab_cross_process.test.js for separate
 * CLI / MCP processes against a fake DevTools server).
 *
 * Reproduces the demonstrated defect: with two TradingView chart tabs open,
 * tab_switch only brought a tab to the front while the CDP client stayed attached
 * to the FIRST chart page in /json/list, so every later read came from the other
 * tab. Also covers reconnects, live identity drift, and fail-closed blocking.
 *
 * Both the DevTools HTTP endpoints (fetch) and chrome-remote-interface are faked;
 * the REAL src/connection.js, src/core/tab.js, src/core/pane.js and
 * src/core/health.js run.
 *
 * Run: node --experimental-test-module-mocks --test tests/tab_select.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── fake browser ────────────────────────────────────────────────────────────
// targets: what /json/list reports. live: what each page's window reports NOW
// (may differ from /json/list, e.g. a layout loaded in place).
const browser = {};
function resetBrowser() {
  Object.assign(browser, {
    targets: [], live: {}, activated: [], connects: [], failNextLiveness: false, activateStatus: 0,
    savedCharts: [{ id: 111, url: 'AAAA1111', name: 'Discovery Layout' }, { id: 222, url: 'BBBB2222', name: 'Review Layout' }],
  });
}

function page(id, chartId, title, resolutions = ['240', '60']) {
  browser.targets.push({ id, type: 'page', url: `https://www.tradingview.com/chart/${chartId}/`, title });
  browser.live[id] = { url: `https://www.tradingview.com/chart/${chartId}/`, title, symbol: `SYM_${id}`, resolutions };
}

mock.method(globalThis, 'fetch', async (url) => {
  const u = String(url);
  if (u.endsWith('/json/list')) return { ok: true, status: 200, json: async () => browser.targets.map(t => ({ ...t })) };
  const m = u.match(/\/json\/activate\/(.+)$/);
  if (m) {
    const known = browser.targets.some(t => t.id === m[1]);
    browser.activated.push(m[1]);
    if (browser.activateStatus) return { ok: false, status: browser.activateStatus, text: async () => 'error' };
    return { ok: known, status: known ? 200 : 404, text: async () => (known ? 'Target activated' : 'No such target') };
  }
  throw new Error(`unexpected fetch ${u}`);
});

function evaluateFor(targetId, expression) {
  const live = browser.live[targetId];
  if (expression === '1') return 1;
  if (expression === 'window.location.href') return live.url;
  if (expression.includes('getSavedCharts')) return browser.savedCharts;
  if (expression.includes('inlineChartsCount')) {
    return { layout: '2h', chart_count: live.resolutions.length, active_index: 0,
      panes: live.resolutions.map((r, i) => ({ index: i, symbol: live.symbol, resolution: r })) };
  }
  if (expression.includes('window.location.href') && expression.includes('document.title')) {
    return { url: live.url, title: live.title, symbol: live.symbol, resolution: '60', chartType: 1, apiAvailable: true };
  }
  return null;
}

function fakeClient(targetId) {
  return {
    targetId,
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => {
        if (browser.failNextLiveness && (expression === '1' || expression === 'window.location.href')) {
          browser.failNextLiveness = false;
          throw new Error('socket closed');
        }
        return { result: { value: evaluateFor(targetId, expression) } };
      },
    },
    Page: { enable: async () => {} },
    DOM: { enable: async () => {} },
    close: async () => {},
  };
}

mock.module('chrome-remote-interface', {
  exports: {
    default: async ({ target }) => {
      browser.connects.push(target);
      return fakeClient(target);
    },
  },
});

const conn = await import('../src/connection.js');
const tab = await import('../src/core/tab.js');
const pane = await import('../src/core/pane.js');
const { healthCheck } = await import('../src/core/health.js');

const attachedTo = async () => (await conn.getClient()).targetId;
const NOT_VERIFIED = /TradingView tab not verified/;

beforeEach(async () => {
  await conn.disconnect();
  conn.unpinTarget();
  delete process.env.TV_REQUIRE_VERIFIED_TAB;
  resetBrowser();
  page('T_DISCOVERY', 'AAAA1111', 'XYZ 1.00 Discovery Layout', ['1D', '1D']);
  page('T_REVIEW', 'BBBB2222', 'XYZ 1.00 Review Layout', ['240', '60']);
});

describe('tab_select: deterministic selection with a pinned, verified connection', () => {
  it('reproduces the defect baseline: without a pin the client attaches to the FIRST chart tab', async () => {
    assert.equal(await attachedTo(), 'T_DISCOVERY');
  });

  it('selects the tab by chart id, pins the connection and verifies the LIVE identity', async () => {
    await conn.getClient(); // attached to the first tab, as in the defect
    const r = await tab.selectTab({ chart_id: 'BBBB2222', title_contains: 'Review Layout' });
    assert.equal(r.status, 'VERIFIED');
    assert.equal(r.success, true);
    assert.equal(r.verified, true);
    assert.equal(r.tab_id, 'T_REVIEW');
    assert.deepEqual(browser.activated, ['T_REVIEW']);
    assert.equal(await attachedTo(), 'T_REVIEW', 'reads must now come from the selected tab');
    assert.deepEqual(conn.getPinnedTarget(), { id: 'T_REVIEW', chartId: 'BBBB2222', verified: true });
  });

  it('layout_id: VERIFIED only when the saved layout registry maps that id to the chart id', async () => {
    const ok = await tab.selectTab({ chart_id: 'BBBB2222', layout_id: '222' });
    assert.equal(ok.status, 'VERIFIED');
    assert.deepEqual(ok.saved_layout, { id: 222, url: 'BBBB2222', name: 'Review Layout' });
    const wrong = await tab.selectTab({ chart_id: 'BBBB2222', layout_id: '111' });
    assert.equal(wrong.status, 'MISMATCH');
    assert.equal(wrong.checks.layout_id, false);
    await assert.rejects(conn.getClient(), NOT_VERIFIED);
    const unknown = await tab.selectTab({ chart_id: 'BBBB2222', layout_id: '999' });
    assert.equal(unknown.status, 'MISMATCH');
    assert.equal(unknown.saved_layout, null);
    browser.savedCharts = null; // registry unavailable -> cannot prove -> MISMATCH
    assert.equal((await tab.selectTab({ chart_id: 'BBBB2222', layout_id: '222' })).status, 'MISMATCH');
    await assert.rejects(tab.selectTab({ chart_id: 'BBBB2222', layout_id: 'abc' }), /numeric/);
  });

  it('a reconnect after a dropped connection stays on the pinned tab and re-verifies it', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    browser.failNextLiveness = true;
    assert.equal(await attachedTo(), 'T_REVIEW');
    assert.equal(browser.connects.at(-1), 'T_REVIEW');
  });

  it('reconnect onto the same tab id but a DIFFERENT live layout: blocked, no retry', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    browser.failNextLiveness = true;
    browser.live.T_REVIEW.url = 'https://www.tradingview.com/chart/AAAA1111/';
    const before = browser.connects.length;
    await assert.rejects(conn.getClient(), /IDENTITY_CHANGED/);
    assert.equal(browser.connects.length, before + 1, 'exactly one reconnect attempt, no retry loop');
    await assert.rejects(conn.getClient(), NOT_VERIFIED, 'stays blocked');
  });

  it('live layout replaced in place while connected: the next access is blocked', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    browser.live.T_REVIEW.url = 'https://www.tradingview.com/chart/AAAA1111/';
    await assert.rejects(pane.list(), /IDENTITY_CHANGED/);
    await assert.rejects(pane.list(), NOT_VERIFIED);
    assert.equal(conn.getPinnedTarget().verified, false);
  });

  it('pinned tab closed: fails fast, blocks, never falls back to another tab', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    await conn.disconnect();
    browser.targets = browser.targets.filter(t => t.id !== 'T_REVIEW');
    const before = browser.connects.length;
    await assert.rejects(conn.getClient(), /Pinned TradingView tab T_REVIEW is no longer open/);
    assert.equal(browser.connects.length, before, 'no connection to any other tab');
    await assert.rejects(conn.getClient(), /TAB_CLOSED/);
  });

  it('MISSING: nothing activated, and chart access is blocked until a successful select', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    const r = await tab.selectTab({ chart_id: 'CCCC3333' });
    assert.equal(r.status, 'MISSING');
    assert.equal(r.success, false);
    assert.deepEqual(browser.activated, ['T_REVIEW']);
    await assert.rejects(conn.getClient(), /MISSING/, 'must not keep reading the previously verified tab');
    assert.equal((await tab.selectTab({ chart_id: 'BBBB2222' })).status, 'VERIFIED');
    assert.equal(await attachedTo(), 'T_REVIEW');
  });

  it('AMBIGUOUS: two tabs hold the same layout; nothing activated; access blocked', async () => {
    page('T_REVIEW_2', 'BBBB2222', 'XYZ 1.00 Review Layout');
    const r = await tab.selectTab({ chart_id: 'BBBB2222' });
    assert.equal(r.status, 'AMBIGUOUS');
    assert.deepEqual(r.tab_ids.sort(), ['T_REVIEW', 'T_REVIEW_2']);
    assert.deepEqual(browser.activated, []);
    await assert.rejects(conn.getClient(), /AMBIGUOUS/);
  });

  it('MISMATCH: /json/list says the layout, but the live page holds another; access blocked', async () => {
    browser.live.T_REVIEW.url = 'https://www.tradingview.com/chart/AAAA1111/';
    const r = await tab.selectTab({ chart_id: 'BBBB2222' });
    assert.equal(r.status, 'MISMATCH');
    assert.equal(r.success, false);
    assert.equal(r.checks.live_url_chart_id, false);
    await assert.rejects(pane.list(), /MISMATCH/);
  });

  it('MISMATCH: live title does not contain the expected text', async () => {
    const r = await tab.selectTab({ chart_id: 'BBBB2222', title_contains: 'Discovery Layout' });
    assert.equal(r.status, 'MISMATCH');
    assert.equal(r.checks.title_contains, false);
  });

  it('activation failure is an error, never a silent success, and blocks access', async () => {
    browser.activateStatus = 500;
    await assert.rejects(tab.selectTab({ chart_id: 'BBBB2222' }), /Failed to activate tab T_REVIEW: HTTP 500/);
    await assert.rejects(conn.getClient(), /SELECT_ERROR/);
  });

  it('rejects a missing or malformed chart id before touching any tab', async () => {
    await assert.rejects(tab.selectTab({}), /chart_id required/);
    await assert.rejects(tab.selectTab({ chart_id: '../x' }), /chart_id required/);
    assert.deepEqual(browser.activated, []);
  });
});

describe('TV_REQUIRE_VERIFIED_TAB=1 (automation mode)', () => {
  it('refuses every chart access until tab_select verifies in this process', async () => {
    process.env.TV_REQUIRE_VERIFIED_TAB = '1';
    await assert.rejects(pane.list(), /No verified TradingView tab in this process/);
    await assert.rejects(healthCheck(), /No verified TradingView tab/);
    assert.equal(browser.connects.length, 0, 'no page was even connected');
    await tab.selectTab({ chart_id: 'BBBB2222' });
    const panes = await pane.list();
    assert.deepEqual(panes.panes.map(p => p.resolution), ['240', '60']);
  });

  it('refuses tv_launch (never kills/relaunches the shared app in automation mode)', async () => {
    process.env.TV_REQUIRE_VERIFIED_TAB = '1';
    const { launch } = await import('../src/core/health.js');
    await assert.rejects(launch({}), /tv_launch is disabled when TV_REQUIRE_VERIFIED_TAB=1/);
  });

  it('tab_switch pins but does not verify: access stays refused', async () => {
    process.env.TV_REQUIRE_VERIFIED_TAB = '1';
    await tab.switchTab({ index: 1 });
    await assert.rejects(pane.list(), /No verified TradingView tab/);
  });
});

describe('preflight (single process)', () => {
  it('READY: verified identity, panes 240/60 in order, identity unchanged after the read', async () => {
    const r = await tab.preflight({ chart_id: 'BBBB2222', title_contains: 'Review', layout_id: '222', resolutions: '240,60' });
    assert.equal(r.status, 'READY');
    assert.equal(r.ready, true);
    assert.deepEqual(r.pane_resolutions, ['240', '60']);
    assert.equal(r.tab_id, 'T_REVIEW');
  });

  it('PANES_MISMATCH: verified tab with panes 60/60 (pane 0 not restored)', async () => {
    browser.live.T_REVIEW.resolutions = ['60', '60'];
    const r = await tab.preflight({ chart_id: 'BBBB2222', resolutions: '240,60' });
    assert.equal(r.status, 'PANES_MISMATCH');
    assert.equal(r.success, false);
    assert.deepEqual(r.pane_resolutions, ['60', '60']);
  });

  it('PANES_MISMATCH on order and count', async () => {
    browser.live.T_REVIEW.resolutions = ['60', '240'];
    assert.equal((await tab.preflight({ chart_id: 'BBBB2222', resolutions: '240,60' })).status, 'PANES_MISMATCH');
    browser.live.T_REVIEW.resolutions = ['240'];
    assert.equal((await tab.preflight({ chart_id: 'BBBB2222', resolutions: '240,60' })).status, 'PANES_MISMATCH');
  });

  it('propagates MISSING / MISMATCH without reading panes', async () => {
    assert.equal((await tab.preflight({ chart_id: 'CCCC3333', resolutions: '240,60' })).status, 'MISSING');
    const r = await tab.preflight({ chart_id: 'BBBB2222', layout_id: '111', resolutions: '240,60' });
    assert.equal(r.status, 'MISMATCH');
    assert.equal(r.ready, false);
  });

  it('requires resolutions', async () => {
    await assert.rejects(tab.preflight({ chart_id: 'BBBB2222' }), /resolutions required/);
  });
});

describe('tab_switch, tab_list and health check', () => {
  it('tab_switch pins and reconnects to the chosen tab (unverified)', async () => {
    await conn.getClient();
    const r = await tab.switchTab({ index: 1 });
    assert.equal(r.tab_id, 'T_REVIEW');
    assert.equal(r.verified, false);
    assert.equal(await attachedTo(), 'T_REVIEW');
  });

  it('tab_switch rejects an out-of-range index', async () => {
    await assert.rejects(tab.switchTab({ index: 5 }), /out of range/);
    await assert.rejects(tab.switchTab({ index: -1 }), /out of range/);
  });

  it('tab_list marks the pinned tab', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    const { tabs } = await tab.list();
    assert.deepEqual(tabs.map(t => [t.chart_id, t.pinned]), [['AAAA1111', false], ['BBBB2222', true]]);
  });

  it('health check reports the LIVE title and the access state', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    browser.live.T_REVIEW.title = 'XYZ 2.00 Review Layout';
    const h = await healthCheck();
    assert.equal(h.target_title, 'XYZ 2.00 Review Layout');
    assert.equal(h.pinned_target_id, 'T_REVIEW');
    assert.deepEqual(h.tab_access.pinned, { id: 'T_REVIEW', chartId: 'BBBB2222', verified: true });
    assert.equal(h.tab_access.blocked, null);
  });

  it('chartIdFromUrl', () => {
    assert.equal(tab.chartIdFromUrl('https://www.tradingview.com/chart/BBBB2222/?symbol=X'), 'BBBB2222');
    assert.equal(tab.chartIdFromUrl('https://www.tradingview.com/'), null);
  });
});
