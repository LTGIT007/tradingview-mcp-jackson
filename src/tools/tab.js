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

  server.tool('tab_select', 'Select the one open tab holding a saved layout, by its chart short id (/chart/<id>/ from tab_list). Pins the connection to that tab and verifies the LIVE url (and optional title text). success=true only when status is VERIFIED; MISSING/AMBIGUOUS/MISMATCH mean do not use the chart.', {
    chart_id: z.string().describe('Saved layout short id from the tab URL /chart/<id>/ (see tab_list)'),
    title_contains: z.string().optional().describe('Optional text the live page title must contain, e.g. the saved layout name'),
  }, async ({ chart_id, title_contains }) => {
    try {
      const r = await core.selectTab({ chart_id, title_contains });
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
