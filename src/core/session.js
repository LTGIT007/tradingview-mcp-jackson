/**
 * Core: TradingView session health.
 *
 * When the account is opened elsewhere, TradingView Desktop shows a modal
 * "Session disconnected … only one active session is allowed per user" and STOPS
 * loading data. The chart still accepts symbol switches — the LABEL changes — but
 * the resident bar buffer stays frozen on whatever was loaded before. Any read in
 * that state can return another instrument's bars under the requested label (the
 * 2026-10-09 RMS←COH incident). Callers that capture evidence must fail closed.
 */
import { evaluate } from '../connection.js';

export const SESSION_DISCONNECTED = 'TV_SESSION_DISCONNECTED';

export async function sessionState() {
  const state = await evaluate(`
    (function() {
      var t = (document.body && document.body.innerText) || '';
      return (/session disconnected/i.test(t) && /active session/i.test(t)) ? 'DISCONNECTED' : 'OK';
    })()
  `);
  return state === 'DISCONNECTED' ? 'DISCONNECTED' : 'OK';
}

export async function assertSessionConnected() {
  if ((await sessionState()) === 'DISCONNECTED') {
    throw new Error(
      `${SESSION_DISCONNECTED}: TradingView shows "Session disconnected" (the account is active in another `
        + `browser/device), so chart data is frozen and symbol switches only relabel stale bars. Refusing to read `
        + `or write any OHLCV. Reconnect TradingView Desktop (click "Connect"), then retry.`
    );
  }
}
