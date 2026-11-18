/**
 * The client-facing peak/valley calendar payload served on
 * `GET /peak-valley/calendar`, plus its client-side parser contract.
 *
 * Only public, non-sensitive data crosses this route: DeepSeek's peak windows
 * and the statutory-holiday dates. The browser keeps an offline fallback and
 * adopts this payload when it arrives.
 */
import { PEAK_WINDOWS } from './time.js'

/** Exact route that serves {@link buildCalendarPayload}. */
export const CALENDAR_ROUTE_PATH = '/peak-valley/calendar'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u
const MAX_DAYS = 800
const MAX_YEARS = 30

/**
 * Build the client payload.
 * @param {{dates: Set<string>, coverageYears: Set<number>}} data holiday calendar.
 * @returns {{version: number, peakWindows: number[][], holidays: string[], coverageYears: number[], generatedAt: string}}
 */
export function buildCalendarPayload(data) {
  const holidays = [...data.dates].filter(date => DATE_RE.test(date)).sort()
  const coverageYears = [...data.coverageYears]
    .filter(year => Number.isInteger(year) && year >= 2000 && year <= 2100)
    .sort((a, b) => a - b)
  return {
    version: 1,
    peakWindows: PEAK_WINDOWS.map(window => [window.start, window.end]),
    holidays: holidays.slice(0, MAX_DAYS),
    coverageYears: coverageYears.slice(0, MAX_YEARS),
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Validate one client payload (used by the Client half; duplicated there
 * because the browser bundle cannot import Host modules).
 * @param {unknown} value decoded JSON.
 * @returns {{dates: Set<string>, coverageYears: Set<number>} | undefined} accepted calendar.
 */
export function parseCalendarPayload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const holidays = value.holidays
  if (!Array.isArray(holidays) || holidays.length > MAX_DAYS) return undefined
  const dates = new Set()
  for (const date of holidays) {
    if (typeof date === 'string' && DATE_RE.test(date)) dates.add(date)
  }
  const coverageYears = new Set()
  if (Array.isArray(value.coverageYears)) {
    for (const year of value.coverageYears) {
      const numeric = Number(year)
      if (Number.isInteger(numeric) && numeric >= 2000 && numeric <= 2100) coverageYears.add(numeric)
    }
  }
  return { dates, coverageYears }
}
