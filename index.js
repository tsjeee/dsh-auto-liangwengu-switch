/**
 * 峰谷执行 (peak-valley execution) — Host half.
 *
 * Registers:
 * - the `agent/pre-step` waterfall listener that turns a marked prompt into one
 *   Host scheduled task for the current Session, due at the next valley
 *   opening (see `interception.js`);
 * - the holiday-calendar synchronizer that starts from `holiday-data.json` and
 *   fills an uncovered current year from the public holiday-cn dataset
 *   (see `holiday-sync.js`);
 * - the read-only calendar route that hands that authoritative calendar to the
 *   browser, so a data-only update changes the Client behavior without touching
 *   client code (see `calendar-payload.js`).
 */
import { interceptAt } from './interception.js'
import { createHolidaySync } from './holiday-sync.js'
import { CALENDAR_ROUTE_PATH } from './calendar-payload.js'

/**
 * Register the pre-step interceptor, the calendar synchronizer, and its route.
 * @param {object} ctx Host plugin context.
 */
export function apply(ctx) {
  const calendar = createHolidaySync(ctx)
  ctx.effect(() => calendar.start(), 'peak-valley-execution: holiday sync')
  ctx.effect(
    () => ctx.on('agent/pre-step', (payload, next) => interceptAt(ctx, payload, next)),
    'peak-valley-execution: pre-step',
  )
  // Optional: compositions without the Web server keep scheduling locally and
  // the browser falls back to its embedded holiday table.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CALENDAR_ROUTE_PATH,
      resource: () => new Response(JSON.stringify(calendar.payload()), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      }),
    }), 'peak-valley-execution: calendar route')
  })
}
