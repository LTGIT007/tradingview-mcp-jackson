import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/dump.js';

export function registerDumpTools(server) {
  server.tool(
    'data_dump_ohlcv',
    'Fetch OHLCV for MULTIPLE symbols server-side and write the raw bars directly to a JSON file under the MCP dumps/ directory. Returns ONLY compact metadata (never raw bars), so large multi-symbol payloads never enter model context. Acquisition is sequential (single active chart). Generic infrastructure — no date/indicator/strategy logic.',
    {
      symbols: z.array(z.string()).describe('Symbols to fetch, e.g. ["ASX:XJO","ASX:RHC"]'),
      timeframe: z.string().optional().describe('Resolution applied once (default "D")'),
      count: z.coerce.number().optional().describe('Bars per symbol (max 500, default 350)'),
      filename: z.string().describe('Output file NAME only (no path). Written under dumps/; ".json" appended if missing.'),
    },
    async ({ symbols, timeframe, count, filename }) => {
      try {
        return jsonResult(await core.dumpOhlcv({
          symbols,
          timeframe: timeframe || 'D',
          count: count || 350,
          filename,
        }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
