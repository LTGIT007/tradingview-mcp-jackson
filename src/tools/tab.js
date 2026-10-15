import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_new', 'Open a new chart tab', {}, async () => {
    try { return jsonResult(await core.newTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_close', 'Close the current chart tab', {}, async () => {
    try { return jsonResult(await core.closeTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  const identity = {
    chart_id: z.string().describe('Saved layout short id from the tab URL /chart/<id>/ (see tab_list)'),
    title_contains: z.string().optional().describe('Optional text the live page title must contain, e.g. the saved layout name'),
    layout_id: z.string().optional().describe('Optional numeric saved layout id (layout_list); its registry short id must equal chart_id'),
  };

  server.tool('tab_select', 'Select the one open tab holding a saved layout, by its chart short id (/chart/<id>/ from tab_list). Pins the connection to that tab (this server process only) and verifies the LIVE url, plus optional title text and saved layout id. success=true only when status is VERIFIED; MISSING/AMBIGUOUS/MISMATCH/ERROR block all chart access in this process until a later tab_select verifies.', identity, async ({ chart_id, title_contains, layout_id }) => {
    try {
      const r = await core.selectTab({ chart_id, title_contains, layout_id });
      return jsonResult(r, !r.success);
    }
    catch (err) { return jsonResult({ success: false, status: 'ERROR', error: err.message }, true); }
  });

  server.tool('tab_preflight', 'tab_select plus a pane check in one call: verifies the tab identity, then that its panes have exactly the given resolutions in order (e.g. "240,60"), then re-checks the live identity. status READY only when all pass; MISSING/AMBIGUOUS/MISMATCH/PANES_MISMATCH/ERROR mean do not read chart evidence.', {
    ...identity,
    resolutions: z.string().describe('Comma-separated pane resolutions in pane order, e.g. "240,60"'),
  }, async ({ chart_id, title_contains, layout_id, resolutions }) => {
    try {
      const r = await core.preflight({ chart_id, title_contains, layout_id, resolutions });
      return jsonResult(r, !r.success);
    }
    catch (err) { return jsonResult({ success: false, status: 'ERROR', error: err.message }, true); }
  });

  server.tool('tab_switch', 'Switch to a chart tab by index and pin the connection to it (does not verify which layout it holds; prefer tab_select)', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.switchTab({ index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
