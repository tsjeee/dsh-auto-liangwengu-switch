/**
 * 峰谷执行 —— DeepSeek 现行峰谷时段算术。
 *
 * 口径（北京时间，Asia/Shanghai）：
 * - 高峰：周一至周五 09:00–12:00、14:00–18:00，不含中国法定节假日。
 * - 谷时：其余全部时间，包括 12:00–14:00、夜间、周末与法定节假日全天；
 *   调休上班的周末仍按周末识别，因此周末恒为谷时。
 *
 * 节假日集合是可替换的模块状态：启动时由本地 `holiday-data.json` 装载，
 * 缺少当前年份时由 `holiday-sync.js` 从公开数据集补全后调用
 * {@link applyHolidayData} 覆盖。浏览器 bundle 无法 import 本模块，客户端保有一份
 * 离线回退表并通过 Host 路由获取权威数据（见 client.js）。
 */
import { loadHolidayFile } from './holidays.js'

/**
 * Invisible, zero-width execution marker carried inside a queued draft.
 *
 * Three U+2060 WORD JOINERs: `String#trim` keeps them (unlike U+FEFF), so the
 * composer's prompt serialization — which trims the first and last text token
 * — cannot strip the marker away from the sent message. The Client half keeps
 * an identical copy; change both.
 */
export const MARKER = '\u2060\u2060\u2060'

/** Zone that owns the peak/valley schedule. */
export const TIME_ZONE = 'Asia/Shanghai'

/** Weekday peak windows as minute-of-day, half-open `[start, end)`. */
export const PEAK_WINDOWS = [
  { start: 9 * 60, end: 12 * 60 },
  { start: 14 * 60, end: 18 * 60 },
]

/**
 * Read one instant as Beijing wall-clock parts.
 * @param {number} timeMs epoch milliseconds.
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number,dateKey:string}}
 */
export function zonedParts(timeMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(timeMs))
  const value = {}
  for (const part of parts) {
    if (part.type !== 'literal') value[part.type] = Number(part.value)
  }
  if (value.hour === 24) value.hour = 0
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day))
  const pad = (n) => String(n).padStart(2, '0')
  return {
    ...value,
    weekday: date.getUTCDay(),
    dateKey: `${value.year}-${pad(value.month)}-${pad(value.day)}`,
  }
}

/**
 * Resolve one Beijing wall-clock time to its UTC instant.
 * @param {{year:number,month:number,day:number,hour:number,minute:number}} wall local calendar time.
 * @returns {number} epoch milliseconds.
 */
export function zonedWallToUtc(wall) {
  const desired = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0)
  let guess = desired
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(guess)
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const delta = desired - actual
    if (delta === 0) break
    guess += delta
  }
  return guess
}

/** Active holiday dates; replaced by {@link applyHolidayData}. */
let holidayDates = new Set()

/** Years with known holiday data; replaced by {@link applyHolidayData}. */
let holidayCoverageYears = new Set()

// Load the shipped/local data file once at module init. `holiday-sync.js`
// replaces this state with the merged (file + remote) calendar at activation.
{
  const initial = loadHolidayFile()
  if (initial !== undefined) {
    holidayDates = initial.dates
    holidayCoverageYears = initial.coverageYears
  }
}

/**
 * Replace the active holiday calendar.
 * @param {{dates: Set<string>, coverageYears: Set<number>} | undefined} data merged calendar.
 */
export function applyHolidayData(data) {
  if (data === undefined || data === null) return
  holidayDates = data.dates instanceof Set ? data.dates : new Set(data.dates)
  holidayCoverageYears = data.coverageYears instanceof Set ? data.coverageYears : new Set(data.coverageYears)
}

/**
 * @returns {{dates: Set<string>, coverageYears: Set<number>}} the active holiday calendar.
 */
export function getHolidayState() {
  return { dates: holidayDates, coverageYears: holidayCoverageYears }
}

/**
 * Whether one Beijing calendar day is a statutory holiday.
 * @param {string} dateKey `YYYY-MM-DD` in Asia/Shanghai.
 * @param {ReadonlySet<string>} [dates] holiday dates; defaults to the active calendar.
 * @returns {boolean}
 */
export function isHolidayDate(dateKey, dates = holidayDates) {
  return dates.has(dateKey)
}

/**
 * Whether one instant is inside a weekday peak window of a non-holiday day.
 * @param {number} timeMs epoch milliseconds.
 * @param {ReadonlySet<string>} [dates] holiday dates; defaults to the active calendar.
 * @returns {boolean}
 */
export function isPeakTime(timeMs, dates = holidayDates) {
  const parts = zonedParts(timeMs)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  if (isHolidayDate(parts.dateKey, dates)) return false
  const minutes = parts.hour * 60 + parts.minute
  return PEAK_WINDOWS.some((window) => minutes >= window.start && minutes < window.end)
}

/**
 * Whether one instant is off-peak (谷时): everything that is not peak.
 * @param {number} timeMs epoch milliseconds.
 * @param {ReadonlySet<string>} [dates] holiday dates; defaults to the active calendar.
 * @returns {boolean}
 */
export function isValleyTime(timeMs, dates = holidayDates) {
  return !isPeakTime(timeMs, dates)
}

/**
 * The next instant at which a valley window starts.
 *
 * Only meaningful from inside a peak window, where the answer is the end of
 * that window (12:00 or 18:00 the same day). From a valley instant it returns
 * `timeMs` itself — there is nothing to wait for.
 * @param {number} timeMs epoch milliseconds "now".
 * @param {ReadonlySet<string>} [dates] holiday dates; defaults to the active calendar.
 * @returns {number} epoch milliseconds of the next valley opening.
 */
export function nextValleyStart(timeMs, dates = holidayDates) {
  if (!isPeakTime(timeMs, dates)) return timeMs
  const parts = zonedParts(timeMs)
  const minutes = parts.hour * 60 + parts.minute
  const window = PEAK_WINDOWS.find((candidate) => minutes >= candidate.start && minutes < candidate.end)
  return zonedWallToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Math.floor(window.end / 60),
    minute: window.end % 60,
  })
}

/**
 * Remove every invisible execution marker from one text.
 * @param {string} text raw text.
 * @returns {string} text without markers.
 */
export function stripMarkers(text) {
  return typeof text === 'string' ? text.split(MARKER).join('') : ''
}

/**
 * Whether one text carries the invisible execution marker.
 * @param {string} text raw text.
 * @returns {boolean}
 */
export function hasMarker(text) {
  return typeof text === 'string' && text.includes(MARKER)
}
