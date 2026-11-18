/**
 * 峰谷执行 —— holiday calendar synchronization for the Host half.
 *
 * Starts from the shipped/edited `holiday-data.json`, then fills any missing
 * current year from the public holiday-cn dataset and keeps retrying while the
 * year stays uncovered (e.g. the first day of a year whose arrangement the
 * local file does not list yet). The merged calendar feeds both the scheduler
 * and the browser payload at {@link CALENDAR_ROUTE_PATH}.
 */
import { loadHolidayFile, fetchHolidayYear, mergeHolidayData } from './holidays.js'
import { applyHolidayData, getHolidayState, zonedParts } from './time.js'
import { buildCalendarPayload } from './calendar-payload.js'

/** How often an uncovered current year is retried. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

/**
 * Create the calendar synchronizer for one plugin activation.
 * @param {object} ctx Host plugin context (uses `logger` only).
 * @returns {{start: () => () => void, payload: () => object, ensureCoverage: () => Promise<void>}}
 */
export function createHolidaySync(ctx) {
  const fileData = loadHolidayFile()
  const remoteYears = new Map()
  const warnedYears = new Set()
  let disposed = false
  let timer

  function rebuild() {
    const sources = []
    if (fileData !== undefined) sources.push(fileData)
    for (const [year, dates] of remoteYears) {
      sources.push({ dates, coverageYears: new Set([year]) })
    }
    applyHolidayData(mergeHolidayData(sources))
  }

  async function ensureCoverage() {
    if (disposed) return
    const year = zonedParts(Date.now()).year
    if (getHolidayState().coverageYears.has(year)) return
    const dates = await fetchHolidayYear(year)
    if (disposed) return
    if (dates === undefined) {
      // Warn once per uncovered year; the hourly retry stays quiet afterwards.
      if (!warnedYears.has(year)) {
        warnedYears.add(year)
        log(ctx, 'warn', `节假日数据未覆盖 ${year} 年，且自动获取失败；节假日可能被按高峰处理（可更新 holiday-data.json）`)
      }
      return
    }
    remoteYears.set(year, dates)
    warnedYears.delete(year)
    rebuild()
    log(ctx, 'info', `已从公开数据集补充 ${year} 年节假日 ${dates.size} 天`)
  }

  return {
    /**
     * Load the local table, attempt the current year, and schedule retries.
     * @returns {() => void} disposer stopping the retry timer.
     */
    start() {
      rebuild()
      void ensureCoverage()
      timer = setInterval(() => { void ensureCoverage() }, REFRESH_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => {
        disposed = true
        clearInterval(timer)
      }
    },
    /** @returns {object} the client-facing calendar payload. */
    payload() {
      return buildCalendarPayload(getHolidayState())
    },
    ensureCoverage,
  }
}

/**
 * Log through the Host logger when the deployment supplies one.
 * @param {object} ctx Host context.
 * @param {'info' | 'warn'} level log level.
 * @param {string} message log body.
 */
function log(ctx, level, message) {
  try {
    ctx.logger?.[level]?.(`peak-valley-execution: ${message}`)
  } catch {
    /* Logging must never break synchronization. */
  }
}
