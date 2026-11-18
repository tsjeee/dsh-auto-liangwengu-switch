/**
 * Sync checks: the browser bundle's private copies (offline holiday fallback,
 * peak/valley arithmetic, calendar-payload parser, marker) must agree with the
 * Host half, and the fallback must stay equal to `holiday-data.json`.
 * The browser bundle cannot import the Host modules, so this test keeps the
 * duplicated copies honest.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  MARKER, PEAK_WINDOWS, isPeakTime, isValleyTime, nextValleyStart,
} from '../time.js'
import { loadHolidayFile } from '../holidays.js'
import { buildCalendarPayload, parseCalendarPayload as hostParseCalendarPayload } from '../calendar-payload.js'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let loaded
const fakeReact = {
  createElement: (...args) => ({ type: 'element', args }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const fakeWindow = {
  __ModuleLoader__: { load: (entry) => { loaded = entry } },
  __PEAK_VALLEY_TEST__: true,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}
new Function('window', source)(fakeWindow)
const client = loaded.factory((id) => fakeReact).__test
assert.ok(client, 'the bundle exposes its test face when __PEAK_VALLEY_TEST__ is set')

const fileData = loadHolidayFile()
assert.ok(fileData !== undefined, 'holiday-data.json must load')

// --- duplicated constants ---------------------------------------------------
assert.equal(client.MARKER, MARKER, 'marker constants must match')
assert.deepEqual(client.PEAK_WINDOWS, PEAK_WINDOWS, 'peak windows must match')
assert.equal(client.CALENDAR_ROUTE, '/peak-valley/calendar', 'calendar route must match the Host route')

// --- offline fallback == holiday-data.json ----------------------------------
const fallback = client.fallbackCalendar()
assert.deepEqual([...fallback.coverageYears].sort(), [...fileData.coverageYears].sort(), 'fallback years must match holiday-data.json')
assert.deepEqual([...fallback.dates].sort(), [...fileData.dates].sort(), 'fallback holiday dates must match holiday-data.json')

// --- duplicated arithmetic over a calendar sweep ----------------------------
const fetched2028 = { dates: new Set(['2028-01-03', '2028-01-04']), coverageYears: new Set([2028]) }
let checked = 0
for (let day = Date.parse('2026-01-01T00:00:00+08:00'); day <= Date.parse('2028-12-31T00:00:00+08:00'); day += 86400000) {
  for (const hour of [0, 8, 9, 12, 13, 14, 18, 23]) {
    const instant = day + hour * 3600000
    const hostDates = instant >= Date.parse('2028-01-01T00:00:00+08:00') ? fetched2028.dates : fileData.dates
    const clientDates = instant >= Date.parse('2028-01-01T00:00:00+08:00') ? fetched2028.dates : fallback.dates
    const at = new Date(instant).toISOString()
    assert.equal(client.isPeakTime(instant, clientDates), isPeakTime(instant, hostDates), `isPeakTime mismatch at ${at}`)
    assert.equal(client.isValleyTime(instant, clientDates), isValleyTime(instant, hostDates), `isValleyTime mismatch at ${at}`)
    assert.equal(client.nextValleyStart(instant, clientDates), nextValleyStart(instant, hostDates), `nextValleyStart mismatch at ${at}`)
    checked += 1
  }
}

// --- client payload parser agrees with the Host parser ----------------------
const payload = buildCalendarPayload({ dates: fileData.dates, coverageYears: fileData.coverageYears })
const clientParsed = client.parseCalendarPayload(JSON.parse(JSON.stringify(payload)))
const hostParsed = hostParseCalendarPayload(JSON.parse(JSON.stringify(payload)))
assert.ok(clientParsed && hostParsed)
assert.deepEqual([...clientParsed.dates].sort(), [...hostParsed.dates].sort(), 'payload parser dates must agree')
assert.deepEqual([...clientParsed.coverageYears].sort(), [...hostParsed.coverageYears].sort(), 'payload parser years must agree')
assert.equal(client.parseCalendarPayload(null), undefined, 'both parsers reject null')
assert.equal(client.parseCalendarPayload({ holidays: 'x' }), undefined, 'both parsers reject a bad holidays field')

// --- label ------------------------------------------------------------------
assert.equal(client.formatValleyStart(nextValleyStart(Date.parse('2026-11-16T10:00:00+08:00'), fileData.dates), Date.parse('2026-11-16T10:00:00+08:00')), '今天 12:00')
assert.equal(client.formatValleyStart(nextValleyStart(Date.parse('2026-11-16T15:00:00+08:00'), fileData.dates), Date.parse('2026-11-16T15:00:00+08:00')), '今天 18:00')

console.log(`client/Host sync checks passed (${checked} instants)`)
