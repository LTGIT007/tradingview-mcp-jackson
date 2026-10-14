import { register } from '../router.js';
import * as core from '../../core/tab.js';

const IDENTITY_OPTIONS = {
  'chart-id': { type: 'string', description: 'Saved layout short id from the tab URL /chart/<id>/' },
  title: { type: 'string', description: 'Text the live page title must contain' },
  'layout-id': { type: 'string', description: 'Numeric saved layout id; its registry short id must equal --chart-id' },
};

register('tab', {
  description: 'Tab management (list, new, close, switch, select, preflight)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new chart tab',
      handler: () => core.newTab(),
    }],
    ['close', {
      description: 'Close the current tab',
      handler: () => core.closeTab(),
    }],
    ['select', {
      description: 'Select + verify the tab holding a saved layout (exit 3 unless VERIFIED). The pin lasts '
        + 'for THIS process only; a later tv command starts unpinned — use "tab preflight" for checks.',
      options: IDENTITY_OPTIONS,
      handler: async (opts) => {
        const chartId = opts['chart-id'];
        if (!chartId) throw new Error('Usage: tv tab select --chart-id <id> [--title <text>] [--layout-id <n>]');
        const r = await core.selectTab({ chart_id: chartId, title_contains: opts.title, layout_id: opts['layout-id'] });
        if (!r.success) process.exitCode = 3; // not VERIFIED: callers must not use the chart
        return r;
      },
    }],
    ['preflight', {
      description: 'In ONE process: select + verify the tab, check pane resolutions in order, re-check '
        + 'identity (exit 0 only when status is READY, else 3)',
      options: {
        ...IDENTITY_OPTIONS,
        resolutions: { type: 'string', description: 'Pane resolutions in pane order, e.g. 240,60' },
      },
      handler: async (opts) => {
        const chartId = opts['chart-id'];
        if (!chartId || !opts.resolutions) {
          throw new Error('Usage: tv tab preflight --chart-id <id> --resolutions 240,60 [--title <text>] [--layout-id <n>]');
        }
        const r = await core.preflight({ chart_id: chartId, title_contains: opts.title,
          layout_id: opts['layout-id'], resolutions: opts.resolutions });
        if (!r.success) process.exitCode = 3; // not READY: do not read chart evidence
        return r;
      },
    }],
    ['switch', {
      description: 'Switch to a tab by index',
      handler: (opts, positionals) => {
        if (positionals[0] === undefined) throw new Error('Index required. Usage: tv tab switch 0');
        return core.switchTab({ index: positionals[0] });
      },
    }],
  ]),
});
