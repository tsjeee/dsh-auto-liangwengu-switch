/**
 * Smoke checks for the 峰谷执行 Client half: the bundle registers one
 * `conversation.input.activity` occupant with its verification face, the
 * occupant renders, the peak/valley gate behaves at a fixed clock, and an
 * uncovered year is warned about instead of silently mislabeling holidays.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Beijing wall clock -> epoch ms. */
const bj = (date, time) => Date.parse(`${date}T${time}+08:00`)
const PEAK = bj('2026-11-16', '10:00:00') // Monday morning peak, 2026 covered
const VALLEY = bj('2026-11-16', '18:40:00') // Monday evening valley
const UNCOVERED_PEAK = bj('2028-01-03', '10:00:00') // Monday morning peak, 2028 not in the fallback

let loaded
const setCalls = []
const fakeReact = {
  createElement: (...args) => ({ type: 'element', args }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    const setter = (next) => { setCalls.push(typeof next === 'function' ? next(value) : next) }
    return [value, setter]
  },
}
const fakeWindow = {
  __ModuleLoader__: { load: (entry) => { loaded = entry } },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  fetch: async () => ({ ok: false, status: 404 }),
}

new Function('window', source)(fakeWindow)
assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-auto-liangwengu-switch')

const plugin = loaded.factory((id) => {
  assert.equal(id, 'react')
  return fakeReact
})
assert.equal(typeof plugin.apply, 'function')
assert.ok(plugin.inject.includes('slots'))
assert.ok(plugin.inject.includes('remote'))

const registrations = []
const ctx = {
  remote: {},
  slots: {
    inject(ownerKey, install) {
      assert.equal(ownerKey, 'conversation.input.activity')
      install()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
}
plugin.apply(ctx)
assert.equal(registrations.length, 1, 'exactly one activity occupant is registered')
assert.equal(registrations[0].options.name, 'conversation.input.activity')
assert.equal(typeof registrations[0].options.inject, 'function', 'the occupant injects its verification face')
const injected = registrations[0].options.inject()
assert.equal(typeof injected.findScheduledTask, 'function')
assert.equal(await injected.findScheduledTask('session-abc', 'task'), null, 'a Host without a schedule Remote falls back to optimistic feedback')

const Component = registrations[0].Component
const props = {
  locked: false,
  sessionId: 'session-abc',
  findScheduledTask: injected.findScheduledTask,
  useInput: (selector) => selector({ draft: '', phase: 'plain', attachmentIds: [], occurrences: [] }),
  useSession: (selector) => selector({ subagent: null }),
  inputActions: {
    setDraft: () => {},
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: () => true,
  },
}

const realNow = Date.now
function renderAt(instant) {
  Date.now = () => instant
  setCalls.length = 0
  return Component(props)
}
function switchButton(tree) {
  const buttons = []
  function walk(node) {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'element') {
      const options = node.args[1]
      if (options !== null && options !== undefined && options.role === 'switch') buttons.push({ options, node })
      for (const child of node.args.slice(2)) walk(child)
    }
  }
  walk(tree)
  assert.equal(buttons.length, 1, 'the tree contains exactly one switch')
  return buttons[0]
}

try {
  // Peak in a covered year: the switch is off and explains the next valley opening.
  const peakTree = renderAt(PEAK)
  const peakSwitch = switchButton(peakTree)
  assert.equal(peakSwitch.options['aria-checked'], 'false')
  assert.ok(peakSwitch.options.title.includes('今天 12:00'), 'peak title names the next valley opening')
  assert.ok(!JSON.stringify(peakTree).includes('峰谷执行*'), 'a covered year shows no warning marker')
  peakSwitch.options.onClick()
  const enabledCall = setCalls.find(call => call !== null && typeof call === 'object' && call.enabled === true)
  assert.ok(enabledCall, 'clicking during peak turns the switch on')
  const openedStatus = setCalls.find(call => call !== null && typeof call === 'object' && typeof call.text === 'string')
  assert.ok(openedStatus.text.includes('今天 12:00'), 'enabling names the target time')
  assert.ok(!openedStatus.text.includes('节假日数据未覆盖'), 'a covered year enabling adds no coverage warning')

  // Valley: the switch cannot turn on and the click reports the valley state.
  const valleyTree = renderAt(VALLEY)
  const valleySwitch = switchButton(valleyTree)
  assert.equal(valleySwitch.options['aria-checked'], 'false')
  assert.ok(valleySwitch.options.title.includes('当前已处于峰谷时段'), 'valley title explains why it cannot be enabled')
  valleySwitch.options.onClick()
  const valleyStatus = setCalls.find(call => call !== null && typeof call === 'object' && typeof call.text === 'string')
  assert.equal(valleyStatus.text, '当前已处于峰谷时段了', 'valley click shows the required prompt')
  assert.equal(setCalls.some(call => call !== null && typeof call === 'object' && call.enabled === true), false, 'valley click never enables the switch')

  // Uncovered year (after the last data year): keep working but warn visibly.
  const uncoveredTree = renderAt(UNCOVERED_PEAK)
  const uncoveredSwitch = switchButton(uncoveredTree)
  assert.ok(JSON.stringify(uncoveredTree).includes('峰谷执行*'), 'an uncovered year marks the label')
  assert.ok(uncoveredSwitch.options.title.includes('节假日数据未覆盖 2028 年'), 'an uncovered year warns in the tooltip')
  uncoveredSwitch.options.onClick()
  const uncoveredStatus = setCalls.find(call => call !== null && typeof call === 'object' && typeof call.text === 'string')
  assert.ok(uncoveredStatus.text.includes('节假日数据未覆盖 2028 年'), 'enabling in an uncovered year warns too')

  // Subagent conversations cannot use Host scheduled delivery: render nothing.
  assert.equal(Component({ ...props, useSession: (selector) => selector({ subagent: { address: {} } }) }), null)
} finally {
  Date.now = realNow
}

console.log('client smoke checks passed')
