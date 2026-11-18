import { fetchHolidayYear } from '../holidays.js'

const year2027 = await fetchHolidayYear(2027)
console.log('2027 remote:', year2027 === undefined ? 'undefined' : `${year2027.size} dates (e.g. ${[...year2027].slice(0, 3).join(',')})`)
const year2028 = await fetchHolidayYear(2028)
console.log('2028 remote:', year2028 === undefined ? 'undefined (not published yet -> warning path)' : `${year2028.size} dates`)
if (year2027 === undefined) process.exitCode = 1
