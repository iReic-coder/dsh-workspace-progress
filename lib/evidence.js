/**
 * Evidence extraction: turn raw DSH session events into small, attributable
 * facts. Assistant prose is never treated as proof; only observable effects
 * (tool calls, tool results, test exit codes, todo mutations) become facts.
 */
import { classifyTool, isTestCommand, sanitizeCommand, sanitizeText } from './policy.js'

/** Decode a tool-call argument blob without trusting its shape. */
export function decodeToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return { _raw: raw }
  }
}

/** Build the in-memory record for a `tool/call` event. */
export function buildPendingCall(event) {
  const data = event?.data ?? {}
  const args = decodeToolArguments(data.arguments)
  return {
    callId: String(data.callId ?? ''),
    name: String(data.name ?? ''),
    args,
    turn: Number(data.turn ?? 0),
    step: Number(data.step ?? 0),
    at: Number(event?.time ?? Date.now()),
    seq: Number(event?.seq ?? 0),
  }
}

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'blocked'])

/** Normalize a todo status; unknown values are treated as pending, never done. */
export function normalizeTodoStatus(status) {
  const value = String(status ?? '').toLowerCase()
  return TODO_STATUS.has(value) ? value : 'pending'
}

function textBlocks(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Pull an exit code from a tool result's meta or captured output. */
export function parseExitCode(message, meta) {
  const metaRecord = meta && typeof meta === 'object' ? meta : {}
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    const value = metaRecord[key]
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  }
  const text = textBlocks(message)
  const match = /\[exit code:\s*(-?\d+)\]/i.exec(text) ?? /\bEXIT=(-?\d+)\b/i.exec(text)
  if (match) return Number(match[1])
  return undefined
}

/** Shell output that proves the command never ran, regardless of tool status. */
const OUTPUT_FAILURE = /(CommandNotFoundException|is not recognized as the name|is not recognized as an alias|command not found|不是内部或外部命令|找不到命令|cannot find the path specified)/i

export function outputIndicatesFailure(text) {
  return typeof text === 'string' && OUTPUT_FAILURE.test(text)
}

/**
 * Convert a matched call/result pair into facts.
 *
 * @param {object} pending - output of {@link buildPendingCall}.
 * @param {object} event - the `tool/result` session event.
 * @param {object} config - resolved plugin configuration.
 */
export function factsFromToolResult(pending, event, config) {
  if (!pending) return []
  const data = event?.data ?? {}
  const message = data.message ?? {}
  const classified = classifyTool(pending.name, pending.args)
  const output = textBlocks(message)
  const failed =
    Boolean(data.error) ||
    message.isError === true ||
    (classified.kind === 'shell' && outputIndicatesFailure(output))
  const exitCode = parseExitCode(message, data.meta)
  const at = Number(event?.time ?? Date.now())
  const turn = Number(data.turn ?? pending.turn ?? 0)
  const facts = []

  if (classified.path) {
    const filePath = sanitizePath(classified.path)
    if (filePath) {
      facts.push({
        type: 'file',
        key: `file:${filePath}`,
        path: filePath,
        tool: pending.name,
        op: classified.kind === 'write' ? 'write' : 'edit',
        ok: !failed,
        at,
        turn,
        seq: Number(event?.seq ?? 0),
      })
    }
  }

  if (classified.kind === 'shell') {
    const command = sanitizeCommand(classified.command, 200, config)
    const isTest = Boolean(classified.test)
    if (command) {
      facts.push({
        type: 'command',
        key: `cmd:${command}`,
        command,
        ok: !failed && (exitCode === undefined || exitCode === 0),
        exitCode,
        test: isTest,
        at,
        turn,
        seq: Number(event?.seq ?? 0),
      })
    }
    if (isTest) {
      facts.push({
        type: 'test',
        key: `test:${command}`,
        command,
        ok: !failed && (exitCode === undefined || exitCode === 0),
        exitCode,
        at,
        turn,
        seq: Number(event?.seq ?? 0),
      })
    }
  }

  if (classified.kind === 'todo' && Array.isArray(classified.todos)) {
    for (const todo of classified.todos) {
      if (!todo || typeof todo !== 'object') continue
      const content = sanitizeText(todo.content ?? todo.text ?? '', 160, config)
      if (!content) continue
      facts.push({
        type: 'todo',
        key: `todo:${content}`,
        content,
        status: normalizeTodoStatus(todo.status),
        at,
        turn,
        seq: Number(event?.seq ?? 0),
      })
    }
  }

  facts.push({
    type: 'tool',
    key: `tool:${pending.name}`,
    name: sanitizeText(pending.name, 60, config) || 'tool',
    ok: !failed,
    exitCode,
    at,
    turn,
    seq: Number(event?.seq ?? 0),
  })

  return facts
}

function sanitizePath(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > 260 ? text.slice(0, 259) + '…' : text
}

/** Extract the user's task statement (first prompt only) for a session goal. */
export function factFromUserMessage(event, config) {
  const data = event?.data ?? {}
  const message = data
  const source = message?.source
  if (source && typeof source.kind === 'string' && source.kind !== 'user') return null
  const raw = textBlocks(message)
  if (!raw.trim()) return null
  // Keep only the first meaningful line: a pasted brief is not a goal statement.
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^[\s#>*_`+\-]+/, '').replace(/[\s#*_`]+$/, '').trim())
      .find((line) => line.length > 0) ?? raw
  const text = sanitizeText(firstLine, 140, config)
  if (!text) return null
  return {
    type: 'user',
    key: 'user:goal',
    text,
    at: Number(event?.time ?? Date.now()),
    seq: Number(event?.seq ?? 0),
    turn: Number(data?.turn ?? 0),
  }
}

/** Whether a raw assistant message merely *claims* something happened. */
export function assistantClaimSummary(event, config) {
  const message = event?.data?.message
  const text = textBlocks(message)
  if (!text.trim()) return null
  const claim = /(?:已|已经|完成|修复|通过|verified|fixed|done|passed|completed)/i.test(text)
  if (!claim) return null
  return {
    text: sanitizeText(text, 160, config),
    at: Number(event?.time ?? Date.now()),
  }
}

/** Classify a turn-end reason into an honest status word. */
export function turnStatus(reason) {
  const kind = reason?.kind ?? 'completed'
  if (kind === 'completed') return 'completed'
  if (kind === 'aborted' || kind === 'interrupted') return 'aborted'
  if (kind === 'blocked') return 'blocked'
  if (kind === 'error') return 'error'
  if (kind === 'max-tokens') return 'max-tokens'
  if (kind === 'forked') return 'forked'
  return String(kind)
}

/** Convenience re-export used by the engine and tests. */
export { isTestCommand }