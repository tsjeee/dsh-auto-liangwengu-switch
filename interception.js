/**
 * 峰谷执行 —— pre-step interception core.
 *
 * Kept separate from the plugin entry so it can be unit-tested with an
 * explicit clock reading (`interceptAt(..., now)`).
 *
 * A prompt that carries the invisible marker is never executed immediately:
 * this module mounts it as one Host scheduled task that targets the Session
 * the user is actually in, due at the next off-peak opening (the end of the
 * current weekday peak window), and drops the claimed message from the step so
 * no model request happens now. When the Schedule service is unavailable, the
 * current instant is already off-peak, or the task cannot be created, the
 * message runs immediately instead — with the marker removed — so nothing the
 * user typed is lost.
 */
import {
  hasMarker,
  isValleyTime,
  nextValleyStart,
  stripMarkers,
} from './time.js'

/** Longest title the Schedule service accepts. */
const MAX_TITLE_LENGTH = 120

/** Title fallback when an instruction has no usable first line. */
const DEFAULT_TITLE = '峰谷执行任务'

/**
 * Defer marked prompts: create one scheduled task per marked message and keep
 * the step free of it.
 * @param {object} ctx Host plugin context.
 * @param {object} payload `agent/pre-step` payload.
 * @param {() => Promise<object>} next downstream step decision.
 * @param {number} [now] clock reading; defaults to `Date.now()`.
 * @returns {Promise<object>} the step decision.
 */
export async function interceptAt(ctx, payload, next, now = Date.now()) {
  const decision = await next()
  if (decision === null || decision === undefined || decision.kind !== 'enter') return decision
  const messages = Array.isArray(decision.messages) ? decision.messages : []
  if (!messages.some(carriesMarker)) return decision

  const schedule = ctx.get('schedule')
  const sessionId = sessionIdOf(payload)
  // Without the Schedule service, or already inside a valley window, the
  // message has nothing to wait for: run it now with the marker removed.
  if (schedule === undefined || sessionId === undefined || isValleyTime(now)) {
    return withoutMarkers(decision, messages)
  }

  const kept = []
  let deferred = 0
  for (const message of messages) {
    if (!carriesMarker(message)) {
      kept.push(message)
      continue
    }
    if (hasNonTextBlocks(message)) {
      // Attachments cannot ride a scheduled reminder; run them now.
      kept.push(stripMessage(message))
      continue
    }
    const instruction = stripMarkers(textOf(message)).trim()
    if (instruction === '') {
      // A marker-only message carries no task: drop it instead of admitting an
      // empty user message. The turn then closes without a model request.
      continue
    }
    try {
      const task = await schedule.create({
        title: taskTitle(instruction),
        prompt: instruction,
        timing: { kind: 'at', at: new Date(nextValleyStart(now)).toISOString() },
        target: { kind: 'session', sessionId },
      }, sessionId, payload.signal)
      deferred += 1
      log(ctx, `scheduled task ${String(task?.id)} for ${String(task?.scheduledAt)} (session ${sessionId})`)
    } catch (error) {
      // Never lose the user's instruction: if the task cannot be created the
      // message runs immediately instead, without the invisible marker.
      kept.push(stripMessage(message))
      log(ctx, `scheduling failed, running the message now: ${messageOf(error)}`)
    }
  }

  if (deferred === 0) return { ...decision, messages: kept }
  // Every claimed message was deferred and nothing else would drive a step:
  // reject so no model request runs. The turn closes as blocked, which Chat
  // renders without a failure row.
  if (!kept.some(isUserMessage)) return { kind: 'reject' }
  return { ...decision, messages: kept }
}

/**
 * Read the acting Session identity from one pre-step payload.
 * @param {{agent?: {session?: {id?: string, header?: {id?: string}}}}} payload pre-step payload.
 * @returns {string | undefined} Session identity.
 */
function sessionIdOf(payload) {
  const session = payload?.agent?.session
  return session?.id ?? session?.header?.id
}

/**
 * @param {unknown} message one claimed message candidate.
 * @returns {boolean} whether it is a user-authored message carrying the marker.
 */
function carriesMarker(message) {
  return isUserMessage(message) && hasMarker(textOf(message))
}

/**
 * @param {unknown} message one claimed message candidate.
 * @returns {boolean} whether it is an ordinary user prompt.
 */
function isUserMessage(message) {
  return typeof message === 'object' && message !== null
    && typeof message.source === 'object' && message.source !== null
    && message.source.kind === 'user'
}

/**
 * @param {unknown} message one claimed message.
 * @returns {readonly object[]} its content blocks.
 */
function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : []
}

/**
 * @param {unknown} message one claimed message.
 * @returns {string} the model-facing text of its text blocks.
 */
function textOf(message) {
  return blocksOf(message)
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * @param {unknown} message one claimed message.
 * @returns {boolean} whether it carries a block a reminder cannot reproduce.
 */
function hasNonTextBlocks(message) {
  return blocksOf(message).some(block => block === null || typeof block !== 'object' || block.type !== 'text')
}

/**
 * Rewrite one message with the invisible marker removed from its text blocks.
 * @param {unknown} message one claimed message.
 * @returns {object} the marker-free message.
 */
function stripMessage(message) {
  return {
    ...message,
    content: blocksOf(message).map((block) => {
      if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return block
      return { ...block, text: stripMarkers(block.text) }
    }),
  }
}

/**
 * Rewrite a decision so every message loses its marker while still running now.
 * @param {object} decision the entered decision.
 * @param {readonly unknown[]} messages its messages.
 * @returns {object} the marker-free decision.
 */
function withoutMarkers(decision, messages) {
  return { ...decision, messages: messages.map(message => (carriesMarker(message) ? stripMessage(message) : message)) }
}

/**
 * Build a short, human-readable title for the scheduled task.
 * @param {string} instruction the trimmed instruction.
 * @returns {string} a non-empty title of at most the service limit.
 */
function taskTitle(instruction) {
  const firstLine = instruction
    .split(/\r?\n/u)
    .map(line => line.replace(/^[#>\s]+/u, '').trim())
    .find(line => line.length > 0)
  const base = firstLine === undefined || firstLine === '' ? DEFAULT_TITLE : firstLine
  if (base.length <= 42) return base.slice(0, MAX_TITLE_LENGTH)
  return `${base.slice(0, 42)}…`
}

/**
 * Log through the Host logger when the deployment supplies one.
 * @param {object} ctx Host context.
 * @param {string} message log body.
 */
function log(ctx, message) {
  try {
    ctx.logger?.info?.(`peak-valley-execution: ${message}`)
  } catch {
    /* Logging must never break interception. */
  }
}

/**
 * @param {unknown} error thrown failure.
 * @returns {string} a readable message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
