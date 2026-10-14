/**
 * Cross-process regression tests for tab pinning (offline).
 *
 * The pin made by tab_select lives in ONE Node process. These tests run the REAL
 * CLI and the REAL MCP server as separate child processes against a fake DevTools
 * endpoint (tests/helpers/fake_devtools_server.js) and prove:
 *
 *   - a pin does NOT survive into the next CLI invocation (reproduction);
 *   - `tv tab preflight` selects, verifies and checks panes within one process;
 *   - a freshly started MCP server with TV_REQUIRE_VERIFIED_TAB=1 refuses chart
 *     reads until it selects and verifies the tab itself;
 *   - mismatched live identities, dropped connections and a closed tab never let
 *     reads continue against an unverified target.
 *
 * Run: node --test tests/tab_cross_process.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeDevtools } from './helpers/fake_devtools_server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli', 'index.js');
const SERVER = join(ROOT, 'src', 'server.js');

let fake;
const env = (extra = {}) => ({
  ...process.env, TV_CDP_HOST: '127.0.0.1', TV_CDP_PORT: String(fake.port), TV_REQUIRE_VERIFIED_TAB: '', ...extra,
});

/** Run one CLI invocation as its own process (async, so the in-process fake can answer). */
function cli(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(extraEnv) });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out); } catch {}
      resolve({ code, json, out, err });
    });
  });
}

/** A fresh MCP server process speaking newline-delimited JSON-RPC over stdio. */
async function startMcp(extraEnv) {
  const child = spawn(process.execPath, [SERVER], { env: env(extraEnv) });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 20000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    async call(name, args = {}) {
      const msg = await request('tools/call', { name, arguments: args });
      const text = msg.result?.content?.[0]?.text;
      return { isError: !!msg.result?.isError, body: text ? JSON.parse(text) : msg };
    },
    async stop() {
      child.stdin.end();
      child.kill();
      await new Promise(r => child.once('exit', r));
    },
  };
}

before(async () => { fake = await startFakeDevtools(); });
after(async () => { await fake.close(); });

beforeEach(() => {
  for (const id of [...fake.state.pages.keys()]) fake.removePage(id);
  fake.state.order.length = 0;
  fake.state.activated.length = 0;
  fake.state.connections.length = 0;
  fake.state.savedCharts = [{ id: 111, url: 'AAAA1111', name: 'Discovery Layout' }, { id: 222, url: 'BBBB2222', name: 'Review Layout' }];
  fake.addPage('T_DISCOVERY', 'AAAA1111', 'XYZ 1.00 Discovery Layout', { symbol: 'X:DISC', resolutions: ['1D', '1D'] });
  fake.addPage('T_REVIEW', 'BBBB2222', 'XYZ 1.00 Review Layout', { symbol: 'X:REV', resolutions: ['240', '60'] });
});

describe('separate CLI invocations', () => {
  it('REPRODUCTION: a pin from `tv tab select` is lost by the next `tv` process', async () => {
    const sel = await cli(['tab', 'select', '--chart-id', 'BBBB2222']);
    assert.equal(sel.code, 0, sel.err);
    assert.equal(sel.json.status, 'VERIFIED');
    const panes = await cli(['pane', 'list']);
    assert.equal(panes.code, 0, panes.err);
    assert.deepEqual(panes.json.panes.map(p => p.symbol), ['X:DISC', 'X:DISC'],
      'the new process attached to the FIRST tab, not the one selected before');
    assert.equal(fake.state.connections.at(-1), 'T_DISCOVERY');
  });

  it('with TV_REQUIRE_VERIFIED_TAB=1 the unpinned process refuses to read instead', async () => {
    await cli(['tab', 'select', '--chart-id', 'BBBB2222']);
    const panes = await cli(['pane', 'list'], { TV_REQUIRE_VERIFIED_TAB: '1' });
    assert.notEqual(panes.code, 0);
    assert.match(panes.out + panes.err, /No verified TradingView tab in this process/);
  });

  it('`tv tab preflight` selects, verifies and checks panes in ONE process: READY, exit 0', async () => {
    const r = await cli(['tab', 'preflight', '--chart-id', 'BBBB2222', '--layout-id', '222',
      '--title', 'Review Layout', '--resolutions', '240,60']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.json.status, 'READY');
    assert.deepEqual(r.json.panes.map(p => p.symbol), ['X:REV', 'X:REV']);
    assert.deepEqual(fake.state.connections, ['T_REVIEW'], 'only the selected tab was ever attached');
  });

  it('preflight PANES_MISMATCH (pane 0 left on 60): exit 3', async () => {
    fake.page('T_REVIEW').resolutions = ['60', '60'];
    const r = await cli(['tab', 'preflight', '--chart-id', 'BBBB2222', '--resolutions', '240,60']);
    assert.equal(r.code, 3);
    assert.equal(r.json.status, 'PANES_MISMATCH');
  });

  it('preflight MISMATCH (another layout loaded into the tab in place): exit 3, panes never read', async () => {
    fake.page('T_REVIEW').liveUrl = 'https://www.tradingview.com/chart/AAAA1111/';
    const r = await cli(['tab', 'preflight', '--chart-id', 'BBBB2222', '--resolutions', '240,60']);
    assert.equal(r.code, 3);
    assert.equal(r.json.status, 'MISMATCH');
    assert.equal(r.json.panes, undefined);
  });

  it('preflight MISMATCH when the saved layout id maps to a different short id', async () => {
    const r = await cli(['tab', 'preflight', '--chart-id', 'BBBB2222', '--layout-id', '111', '--resolutions', '240,60']);
    assert.equal(r.code, 3);
    assert.equal(r.json.status, 'MISMATCH');
    assert.equal(r.json.checks.layout_id, false);
  });

  it('preflight MISSING / AMBIGUOUS: exit 3, nothing activated', async () => {
    const missing = await cli(['tab', 'preflight', '--chart-id', 'CCCC3333', '--resolutions', '240,60']);
    assert.equal(missing.code, 3);
    assert.equal(missing.json.status, 'MISSING');
    fake.addPage('T_REVIEW_2', 'BBBB2222', 'XYZ 1.00 Review Layout');
    const amb = await cli(['tab', 'preflight', '--chart-id', 'BBBB2222', '--resolutions', '240,60']);
    assert.equal(amb.code, 3);
    assert.equal(amb.json.status, 'AMBIGUOUS');
    assert.deepEqual(fake.state.activated, []);
  });

  it('preflight with no DevTools endpoint: ERROR, exit 3', async () => {
    const r = await cli(['tab', 'preflight', '--chart-id', 'BBBB2222', '--resolutions', '240,60'], { TV_CDP_PORT: '1' });
    assert.equal(r.code, 3);
    assert.equal(r.json.status, 'ERROR');
  });
});

describe('fresh MCP server process (TV_REQUIRE_VERIFIED_TAB=1)', () => {
  it('must select + verify the tab itself; then survives reconnects; blocks on drift and closed tab', async () => {
    // Even after a CLI preflight succeeded, the separately launched server starts unverified.
    assert.equal((await cli(['tab', 'preflight', '--chart-id', 'BBBB2222', '--resolutions', '240,60'])).code, 0);
    const mcp = await startMcp({ TV_REQUIRE_VERIFIED_TAB: '1' });
    try {
      let r = await mcp.call('pane_list');
      assert.equal(r.isError, true);
      assert.match(r.body.error, /No verified TradingView tab in this process/);

      r = await mcp.call('tab_preflight', { chart_id: 'BBBB2222', layout_id: '222', resolutions: '240,60' });
      assert.equal(r.body.status, 'READY');
      r = await mcp.call('pane_list');
      assert.equal(r.isError, false);
      assert.deepEqual(r.body.panes.map(p => p.symbol), ['X:REV', 'X:REV']);

      // Reconnection: the socket drops; the server reconnects to the SAME tab and re-verifies.
      const before = fake.state.connections.length;
      fake.dropConnections();
      await new Promise(res => setTimeout(res, 50));
      r = await mcp.call('pane_list');
      assert.equal(r.isError, false, JSON.stringify(r.body));
      assert.equal(fake.state.connections.length, before + 1);
      assert.equal(fake.state.connections.at(-1), 'T_REVIEW');

      // Drift: another layout is loaded into the pinned tab; the next read is refused, and stays refused.
      fake.page('T_REVIEW').liveUrl = 'https://www.tradingview.com/chart/AAAA1111/';
      r = await mcp.call('pane_list');
      assert.equal(r.isError, true);
      assert.match(r.body.error, /IDENTITY_CHANGED/);
      r = await mcp.call('chart_get_state');
      assert.equal(r.isError, true);
      assert.match(JSON.stringify(r.body), /not verified/);
      r = await mcp.call('tab_select', { chart_id: 'BBBB2222' });
      assert.equal(r.body.status, 'MISMATCH');
      assert.equal((await mcp.call('pane_list')).isError, true);

      // Restored + re-selected: readable again.
      delete fake.page('T_REVIEW').liveUrl;
      assert.equal((await mcp.call('tab_select', { chart_id: 'BBBB2222' })).body.status, 'VERIFIED');
      assert.equal((await mcp.call('pane_list')).isError, false);

      // The pinned tab closes: no fallback to the remaining tab, ever.
      fake.removePage('T_REVIEW');
      fake.dropConnections();
      await new Promise(res => setTimeout(res, 50));
      const n = fake.state.connections.length;
      r = await mcp.call('pane_list');
      assert.equal(r.isError, true);
      assert.match(r.body.error, /no longer open|TAB_CLOSED/);
      assert.equal((await mcp.call('pane_list')).isError, true);
      assert.equal(fake.state.connections.length, n, 'never attached to the Discovery tab');
    } finally {
      await mcp.stop();
    }
  });

  it('a second fresh server process does not inherit the first one\'s verification', async () => {
    const a = await startMcp({ TV_REQUIRE_VERIFIED_TAB: '1' });
    try {
      assert.equal((await a.call('tab_select', { chart_id: 'BBBB2222' })).body.status, 'VERIFIED');
      assert.equal((await a.call('pane_list')).isError, false);
    } finally { await a.stop(); }
    const b = await startMcp({ TV_REQUIRE_VERIFIED_TAB: '1' });
    try {
      const r = await b.call('pane_list');
      assert.equal(r.isError, true);
      assert.match(r.body.error, /No verified TradingView tab/);
    } finally { await b.stop(); }
  });
});
