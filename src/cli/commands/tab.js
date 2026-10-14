import { register } from '../router.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch, select)',
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
      description: 'Select the tab holding a saved layout by chart short id and verify it (exit 3 unless VERIFIED)',
      options: {
        'chart-id': { type: 'string', description: 'Saved layout short id from the tab URL /chart/<id>/' },
        title: { type: 'string', description: 'Text the live page title must contain' },
      },
      handler: async (opts) => {
        const chartId = opts['chart-id'];
        if (!chartId) throw new Error('Usage: tv tab select --chart-id <id> [--title <text>]');
        const r = await core.selectTab({ chart_id: chartId, title_contains: opts.title });
        if (!r.success) process.exitCode = 3; // not VERIFIED: callers must not use the chart
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
