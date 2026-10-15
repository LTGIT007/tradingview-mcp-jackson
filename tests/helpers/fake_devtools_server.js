/**
 * A minimal fake Chrome DevTools endpoint (HTTP + WebSocket) for cross-process tests.
 *
 * Child processes (the CLI, a freshly spawned MCP server) connect to it exactly as
 * they connect to TradingView Desktop: GET /json/list, /json/protocol,
 * /json/activate/<id>, then a WebSocket per page answering Runtime.* calls. Page
 * state is plain data the test mutates between invocations.
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const protocol = require('chrome-remote-interface/lib/protocol.json');
// `ws` is already installed as a dependency of chrome-remote-interface (v7: `Server`).
const { Server: WebSocketServer } = require('ws');

export async function startFakeDevtools() {
  const state = {
    pages: new Map(), // id -> { chartId, title, symbol, resolutions, liveUrl? }
    order: [],
    activated: [],
    connections: [], // target ids, one per WebSocket connection, in order
    savedCharts: [],
  };
  let port;

  const listTargets = () => state.order.filter(id => state.pages.has(id)).map((id) => {
    const p = state.pages.get(id);
    return {
      id, type: 'page', title: p.title,
      url: `https://www.tradingview.com/chart/${p.chartId}/`,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`,
    };
  });

  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url === '/json/list' || req.url === '/json') return send(200, listTargets());
    if (req.url === '/json/version') return send(200, { Browser: 'FakeDevtools/1.0' });
    if (req.url === '/json/protocol') return send(200, protocol);
    const m = req.url.match(/^\/json\/activate\/(.+)$/);
    if (m) {
      state.activated.push(m[1]);
      return state.pages.has(m[1]) ? send(200, 'Target activated', 'text/plain') : send(404, 'No such target', 'text/plain');
    }
    return send(404, 'not found', 'text/plain');
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const id = decodeURIComponent(req.url.replace('/devtools/page/', ''));
    state.connections.push(id);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const reply = (result) => ws.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method !== 'Runtime.evaluate') return reply({});
      const p = state.pages.get(id);
      if (!p) return ws.close();
      return reply({ result: { type: 'object', value: evaluate(p, msg.params.expression) } });
    });
  });

  function evaluate(p, expression) {
    const url = p.liveUrl || `https://www.tradingview.com/chart/${p.chartId}/`;
    if (expression === '1') return 1;
    if (expression === 'window.location.href') return url;
    if (expression.includes('getSavedCharts')) return state.savedCharts;
    if (expression.includes('inlineChartsCount')) {
      return { layout: p.resolutions.length === 2 ? '2h' : 's', chart_count: p.resolutions.length, active_index: 0,
        panes: p.resolutions.map((r, i) => ({ index: i, symbol: p.symbol, resolution: r })) };
    }
    if (expression.includes('window.location.href') && expression.includes('document.title')) {
      return { url, title: p.title, symbol: p.symbol, resolution: p.resolutions[0], chartType: 1, apiAvailable: true };
    }
    return null;
  }

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  return {
    port,
    state,
    addPage(id, chartId, title, { symbol = `SYM_${id}`, resolutions = ['240', '60'] } = {}) {
      state.pages.set(id, { chartId, title, symbol, resolutions });
      state.order.push(id);
    },
    removePage(id) { state.pages.delete(id); },
    page(id) { return state.pages.get(id); },
    /** Drop every open WebSocket (forces clients to reconnect). */
    dropConnections() { for (const ws of wss.clients) ws.terminate(); },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise(r => wss.close(r));
      await new Promise(r => server.close(r));
    },
  };
}
