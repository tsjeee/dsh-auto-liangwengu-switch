/**
 * 峰谷执行 (peak-valley execution) — Client half.
 *
 * Renders one compact switch titled 峰谷执行 immediately after the composer's
 * model selector. While the switch is on, the draft carries an invisible
 * marker; the Host half turns a marked prompt into an automation task due at
 * the next off-peak opening instead of running it now.
 *
 * DeepSeek's current peak windows are Monday–Friday 09:00–12:00 and
 * 14:00–18:00 Beijing time, excluding Chinese statutory holidays; everything
 * else — midday break, nights, weekends, holidays — is off-peak (谷时), where
 * the switch stays off and explains why.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-liangwengu-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React
    // The marker sync runs as a layout effect so a submission typed in the same
    // frame as the first character still carries it; browsers without the named
    // export fall back to the passive effect.
    const useSync = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : useEffect

    /**
     * Invisible, zero-width execution marker. Three U+2060 WORD JOINERs:
     * `String#trim` keeps them, so the composer's prompt serialization (which
     * trims the first and last text token) cannot strip the marker away.
     * Kept in sync with the Host half's `time.js`.
     */
    const MARKER = '\u2060\u2060\u2060'
    const TIME_ZONE = 'Asia/Shanghai'
    /** Weekday peak windows as minute-of-day, half-open `[start, end)`. */
    const PEAK_WINDOWS = [
      { start: 9 * 60, end: 12 * 60 },
      { start: 14 * 60, end: 18 * 60 },
    ]
    /**
     * Offline fallback holiday ranges (inclusive, Beijing calendar days).
     * The Host is the source of truth: it serves the up-to-date holiday set on
     * {@link CALENDAR_ROUTE}, loaded from `holiday-data.json` and, for years the
     * file does not cover, from the public holiday-cn dataset. This fallback is
     * only used while that request is pending or unavailable, and the sync test
     * `peak-valley-test/client-sync.mjs` keeps it equal to `holiday-data.json`.
     */
    const HOLIDAY_FALLBACK_RANGES = [
      // 2026 年
      ['2026-01-01', '2026-01-03'],
      ['2026-02-15', '2026-02-23'],
      ['2026-04-04', '2026-04-06'],
      ['2026-05-01', '2026-05-05'],
      ['2026-06-19', '2026-06-21'],
      ['2026-09-25', '2026-09-27'],
      ['2026-10-01', '2026-10-07'],
      // 2027 年
      ['2027-01-01', '2027-01-03'],
      ['2027-02-05', '2027-02-13'],
      ['2027-04-03', '2027-04-05'],
      ['2027-05-01', '2027-05-05'],
      ['2027-06-09', '2027-06-09'],
      ['2027-09-15', '2027-09-15'],
      ['2027-10-01', '2027-10-07'],
    ]
    /** Exact Host route that serves the authoritative peak/valley calendar. */
    const CALENDAR_ROUTE = '/peak-valley/calendar'
    const STORAGE_PREFIX = 'dsh.peak-valley-execution.enabled.'
    const STATUS_VISIBLE_MS = 4200
    const EMPTY_OCCURRENCES = []

    /**
     * @param {readonly (readonly [string, string])[]} ranges inclusive date ranges.
     * @returns {Set<string>} every `YYYY-MM-DD` day inside the ranges.
     */
    function expandRanges(ranges) {
      const dates = new Set()
      for (const [start, end] of ranges) {
        const first = Date.parse(`${start}T00:00:00Z`)
        const last = Date.parse(`${end}T00:00:00Z`)
        if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) continue
        for (let day = first; day <= last; day += 86400000) {
          dates.add(new Date(day).toISOString().slice(0, 10))
        }
      }
      return dates
    }

    /** @returns {{dates: Set<string>, coverageYears: Set<number>}} the built-in fallback calendar. */
    function fallbackCalendar() {
      const coverageYears = new Set()
      for (const [start] of HOLIDAY_FALLBACK_RANGES) coverageYears.add(Number(start.slice(0, 4)))
      return { dates: expandRanges(HOLIDAY_FALLBACK_RANGES), coverageYears }
    }

    /**
     * Validate one Host calendar payload.
     * @param {unknown} value decoded JSON.
     * @returns {{dates: Set<string>, coverageYears: Set<number>} | undefined} accepted calendar.
     */
    function parseCalendarPayload(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      const holidays = value.holidays
      if (!Array.isArray(holidays) || holidays.length > 800) return undefined
      const dates = new Set()
      for (const date of holidays) {
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue
        const epoch = Date.parse(`${date}T00:00:00Z`)
        if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) continue
        dates.add(date)
      }
      const coverageYears = new Set()
      const coverage = value.coverageYears
      if (Array.isArray(coverage)) {
        for (const year of coverage) {
          const numeric = Number(year)
          if (Number.isInteger(numeric) && numeric >= 2000 && numeric <= 2100) coverageYears.add(numeric)
        }
      }
      return { dates, coverageYears }
    }

    /** Cached Host calendar; `null` until one request succeeds. */
    let hostCalendar = null
    let hostCalendarRequest = null
    let hostCalendarAttemptAt = 0

    /**
     * Read the Host calendar once, retrying failed requests at most every 30s.
     * @returns {Promise<{dates: Set<string>, coverageYears: Set<number>} | null>}
     */
    async function loadHostCalendar() {
      if (hostCalendar !== null) return hostCalendar
      if (hostCalendarRequest !== null) return hostCalendarRequest
      if (Date.now() - hostCalendarAttemptAt < 30000) return null
      hostCalendarAttemptAt = Date.now()
      hostCalendarRequest = (async () => {
        try {
          const response = await fetch(CALENDAR_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
          if (response === undefined || response === null || !response.ok) return null
          const parsed = parseCalendarPayload(await response.json())
          if (parsed !== undefined) hostCalendar = parsed
          return hostCalendar
        } catch {
          /* Transport failure, 401, or a non-JSON body: keep the fallback. */
          return null
        } finally {
          hostCalendarRequest = null
        }
      })()
      return hostCalendarRequest
    }

    /**
     * Read one instant as Beijing wall-clock parts.
     * @param {number} timeMs epoch milliseconds.
     * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number,dateKey:string}}
     */
    function zonedParts(timeMs) {
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
     * Resolve one Beijing wall-clock time to its instant.
     * @param {{year:number,month:number,day:number,hour:number,minute:number}} wall local time.
     * @returns {number} epoch milliseconds.
     */
    function zonedWallToUtc(wall) {
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

    /**
     * @param {string} dateKey `YYYY-MM-DD` in Asia/Shanghai.
     * @param {ReadonlySet<string>} dates holiday dates of the active calendar.
     * @returns {boolean} whether the day is a statutory holiday.
     */
    function isHolidayDate(dateKey, dates) {
      return dates.has(dateKey)
    }

    /**
     * @param {number} timeMs epoch milliseconds.
     * @param {ReadonlySet<string>} dates holiday dates of the active calendar.
     * @returns {boolean} whether the instant is inside a weekday peak window of
     * a non-holiday day.
     */
    function isPeakTime(timeMs, dates) {
      const parts = zonedParts(timeMs)
      if (parts.weekday === 0 || parts.weekday === 6) return false
      if (isHolidayDate(parts.dateKey, dates)) return false
      const minutes = parts.hour * 60 + parts.minute
      return PEAK_WINDOWS.some((window) => minutes >= window.start && minutes < window.end)
    }

    /**
     * @param {number} timeMs epoch milliseconds.
     * @param {ReadonlySet<string>} dates holiday dates of the active calendar.
     * @returns {boolean} whether the instant is off-peak (谷时).
     */
    function isValleyTime(timeMs, dates) {
      return !isPeakTime(timeMs, dates)
    }

    /**
     * The next instant at which a valley window starts; from a valley instant
     * it is `timeMs` itself (nothing to wait for).
     * @param {number} timeMs epoch milliseconds "now".
     * @param {ReadonlySet<string>} dates holiday dates of the active calendar.
     * @returns {number} epoch milliseconds of the next valley opening.
     */
    function nextValleyStart(timeMs, dates) {
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
     * Human-readable label for one valley opening.
     * @param {number} targetMs opening instant.
     * @param {number} [nowMs] current instant.
     * @returns {string} `今天 12:00`, `今天 18:00`, or a later day (Asia/Shanghai).
     */
    function formatValleyStart(targetMs, nowMs) {
      const now = nowMs === undefined ? Date.now() : nowMs
      const target = zonedParts(targetMs)
      const current = zonedParts(now)
      const sameDay = target.year === current.year && target.month === current.month && target.day === current.day
      const clock = `${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')}`
      return `${sameDay ? '今天' : '明天'} ${clock}`
    }

    /**
     * @param {string} text raw draft text.
     * @returns {string} the text without execution markers.
     */
    function stripMarkers(text) {
      return typeof text === 'string' ? text.split(MARKER).join('') : ''
    }

    /**
     * @param {string} text raw draft text.
     * @returns {boolean} whether it carries an execution marker.
     */
    function hasMarker(text) {
      return typeof text === 'string' && text.includes(MARKER)
    }

    /**
     * Count the marker characters that sit before one clipboard offset.
     * @param {string} draft clipboard projection.
     * @param {number} offset clipboard offset of a reference chip.
     * @returns {number} removed marker length before that offset.
     */
    function markerLengthBefore(draft, offset) {
      let count = 0
      let index = draft.indexOf(MARKER)
      while (index !== -1 && index < offset) {
        count += 1
        index = draft.indexOf(MARKER, index + MARKER.length)
      }
      return count * MARKER.length
    }

    /**
     * Rewrite the draft without execution markers. Reference chips survive:
     * a plain draft is replaced as text, a chip-bearing draft is restored from
     * its structured snapshot with shifted offsets.
     * @param {object} inputActions composer input actions.
     * @param {string} draft current clipboard projection.
     * @param {readonly object[]} occurrences reference chips of that projection.
     */
    function rewriteWithoutMarkers(inputActions, draft, occurrences) {
      const nextText = stripMarkers(draft)
      if (nextText === draft) return
      if (occurrences.length === 0) {
        inputActions.setDraft(nextText)
        return
      }
      const references = occurrences.map((occurrence) => {
        const { occurrenceId, ...reference } = occurrence
        return { ...reference, offset: reference.offset - markerLengthBefore(draft, reference.offset) }
      })
      inputActions.setDraft({ text: nextText, references })
    }

    /**
     * @param {string} sessionId addressed Session.
     * @param {ReadonlySet<string>} dates holiday dates of the active calendar.
     * @returns {boolean} the persisted switch position for this Session.
     */
    function readEnabled(sessionId, dates) {
      try {
        if (window.localStorage.getItem(STORAGE_PREFIX + sessionId) !== '1') return false
      } catch {
        return false
      }
      return !isValleyTime(Date.now(), dates)
    }

    /**
     * Ask the Host schedule catalog whether one deferred task exists.
     * @param {object | undefined} remote client Remote service face.
     * @param {string} sessionId addressed Session.
     * @param {string} sentText text the user sent, marker-free.
     * @returns {Promise<object | null | undefined>} the created task, `null` when
     * the catalog is unavailable, `undefined` when no matching task was found.
     */
    async function findScheduledTask(remote, sessionId, sentText) {
      const schedule = remote === undefined || remote === null ? undefined : remote.schedule
      if (schedule === undefined || schedule === null || typeof schedule.list !== 'function') return null
      for (const delay of [400, 1400]) {
        await new Promise((resolve) => { setTimeout(resolve, delay) })
        try {
          const result = await schedule.list({ active: true, limit: 50 })
          if (result === undefined || result === null || result.ok !== true) continue
          const items = result.value !== null && Array.isArray(result.value.items) ? result.value.items : []
          const hit = items.find((item) => {
            if (item === null || item === undefined || item.target === undefined || item.target === null) return false
            if (item.target.kind !== 'session' || item.target.sessionId !== sessionId) return false
            if (item.status !== 'active') return false
            if (typeof item.prompt === 'string' && item.prompt === sentText) return true
            const created = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN
            return Number.isFinite(created) && Date.now() - created < 90000
          })
          if (hit !== undefined) return hit
        } catch {
          /* Denied or transport failure: keep the optimistic fallback. */
        }
      }
      return undefined
    }

    const S = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', flex: 'none' },
      bubble: {
        position: 'absolute',
        right: '0',
        bottom: 'calc(100% + 6px)',
        zIndex: 1,
        maxWidth: '260px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '3px 8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-fill-l1, var(--dsw-alias-interactive-bg-hover-solid))',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        pointerEvents: 'none',
      },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        flex: 'none',
        height: '28px',
        padding: '0 8px',
        border: 'none',
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        outline: 'none',
        transition: 'background-color 120ms ease',
      },
      label: { fontSize: '13px', lineHeight: '20px', fontWeight: 400 },
      track: {
        position: 'relative',
        flex: 'none',
        width: '32px',
        height: '18px',
        borderRadius: '999px',
        transition: 'background-color 120ms ease',
      },
      thumb: {
        position: 'absolute',
        top: '2px',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-on-color, #ffffff)',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
        transition: 'left 120ms ease',
      },
    }

    /**
     * The composer's off-peak execution switch.
     * @param {object} props slot props (owner `locked`, the session standard kit,
     * and the injected `findScheduledTask` face).
     * @returns {object | null} rendered switch.
     */
    function PeakValleyExecution(props) {
      const {
        locked, useInput, inputActions, useSession, sessionId, findScheduledTask: checkScheduled,
      } = props
      const draft = useInput((state) => (state === undefined ? '' : state.draft)) || ''
      const phase = useInput((state) => (state === undefined ? 'plain' : state.phase)) || 'plain'
      const occurrences = useInput((state) => (state === undefined ? EMPTY_OCCURRENCES : state.occurrences)) || EMPTY_OCCURRENCES
      const attachmentCount = useInput((state) => (state === undefined ? 0 : state.attachmentIds.length)) || 0
      const subagent = useSession((state) => (state === undefined ? null : state.subagent)) || null

      // Start from the offline fallback, then adopt the Host's authoritative
      // calendar as soon as the route answers (older/newer years included).
      const [calendar, setCalendar] = useState(fallbackCalendar)
      useEffect(() => {
        let alive = true
        void loadHostCalendar().then((host) => {
          if (alive && host !== null) setCalendar(host)
        })
        return () => { alive = false }
      }, [])
      const holidayDates = calendar.dates

      // The position is per addressed Session; adjust during render so the
      // very first commit after a session switch never carries the previous
      // Session's marker intent into the new draft.
      const [switchState, setSwitchState] = useState(() => ({ sessionId, enabled: readEnabled(sessionId, holidayDates) }))
      if (switchState.sessionId !== sessionId) setSwitchState({ sessionId, enabled: readEnabled(sessionId, holidayDates) })
      const enabled = switchState.sessionId === sessionId ? switchState.enabled : readEnabled(sessionId, holidayDates)
      const setEnabled = (value) => { setSwitchState({ sessionId, enabled: value }) }

      const [now, setNow] = useState(() => Date.now())
      const [hover, setHover] = useState(false)
      const [focused, setFocused] = useState(false)
      const [status, setStatus] = useState(null)
      const statusSeq = useRef(0)
      const sentRef = useRef(null)
      const aliveRef = useRef(true)
      const inValley = isValleyTime(now, holidayDates)
      const thisYear = zonedParts(now).year
      const coverageIncomplete = !calendar.coverageYears.has(thisYear)
      const coverageNote = coverageIncomplete
        ? `；节假日数据未覆盖 ${thisYear} 年，节假日可能被按高峰处理，可更新 holiday-data.json 或等待自动补全`
        : ''
      const bare = stripMarkers(draft)
      const commandDraft = bare.trimStart().startsWith('/')
      const hasText = bare.trim() !== ''
      const editable = phase === 'plain' && !locked

      useEffect(() => () => { aliveRef.current = false }, [])

      const showStatus = (text) => {
        statusSeq.current += 1
        setStatus({ text, seq: statusSeq.current })
      }

      // Addressed Session changed: drop its transient feedback.
      useEffect(() => {
        setStatus(null)
        sentRef.current = null
      }, [sessionId])

      // Keep the window state fresh enough to block and auto-close.
      useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 15000)
        return () => clearInterval(id)
      }, [])

      // The window owns the switch: it can never stay on inside the valley.
      useEffect(() => {
        if (!inValley) return
        setEnabled(false)
      }, [inValley])

      // Close exactly at the next opening instead of waiting for the next tick.
      useEffect(() => {
        if (!enabled) return
        const delay = Math.max(0, nextValleyStart(Date.now(), holidayDates) - Date.now()) + 300
        const id = setTimeout(() => {
          setNow(Date.now())
          setEnabled(false)
        }, delay)
        return () => clearTimeout(id)
      }, [enabled, holidayDates])

      // Persist the position per addressed Session.
      useEffect(() => {
        try {
          if (enabled) window.localStorage.setItem(STORAGE_PREFIX + sessionId, '1')
          else window.localStorage.removeItem(STORAGE_PREFIX + sessionId)
        } catch {
          /* Storage may be blocked; the switch still works for this mount. */
        }
      }, [enabled, sessionId])

      // Keep the Host-side marker in the draft exactly while it belongs there.
      useSync(() => {
        const marked = hasMarker(draft)
        if (!marked) {
          if (!enabled || !editable || inValley || commandDraft || !hasText) return
          // Insert at the caret with a collapsed span: an existing selection
          // must never be replaced by the invisible marker.
          const span = inputActions.captureInsertion()
          inputActions.insertText(MARKER, { start: span.end, end: span.end, draftRev: span.draftRev })
          return
        }
        if (enabled && !inValley && !commandDraft && hasText) return
        if (!editable) return
        rewriteWithoutMarkers(inputActions, draft, occurrences)
      }, [draft, enabled, editable, inValley, commandDraft, hasText, occurrences, inputActions])

      // Feedback after an accepted send: confirm the automation task when the
      // Host catalog proves it, and say so plainly when it did not happen.
      useEffect(() => {
        if (phase === 'sending') {
          if (sentRef.current === null) {
            sentRef.current = {
              enabled,
              text: stripMarkers(draft).trim(),
              attachments: attachmentCount,
            }
          }
          return
        }
        if (phase !== 'plain' || sentRef.current === null) return
        const sent = sentRef.current
        sentRef.current = null
        if (!sent.enabled || draft !== '') return
        if (sent.attachments > 0) {
          showStatus('含附件，未转为自动化任务')
          return
        }
        const label = formatValleyStart(nextValleyStart(Date.now(), holidayDates))
        const successText = `已转为自动化任务：将于${label} 执行`
        if (typeof checkScheduled !== 'function') {
          showStatus(successText)
          return
        }
        showStatus(successText)
        void checkScheduled(sessionId, sent.text).then((hit) => {
          if (!aliveRef.current || hit !== undefined) return
          showStatus('未转为自动化任务：消息已直接执行')
        }, () => { /* transport failure: keep the optimistic line */ })
      }, [phase, draft, enabled, sessionId, checkScheduled, holidayDates])

      // Transient feedback dismisses itself.
      useEffect(() => {
        if (status === null) return
        const id = setTimeout(() => setStatus(null), STATUS_VISIBLE_MS)
        return () => clearTimeout(id)
      }, [status])

      if (subagent !== null) return null

      const toggle = () => {
        if (locked) return
        if (!enabled && isValleyTime(Date.now(), holidayDates)) {
          setNow(Date.now())
          showStatus('当前已处于峰谷时段了')
          return
        }
        if (!enabled && draft.trimStart().startsWith('/')) {
          showStatus('峰谷执行只对普通消息生效')
          return
        }
        const next = !enabled
        setEnabled(next)
        if (next) showStatus(`已开启：之后发送的消息将于${formatValleyStart(nextValleyStart(Date.now(), holidayDates))} 执行${coverageIncomplete ? `（注意：节假日数据未覆盖 ${thisYear} 年）` : ''}`)
      }

      const nextLabel = formatValleyStart(nextValleyStart(now, holidayDates), now)
      const title = locked
        ? '输入框当前不可用'
        : inValley
          ? `当前已处于峰谷时段，直接发送即可（高峰时段：工作日 9:00–12:00、14:00–18:00）${coverageNote}`
          : enabled
            ? `峰谷执行已开启：之后发送的消息将于${nextLabel} 执行${coverageNote}`
            : `开启后，之后发送的消息会挂载为自动化任务，在最近的峰谷时段（${nextLabel} 起）执行${coverageNote}`
      const labelColor = inValley
        ? 'var(--dsw-alias-label-tertiary)'
        : enabled
          ? 'var(--dsw-alias-state-business-primary, #3964fe)'
          : 'var(--dsw-alias-label-secondary)'
      const buttonStyle = {
        ...S.button,
        background: hover && !locked ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        cursor: locked ? 'default' : 'pointer',
        boxShadow: focused && !locked ? '0 0 0 2px var(--dsw-alias-state-business-primary, #3964fe)' : 'none',
        opacity: locked ? 0.4 : 1,
      }
      const trackStyle = {
        ...S.track,
        background: enabled
          ? 'var(--dsw-alias-state-business-primary, #3964fe)'
          : 'var(--dsw-alias-border-l4, #c9ced6)',
      }
      const thumbStyle = { ...S.thumb, left: enabled ? '16px' : '2px' }

      return h(
        'span',
        { style: S.wrap },
        status === null
          ? null
          : h('span', { key: status.seq, role: 'status', style: S.bubble, title: status.text }, status.text),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled ? 'true' : 'false',
            'aria-label': '峰谷执行',
            title,
            disabled: locked,
            onClick: toggle,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            onFocus: (event) => {
              let visible = true
              try { visible = event.target.matches(':focus-visible') } catch { /* older engines: keep the ring */ }
              setFocused(visible)
            },
            onBlur: () => setFocused(false),
            style: buttonStyle,
          },
          h('span', { style: { ...S.label, color: labelColor } }, coverageIncomplete ? '峰谷执行*' : '峰谷执行'),
          h('span', { 'aria-hidden': 'true', style: trackStyle }, h('span', { style: thumbStyle })),
        ),
      )
    }

    const plugin = {
      inject: ['slots', 'remote'],
      apply(ctx) {
        const findScheduledTaskFace = (sessionId, sentText) => findScheduledTask(ctx.remote, sessionId, sentText)
        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
          name: 'conversation.input.activity',
          inject: () => ({ findScheduledTask: findScheduledTaskFace }),
        }, PeakValleyExecution))
      },
    }
    // Test-only face: the unit tests compare this bundle's private copies
    // (time arithmetic, holiday fallback, calendar payload parser, marker)
    // with the Host half's modules.
    if (window.__PEAK_VALLEY_TEST__ === true) {
      plugin.__test = {
        MARKER,
        TIME_ZONE,
        PEAK_WINDOWS,
        HOLIDAY_FALLBACK_RANGES,
        CALENDAR_ROUTE,
        expandRanges,
        fallbackCalendar,
        parseCalendarPayload,
        isPeakTime,
        isValleyTime,
        nextValleyStart,
        formatValleyStart,
        Component: PeakValleyExecution,
      }
    }
    return plugin
  },
})
