import {
  getHolidayState, isValleyTime, nextValleyStart, zonedParts,
} from '../time.js'

const now = Date.now()
const parts = zonedParts(now)
const state = getHolidayState()
const coverage = [...state.coverageYears].sort()
const pad = (n) => String(n).padStart(2, '0')
const clock = `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
const inValley = isValleyTime(now)
console.log(`beijing now      : ${clock} (weekday ${parts.weekday === 0 ? 'Sun' : parts.weekday})`)
console.log(`holiday today    : ${state.dates.has(parts.dateKey)}`)
console.log(`coverage years   : ${coverage.join(',')}`)
console.log(`state now        : ${inValley ? 'VALLEY (谷时) -> switch locked, click shows 当前已处于峰谷时段了' : 'PEAK (高峰) -> switch can be enabled'}`)
if (!inValley) {
  const next = format(nextValleyStart(now))
  console.log(`next valley start: ${next}`)
}

function format(targetMs) {
  const t = zonedParts(targetMs)
  const n = zonedParts(now)
  const sameDay = t.year === n.year && t.month === n.month && t.day === n.day
  return `${sameDay ? '今天' : '明天'} ${pad(t.hour)}:${pad(t.minute)}`
}
