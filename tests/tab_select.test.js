/**
 * Deterministic, offline tests for tab selection with a pinned CDP connection.
 *
 * Reproduces the demonstrated defect: with two TradingView chart tabs open,
 * tab_switch only brought a tab to the front while the CDP client stayed attached
 * to the FIRST chart page in /json/list, so every later read came from the other
 * tab. Also covers reconnects (which re-picked the first page) and identity
 * checks that trusted cached /json/list metadata instead of the live page.
 *
 * Both the DevTools HTTP endpoints (fetch) and chrome-remote-interface are faked;
 * the REAL src/connection.js, src/core/tab.js and src/core/health.js run.
 *
 * Run: node --experimental-test-module-mocks --test tests/tab_select.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── fake browser ────────────────────────────────────────────────────────────
// targets: what /json/list reports. live: what each page's window reports NOW
// (may differ from /json/list, e.g. a layout loaded in place).
const browser = { targets: [], live: {}, activated: [], connects: [], failNextLiveness: false, activateStatus: 0 };

function page(id, chartId, title) {
  browser.targets.push({ id, type: 'page', url: `https://www.tradingview.com/chart/${chartId}/`, title });
  browser.live[id] = { url: `https://www.tradingview.com/chart/${chartId}/`, title, symbol: `SYM_${id}` };
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

function fakeClient(targetId) {
  return {
    targetId,
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => {
        if (expression === '1') {
          if (browser.failNextLiveness) { browser.failNextLiveness = false; throw new Error('socket closed'); }
          return { result: { value: 1 } };
        }
        const live = browser.live[targetId];
        if (expression.includes('window.location.href') && expression.includes('document.title')
          && !expression.includes('TradingViewApi')) {
          return { result: { value: { url: live.url, title: live.title } } };
        }
        if (expression.includes('_activeChartWidgetWV')) {
          return { result: { value: { url: live.url, title: live.title, symbol: live.symbol, resolution: '60', chartType: 1, apiAvailable: true } } };
        }
        return { result: { value: null } };
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
const { healthCheck } = await import('../src/core/health.js');

const attachedTo = async () => (await conn.getClient()).targetId;

beforeEach(async () => {
  await conn.disconnect();
  conn.unpinTarget();
  Object.assign(browser, { targets: [], live: {}, activated: [], connects: [], failNextLiveness: false, activateStatus: 0 });
  page('T_DISCOVERY', 'AAAA1111', 'XYZ 1.00 Discovery Layout');
  page('T_REVIEW', 'BBBB2222', 'XYZ 1.00 Review Layout');
});

describe('tab_select: deterministic selection with a pinned connection', () => {
  it('reproduces the defect baseline: without a pin the client attaches to the FIRST chart tab', async () => {
    assert.equal(await attachedTo(), 'T_DISCOVERY');
  });

  it('selects the tab by chart id, pins the connection and verifies the LIVE identity', async () => {
    await conn.getClient(); // attached to the first tab, as in the defect
    const r = await tab.selectTab({ chart_id: 'BBBB2222', title_contains: 'Review Layout' });
    assert.equal(r.status, 'VERIFIED');
    assert.equal(r.success, true);
    assert.equal(r.tab_id, 'T_REVIEW');
    assert.equal(r.live_chart_id, 'BBBB2222');
    assert.deepEqual(browser.activated, ['T_REVIEW']);
    assert.equal(await attachedTo(), 'T_REVIEW', 'reads must now come from the selected tab');
    assert.deepEqual(conn.getPinnedTarget(), { id: 'T_REVIEW', chartId: 'BBBB2222' });
  });

  it('a reconnect after a dropped connection stays on the pinned tab', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    browser.failNextLiveness = true;
    assert.equal(await attachedTo(), 'T_REVIEW');
    assert.equal(browser.connects.at(-1), 'T_REVIEW');
  });

  it('pinned tab closed: fails fast, never falls back to another tab', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    await conn.disconnect();
    browser.targets = browser.targets.filter(t => t.id !== 'T_REVIEW');
    const before = browser.connects.length;
    await assert.rejects(conn.getClient(), /Pinned TradingView tab T_REVIEW is no longer open/);
    assert.equal(browser.connects.length, before, 'no connection to any other tab');
  });

  it('MISSING: no tab with that chart id; nothing is activated or re-pinned', async () => {
    const r = await tab.selectTab({ chart_id: 'CCCC3333' });
    assert.equal(r.status, 'MISSING');
    assert.equal(r.success, false);
    assert.deepEqual(browser.activated, []);
    assert.equal(conn.getPinnedTarget(), null);
  });

  it('AMBIGUOUS: two tabs hold the same layout; nothing is activated', async () => {
    page('T_REVIEW_2', 'BBBB2222', 'XYZ 1.00 Review Layout');
    const r = await tab.selectTab({ chart_id: 'BBBB2222' });
    assert.equal(r.status, 'AMBIGUOUS');
    assert.equal(r.success, false);
    assert.deepEqual(r.tab_ids.sort(), ['T_REVIEW', 'T_REVIEW_2']);
    assert.deepEqual(browser.activated, []);
  });

  it('MISMATCH: /json/list says the layout, but the live page holds another (loaded in place)', async () => {
    browser.live.T_REVIEW.url = 'https://www.tradingview.com/chart/AAAA1111/';
    const r = await tab.selectTab({ chart_id: 'BBBB2222' });
    assert.equal(r.status, 'MISMATCH');
    assert.equal(r.success, false);
    assert.equal(r.checks.live_url_chart_id, false);
  });

  it('MISMATCH: live title does not contain the expected text', async () => {
    const r = await tab.selectTab({ chart_id: 'BBBB2222', title_contains: 'Discovery Layout' });
    assert.equal(r.status, 'MISMATCH');
    assert.equal(r.checks.title_contains, false);
  });

  it('activation failure is an error, never a silent success', async () => {
    browser.activateStatus = 500;
    await assert.rejects(tab.selectTab({ chart_id: 'BBBB2222' }), /Failed to activate tab T_REVIEW: HTTP 500/);
    assert.equal(conn.getPinnedTarget(), null, 'not pinned when activation failed');
  });

  it('rejects a missing or malformed chart id before touching any tab', async () => {
    await assert.rejects(tab.selectTab({}), /chart_id required/);
    await assert.rejects(tab.selectTab({ chart_id: '../x' }), /chart_id required/);
    assert.deepEqual(browser.activated, []);
  });
});

describe('tab_switch, tab_list and health check', () => {
  it('tab_switch now pins and reconnects to the chosen tab', async () => {
    await conn.getClient();
    const r = await tab.switchTab({ index: 1 });
    assert.equal(r.tab_id, 'T_REVIEW');
    assert.equal(r.live_chart_id, 'BBBB2222');
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

  it('health check reports the LIVE url/title, not the cached /json/list values', async () => {
    await tab.selectTab({ chart_id: 'BBBB2222' });
    browser.live.T_REVIEW = { ...browser.live.T_REVIEW, url: 'https://www.tradingview.com/chart/AAAA1111/', title: 'XYZ Discovery Layout' };
    const h = await healthCheck();
    assert.equal(h.target_url, 'https://www.tradingview.com/chart/AAAA1111/');
    assert.equal(h.target_title, 'XYZ Discovery Layout');
    assert.equal(h.pinned_target_id, 'T_REVIEW');
  });

  it('chartIdFromUrl', () => {
    assert.equal(tab.chartIdFromUrl('https://www.tradingview.com/chart/BBBB2222/?symbol=X'), 'BBBB2222');
    assert.equal(tab.chartIdFromUrl('https://www.tradingview.com/'), null);
  });
});
