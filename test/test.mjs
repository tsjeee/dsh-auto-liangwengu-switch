/**
 * Unit checks for the 峰谷执行 Host half: DeepSeek's peak/valley calendar, the
 * holiday data file, remote fill-in, the client payload contract, the invisible
 * marker, and the pre-step interception.
 * Run with the harness Node runtime; no DSH process and no network are needed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  MARKER, PEAK_WINDOWS, applyHolidayData, getHolidayState, hasMarker,
  isHolidayDate, isPeakTime, isValleyTime, nextValleyStart, zonedParts,
} from '../time.js'
import {
  fetchHolidayYear, loadHolidayFile, mergeHolidayData, parseHolidayData,
} from '../holidays.js'
import { buildCalendarPayload, parseCalendarPayload } from '../calendar-payload.js'
import { interceptAt } from '../interception.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Beijing wall clock -> epoch ms. */
const bj = (date, time) => Date.parse(`${date}T${time}+08:00`)

// The shipped data file is the Host's baseline; every calendar check passes its
// holiday set explicitly so tests cannot depend on fetch timing.
const fileData = loadHolidayFile()
assert.ok(fileData !== undefined, 'holiday-data.json must load and validate')
const holidays = fileData.dates
applyHolidayData(fileData)
const dataFile = JSON.parse(fs.readFileSync(new URL('../holiday-data.json', import.meta.url), 'utf8'))

// --- calendar: weekdays -----------------------------------------------------

check('Monday 10:00 Beijing is peak', () => {
  assert.equal(isPeakTime(bj('2026-11-16', '10:00:00'), holidays), true)
  assert.equal(isValleyTime(bj('2026-11-16', '10:00:00'), holidays), false)
})
check('09:00:00 starts the morning peak and 12:00:00 ends it', () => {
  assert.equal(isPeakTime(bj('2026-11-16', '09:00:00'), holidays), true)
  assert.equal(isPeakTime(bj('2026-11-16', '11:59:59'), holidays), true)
  assert.equal(isPeakTime(bj('2026-11-16', '12:00:00'), holidays), false)
  assert.equal(isValleyTime(bj('2026-11-16', '12:00:00'), holidays), true)
})
check('the 12:00-14:00 midday break is valley', () => {
  assert.equal(isValleyTime(bj('2026-11-16', '12:30:00'), holidays), true)
  assert.equal(isValleyTime(bj('2026-11-16', '13:59:59'), holidays), true)
})
check('14:00:00 starts the afternoon peak and 18:00:00 ends it', () => {
  assert.equal(isPeakTime(bj('2026-11-16', '14:00:00'), holidays), true)
  assert.equal(isPeakTime(bj('2026-11-16', '17:59:59'), holidays), true)
  assert.equal(isPeakTime(bj('2026-11-16', '18:00:00'), holidays), false)
  assert.equal(isValleyTime(bj('2026-11-16', '18:40:00'), holidays), true)
})
check('night time is valley', () => {
  assert.equal(isValleyTime(bj('2026-11-17', '02:00:00'), holidays), true)
  assert.equal(isValleyTime(bj('2026-11-17', '00:30:00'), holidays), true)
})

// --- calendar: weekends and holidays ---------------------------------------

check('Saturday and Sunday are always valley, including make-up workdays', () => {
  assert.equal(isValleyTime(bj('2026-11-21', '10:00:00'), holidays), true)
  assert.equal(isValleyTime(bj('2026-11-22', '10:00:00'), holidays), true)
  assert.equal(isValleyTime(bj('2026-02-14', '10:00:00'), holidays), true) // 官方调休上班的周六
  assert.equal(isValleyTime(bj('2026-10-10', '10:00:00'), holidays), true)
})
check('statutory holiday weekdays are valley all day', () => {
  assert.equal(isHolidayDate('2026-10-05', holidays), true)
  assert.equal(isValleyTime(bj('2026-10-05', '10:00:00'), holidays), true)
  assert.equal(isValleyTime(bj('2026-02-17', '10:00:00'), holidays), true)
  assert.equal(isValleyTime(bj('2027-02-08', '15:00:00'), holidays), true)
  assert.equal(isValleyTime(bj('2027-06-09', '10:00:00'), holidays), true)
})
check('the first workday after a holiday is peak again', () => {
  assert.equal(isHolidayDate('2026-10-08', holidays), false)
  assert.equal(isPeakTime(bj('2026-10-08', '10:00:00'), holidays), true)
  assert.equal(isPeakTime(bj('2027-02-15', '10:00:00'), holidays), true)
})
check('holiday-data.json covers 2026 and 2027', () => {
  assert.deepEqual([...fileData.coverageYears].sort(), [2026, 2027])
  assert.equal(PEAK_WINDOWS.length, 2)
  const expanded = holidays.size
  assert.ok(expanded >= 50, `expanded holiday dates look too few: ${expanded}`)
})

// --- next valley opening ----------------------------------------------------

check('morning peak defers to 12:00 the same day', () => {
  const now = bj('2026-11-16', '10:00:00')
  assert.equal(new Date(nextValleyStart(now, holidays)).toISOString(), '2026-11-16T04:00:00.000Z')
  assert.equal(nextValleyStart(bj('2026-11-16', '11:59:59'), holidays), bj('2026-11-16', '12:00:00'))
})
check('afternoon peak defers to 18:00 the same day', () => {
  const now = bj('2026-11-16', '15:00:00')
  assert.equal(new Date(nextValleyStart(now, holidays)).toISOString(), '2026-11-16T10:00:00.000Z')
  assert.equal(nextValleyStart(bj('2026-11-16', '17:59:59'), holidays), bj('2026-11-16', '18:00:00'))
})
check('a valley instant has nothing to wait for', () => {
  const now = bj('2026-11-16', '18:40:00')
  assert.equal(nextValleyStart(now, holidays), now)
})

// --- holiday-data.json parsing ---------------------------------------------

check('parseHolidayData accepts a minimal valid document', () => {
  const parsed = parseHolidayData({ years: { 2028: [['2028-01-01', '2028-01-02']] } })
  assert.ok(parsed)
  assert.deepEqual([...parsed.coverageYears], [2028])
  assert.deepEqual([...parsed.dates].sort(), ['2028-01-01', '2028-01-02'])
})
check('parseHolidayData rejects malformed documents', () => {
  assert.equal(parseHolidayData(null), undefined)
  assert.equal(parseHolidayData({}), undefined)
  assert.equal(parseHolidayData({ years: {} }), undefined)
  assert.equal(parseHolidayData({ years: { '26': [['2026-01-01', '2026-01-01']] } }), undefined)
  assert.equal(parseHolidayData({ years: { 2026: [['2026-01-02', '2026-01-01']] } }), undefined)
  assert.equal(parseHolidayData({ years: { 2026: [['2026-13-01', '2026-13-02']] } }), undefined)
  assert.equal(parseHolidayData({ years: { 2026: [['2027-01-01', '2027-01-02']] } }), undefined)
})
check('the shipped data file matches its expected years', () => {
  assert.deepEqual(Object.keys(dataFile.years).sort(), ['2026', '2027'])
  assert.ok(Array.isArray(dataFile.years['2026']))
  assert.ok(dataFile.years['2026'].length >= 7)
})

// --- remote fill-in ---------------------------------------------------------

await checkAsync('fetchHolidayYear reduces a valid payload to off-day dates', async () => {
  const fakeFetch = async () => ({
    ok: true,
    async json() {
      return {
        year: 2028,
        days: [
          { name: '元旦', date: '2028-01-01', isOffDay: true },
          { name: '元旦', date: '2028-01-02', isOffDay: true },
          { name: '元旦', date: '2028-01-03', isOffDay: true },
          { name: '调休', date: '2028-01-08', isOffDay: false },
        ],
      }
    },
  })
  const dates = await fetchHolidayYear(2028, { fetchImpl: fakeFetch })
  assert.deepEqual([...dates].sort(), ['2028-01-01', '2028-01-02', '2028-01-03'])
})
await checkAsync('fetchHolidayYear rejects an invalid or too-small payload', async () => {
  const wrongYear = await fetchHolidayYear(2028, { fetchImpl: async () => ({ ok: true, async json() { return { year: 2027, days: [] } } }) })
  assert.equal(wrongYear, undefined)
  const tooFew = await fetchHolidayYear(2028, { fetchImpl: async () => ({ ok: true, async json() { return { year: 2028, days: [{ date: '2028-01-01', isOffDay: true }] } } }) })
  assert.equal(tooFew, undefined)
  const httpError = await fetchHolidayYear(2028, { fetchImpl: async () => ({ ok: false, async json() { return {} } }) })
  assert.equal(httpError, undefined)
  const throwing = await fetchHolidayYear(2028, { fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(throwing, undefined)
})
check('mergeHolidayData unions dates and coverage', () => {
  const merged = mergeHolidayData([
    { dates: new Set(['2028-01-01']), coverageYears: new Set([2028]) },
    { dates: new Set(['2028-01-02', '2028-01-01']), coverageYears: new Set([2029]) },
    undefined,
  ])
  assert.deepEqual([...merged.dates].sort(), ['2028-01-01', '2028-01-02'])
  assert.deepEqual([...merged.coverageYears].sort(), [2028, 2029])
})

// --- client payload ---------------------------------------------------------

check('the client payload round-trips', () => {
  const payload = buildCalendarPayload({ dates: holidays, coverageYears: fileData.coverageYears })
  assert.deepEqual(payload.peakWindows, [[540, 720], [840, 1080]])
  assert.deepEqual(payload.coverageYears, [2026, 2027])
  assert.ok(payload.holidays.includes('2026-10-05'))
  const parsed = parseCalendarPayload(JSON.parse(JSON.stringify(payload)))
  assert.ok(parsed)
  assert.deepEqual([...parsed.coverageYears].sort(), [2026, 2027])
  assert.equal(parsed.dates.has('2026-10-05'), true)
})
check('the client payload parser rejects malformed payloads', () => {
  assert.equal(parseCalendarPayload(null), undefined)
  assert.equal(parseCalendarPayload({ holidays: 'x' }), undefined)
  assert.equal(parseCalendarPayload({ holidays: Array.from({ length: 801 }, () => '2026-01-01') }), undefined)
})

// --- applying a new calendar (post-2027 path) -------------------------------

check('a fetched 2028 holiday overrides the weekday peak for that day', () => {
  assert.equal(isPeakTime(bj('2028-01-03', '10:00:00'), holidays), true) // Monday, uncovered year
  applyHolidayData(mergeHolidayData([
    fileData,
    { dates: new Set(['2028-01-03']), coverageYears: new Set([2028]) },
  ]))
  assert.equal(isPeakTime(bj('2028-01-03', '10:00:00')), false)
  assert.equal(getHolidayState().coverageYears.has(2028), true)
  applyHolidayData(fileData)
})

// --- marker -----------------------------------------------------------------

check('marker detection ignores ordinary text', () => {
  assert.equal(hasMarker('普通任务'), false)
  assert.equal(hasMarker(`普通任务${MARKER}`), true)
})
check('the marker survives the composer prompt serialization trim', () => {
  const sent = `整理竞品报告${MARKER}`.trimEnd()
  assert.equal(hasMarker(sent), true)
  assert.equal(sent.replace(MARKER, ''), '整理竞品报告')
  assert.equal('整理竞品报告\uFEFF\uFEFF\uFEFF'.trimEnd().includes('\uFEFF'), false)
})

// --- Host interception ------------------------------------------------------

const PEAK_NOW = bj('2026-11-16', '10:00:00') // Monday morning peak
const VALLEY_NOW = bj('2026-11-16', '18:40:00') // Monday evening valley

let schedule
function freshContext({ failing = false } = {}) {
  schedule = {
    created: [],
    async create(request, actorSessionId, signal) {
      if (failing) throw new Error('boom')
      this.created.push({ request, actorSessionId, signal })
      return { id: 'schedule-test', scheduledAt: request.timing.at }
    },
  }
  const logs = []
  return {
    ctx: {
      get(name) { return name === 'schedule' ? schedule : undefined },
      logger: { info(message) { logs.push(message) }, warn(message) { logs.push(message) } },
    },
    logs,
  }
}

function markedMessage(text) {
  return { id: `msg-${Math.random()}`, source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: `${text}${MARKER}` }] }
}
function plainMessage(text) {
  return { id: `msg-${Math.random()}`, source: { kind: 'user', rpcId: 'rpc-2' }, content: [{ type: 'text', text }] }
}
const enter = (messages) => async () => ({ kind: 'enter', messages })
const payload = { agent: { session: { id: 'session-abc' } }, messages: [], signal: undefined }

await checkAsync('a marked prompt during peak becomes a task due at 12:00', async () => {
  const { ctx } = freshContext()
  const message = markedMessage('整理竞品报告')
  const decision = await interceptAt(ctx, payload, enter([message]), PEAK_NOW)
  assert.equal(decision.kind, 'reject')
  assert.equal(schedule.created.length, 1)
  const { request, actorSessionId } = schedule.created[0]
  assert.equal(request.prompt, '整理竞品报告')
  assert.equal(request.title, '整理竞品报告')
  assert.deepEqual(request.timing, { kind: 'at', at: '2026-11-16T04:00:00.000Z' })
  assert.deepEqual(request.target, { kind: 'session', sessionId: 'session-abc' })
  assert.equal(actorSessionId, 'session-abc')
})
await checkAsync('a marked prompt during the afternoon peak is due at 18:00', async () => {
  const { ctx } = freshContext()
  const message = markedMessage('下午的任务')
  await interceptAt(ctx, payload, enter([message]), bj('2026-11-16', '15:30:00'))
  assert.equal(schedule.created[0].request.timing.at, '2026-11-16T10:00:00.000Z')
})
await checkAsync('an unmarked prompt runs normally', async () => {
  const { ctx } = freshContext()
  const message = plainMessage('普通消息')
  const decision = await interceptAt(ctx, payload, enter([message]), PEAK_NOW)
  assert.equal(decision.kind, 'enter')
  assert.equal(schedule.created.length, 0)
  assert.equal(decision.messages[0].content[0].text, '普通消息')
})
await checkAsync('during valley a marked prompt runs immediately, marker stripped', async () => {
  const { ctx } = freshContext()
  const message = markedMessage('谷时直接执行')
  const decision = await interceptAt(ctx, payload, enter([message]), VALLEY_NOW)
  assert.equal(decision.kind, 'enter')
  assert.equal(schedule.created.length, 0)
  assert.equal(hasMarker(decision.messages[0].content[0].text), false)
  assert.equal(decision.messages[0].content[0].text, '谷时直接执行')
})
await checkAsync('a failed schedule keeps the prompt and strips the marker', async () => {
  const { ctx } = freshContext({ failing: true })
  const message = markedMessage('保住这条指令')
  const decision = await interceptAt(ctx, payload, enter([message]), PEAK_NOW)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0].content[0].text, '保住这条指令')
})
await checkAsync('a marked message with an attachment runs immediately, marker stripped', async () => {
  const { ctx } = freshContext()
  const message = {
    id: 'msg-attach',
    source: { kind: 'user', rpcId: 'rpc-3' },
    content: [{ type: 'text', text: `看图${MARKER}` }, { type: 'image', ref: 'x' }],
  }
  const decision = await interceptAt(ctx, payload, enter([message]), PEAK_NOW)
  assert.equal(decision.kind, 'enter')
  assert.equal(schedule.created.length, 0)
  assert.equal(decision.messages[0].content[0].text, '看图')
})
await checkAsync('a marker-only message is dropped entirely', async () => {
  const { ctx } = freshContext()
  const message = { id: 'msg-empty', source: { kind: 'user', rpcId: 'rpc-4' }, content: [{ type: 'text', text: MARKER }] }
  const decision = await interceptAt(ctx, payload, enter([message]), PEAK_NOW)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 0)
  assert.equal(schedule.created.length, 0)
})
await checkAsync('deferring a steering message keeps an unmarked message in the step', async () => {
  const { ctx } = freshContext()
  const marked = markedMessage('第二条')
  const plain = plainMessage('第一条')
  const decision = await interceptAt(ctx, payload, enter([marked, plain]), PEAK_NOW)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].content[0].text, '第一条')
  assert.equal(schedule.created.length, 1)
})

console.log(results.join('\n'))
const failed = results.filter(line => line.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
