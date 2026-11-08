/**
 * Configuration defaults, secret redaction, token budgeting and tool
 * classification. Everything here is deterministic and offline: Strict mode
 * never calls a model.
 */
import { createHash } from 'node:crypto'

export const PLUGIN_NAME = 'dsh-workspace-progress'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  inject: true,
  /** 'once' injects at the first step of a session; 'every-turn' refreshes each turn; 'off' disables. */
  injectionMode: 'once',
  summaryMaxTokens: 700,
  injectMaxTokens: 800,
  idleDebounceMs: 5000,
  /** 'repository' shares one progress file across a repo and its worktrees. */
  scope: 'repository',
  captureUserPrompt: true,
  captureAssistantClaims: false,
  redactSecrets: true,
  maxSessionsInSummary: 6,
  maxSessionDetails: 10,
  maxSessionAgeDays: 45,
  retainSessionDays: 30,
  archiveAfterDays: 90,
  maxEventsPerSession: 4000,
})

export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG }
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (typeof fallback === 'number') {
      const number = Number(value)
      if (Number.isFinite(number) && number >= 0) config[key] = number
    } else if (typeof fallback === 'boolean') {
      config[key] = Boolean(value)
    } else {
      config[key] = String(value)
    }
  }
  if (!['once', 'every-turn', 'off'].includes(config.injectionMode)) {
    config.injectionMode = DEFAULT_CONFIG.injectionMode
  }
  if (!['repository', 'worktree', 'directory'].includes(config.scope)) {
    config.scope = DEFAULT_CONFIG.scope
  }
  config.summaryMaxTokens = clamp(config.summaryMaxTokens, 200, 4000)
  config.injectMaxTokens = clamp(config.injectMaxTokens, 100, 4000)
  return config
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1***'],
  [
    /((?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd|authorization|credential)s?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;&|,]+)/gi,
    '$1***',
  ],
  [/(--(?:api-key|token|password|secret|key)[= ])(\S+)/gi, '$1***'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (match) => (match.endsWith('@users.noreply.github.com') ? match : '***@***')],
]

/** Remove credentials and personal identifiers from any text that leaves memory. */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  let value = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    value = value.replace(pattern, replacement)
  }
  return value
}

/** Single-line, bounded, redacted text suitable for a shared file. */
export function sanitizeText(text, maxLength = 240, { redactSecrets = true } = {}) {
  if (typeof text !== 'string') return ''
  let value = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  value = value.replace(/\s+/g, ' ').trim()
  if (redactSecrets) value = redact(value)
  if (value.length > maxLength) value = value.slice(0, maxLength - 1).trimEnd() + '…'
  return value
}

/** A shell command line with secrets masked and output removed. */
export function sanitizeCommand(command, maxLength = 200, { redactSecrets = true } = {}) {
  return sanitizeText(String(command || ''), maxLength, { redactSecrets })
}

/** Conservative token estimate: CJK near 1 token/char, other text near 1/3.6. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk * 1.05 + other / 3.6)
}

/** Cut text so its estimate stays within `maxTokens`, appending an ellipsis. */
export function clampToTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, middle)) <= maxTokens - 1) low = middle
    else high = middle - 1
  }
  return text.slice(0, low).trimEnd() + '…'
}

export function hashKey(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12)
}

const TEST_COMMAND_PATTERNS = [
  /\b(?:pytest|py\.test)\b/i,
  /\bpython[0-9.]*\s+-m\s+(?:pytest|unittest)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\b(?:vitest|jest|mocha|ava|tap)\b/i,
  /\bnode(?:\.exe)?["']?\s+--test\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bdotnet\s+test\b/i,
  /\bmvn\b[^\n]*\btest\b/i,
  /\bgradle\b[^\n]*\btest\b/i,
  /\bctest\b/i,
  /\bmake\s+test\b/i,
  /\bRscript\b[^\n]*\btest/i,
  /\bruntests\b/i,
  /\bmatlab\b[^\n]*\b(?:test|runtests)\b/i,
]

export function isTestCommand(command) {
  const text = String(command || '')
  if (!text) return false
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(text))
}

const TEST_TOOL_PATTERN = /test/i

export function isTestToolName(name) {
  return TEST_TOOL_PATTERN.test(String(name || ''))
}

/**
 * Classify a tool call into the facts this plugin records. File contents and
 * raw tool output are never retained.
 *
 * @param {string} name - tool name.
 * @param {unknown} parsedArgs - JSON-decoded arguments, when available.
 */
export function classifyTool(name, parsedArgs) {
  const tool = String(name || '')
  const args = parsedArgs && typeof parsedArgs === 'object' ? parsedArgs : {}
  const lower = tool.toLowerCase()

  if (/^(?:write|edit|str_replace_editor|notebook_edit|apply_patch|multiedit)$/.test(lower)) {
    const filePath =
      firstString(args.file_path, args.path, args.notebook_path, args.target_file) ||
      (Array.isArray(args.edits) ? firstString(args.edits[0]?.file_path) : '')
    return { kind: lower === 'write' ? 'write' : 'edit', path: filePath || null }
  }
  if (/^(?:pwsh|bash|shell|sh|zsh|run_code|terminal)$/.test(lower)) {
    const command = firstString(args.command, args.cmd, args.script, args.code)
    return {
      kind: 'shell',
      command: command || null,
      test: isTestCommand(command),
    }
  }
  if (/todo/.test(lower)) {
    const todos = Array.isArray(args.todos) ? args.todos : null
    return { kind: 'todo', todos }
  }
  if (isTestToolName(tool) && /matlab|test/i.test(tool)) {
    return { kind: 'shell', command: `[tool] ${tool}`, test: true }
  }
  return { kind: 'other', name: tool }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/** Resolve the effective per-workspace switch file. */
export function mergeWorkspaceConfig(base, workspace) {
  if (!workspace || typeof workspace !== 'object') return base
  const merged = { ...base }
  if (typeof workspace.enabled === 'boolean') merged.enabled = merged.enabled && workspace.enabled
  if (typeof workspace.inject === 'boolean') merged.inject = merged.inject && workspace.inject
  if (typeof workspace.summaryMaxTokens === 'number' && workspace.summaryMaxTokens >= 200) {
    merged.summaryMaxTokens = clamp(workspace.summaryMaxTokens, 200, 4000)
  }
  if (['once', 'every-turn', 'off'].includes(workspace.injectionMode)) {
    merged.injectionMode = workspace.injectionMode
  }
  return merged
}