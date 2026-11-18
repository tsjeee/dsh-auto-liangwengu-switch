/**
 * 节假日数据加载：本地数据文件 → 公开数据集自动补缺。
 *
 * 本地唯一数据源是 `holiday-data.json`（人工维护，格式：years → 放假日期区间）。
 * 当前年份未被本地数据覆盖时，Host 会从公开数据集
 * （NateScarlet/holiday-cn，逐日列出国务院放假安排，含 paper 出处）拉取当年的
 * `isOffDay: true` 日期作为补充；网络不可用或数据不合法时保持本地数据不变。
 *
 * 调休上班的周末不需要出现在数据里：插件把周末恒视为谷时。
 */
import { readFileSync } from 'node:fs'

/** Local, human-editable holiday data file. */
export const HOLIDAY_DATA_FILE = new URL('./holiday-data.json', import.meta.url)

/** Public per-year holiday dataset used to fill years the local file does not cover. */
export const HOLIDAY_REMOTE_BASE = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u
const MAX_YEARS = 20
const MAX_RANGES_PER_YEAR = 40
const MAX_REMOTE_DAYS = 400

/**
 * Whether one string is a real `YYYY-MM-DD` calendar date.
 * @param {unknown} value candidate.
 * @returns {boolean}
 */
function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const epoch = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value
}

/**
 * @param {unknown} value decoded holiday-data JSON.
 * @returns {{dates: Set<string>, coverageYears: Set<number>} | undefined} validated data.
 */
export function parseHolidayData(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const years = value.years
  if (years === null || typeof years !== 'object' || Array.isArray(years)) return undefined
  const keys = Object.keys(years)
  if (keys.length === 0 || keys.length > MAX_YEARS) return undefined
  const dates = new Set()
  const coverageYears = new Set()
  for (const key of keys) {
    if (!/^\d{4}$/u.test(key)) return undefined
    const year = Number(key)
    const ranges = years[key]
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_RANGES_PER_YEAR) return undefined
    coverageYears.add(year)
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2) return undefined
      const [start, end] = range
      if (typeof start !== 'string' || typeof end !== 'string') return undefined
      if (!isRealDate(start) || !isRealDate(end)) return undefined
      if (start.slice(0, 4) !== key || end.slice(0, 4) !== key) return undefined
      if (start > end) return undefined
      const first = Date.parse(`${start}T00:00:00Z`)
      for (let day = first; day <= Date.parse(`${end}T00:00:00Z`); day += 86400000) {
        dates.add(new Date(day).toISOString().slice(0, 10))
      }
    }
  }
  return { dates, coverageYears }
}

/**
 * Read and validate {@link HOLIDAY_DATA_FILE}.
 * @returns {{dates: Set<string>, coverageYears: Set<number>} | undefined} loaded data, or undefined.
 */
export function loadHolidayFile() {
  try {
    return parseHolidayData(JSON.parse(readFileSync(HOLIDAY_DATA_FILE, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * Fetch one year from the public dataset and reduce it to off-day dates.
 * @param {number} year four-digit calendar year.
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] test seams.
 * @returns {Promise<Set<string> | undefined>} holiday dates, or undefined on failure/invalid data.
 */
export async function fetchHolidayYear(year, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6000
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(`${HOLIDAY_REMOTE_BASE}${year}.json`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (response === undefined || response === null || !response.ok) return undefined
    const raw = await response.json()
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    if (Number(raw.year) !== year || !Array.isArray(raw.days) || raw.days.length > MAX_REMOTE_DAYS) return undefined
    const dates = new Set()
    for (const day of raw.days) {
      if (day === null || typeof day !== 'object') continue
      if (day.isOffDay !== true || !isRealDate(day.date)) continue
      if (day.date.slice(0, 4) !== String(year)) continue
      dates.add(day.date)
    }
    // A real annual arrangement always has several off days; anything smaller is
    // treated as a truncated or bogus response.
    return dates.size >= 3 ? dates : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Merge validated holiday sources; later sources add both dates and coverage.
 * @param {readonly ({dates: Set<string>, coverageYears: Set<number>} | undefined)[]} sources
 * @returns {{dates: Set<string>, coverageYears: Set<number>}}
 */
export function mergeHolidayData(sources) {
  const dates = new Set()
  const coverageYears = new Set()
  for (const source of sources) {
    if (source === undefined || source === null) continue
    for (const date of source.dates) dates.add(date)
    for (const year of source.coverageYears) coverageYears.add(year)
  }
  return { dates, coverageYears }
}
