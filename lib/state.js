/**
 * Per-session state: the latest known truth for one Session, keyed so repeated
 * facts replace rather than accumulate.
 */

export const STATE_VERSION = 1

const MAX_FILES = 400
const MAX_COMMANDS = 150
const MAX_TESTS = 80
const MAX_TODOS = 250
const MAX_TURNS = 40
const MAX_NOTES = 30
const MAX_CLAIMS = 5

export function createSessionState(meta) {
  const now = Date.now()
  return {
    v: STATE_VERSION,
    id: meta.id,
    cwd: meta.cwd ?? null,
    root: meta.root ?? null,
    name: meta.name ?? null,
    branch: meta.branch ?? null,
    worktree: meta.worktree ?? null,
    createdAt: meta.createdAt ?? now,
    updatedAt: now,
    lastSeq: meta.lastSeq ?? 0,
    status: 'live',
    goal: null,
    title: meta.title ?? null,
    counts: {
      turns: 0,
      toolCalls: 0,
      toolFailures: 0,
      edits: 0,
      writes: 0,
      tests: 0,
      testsPassed: 0,
      commands: 0,
    },
    files: {},
    tests: {},
    commands: {},
    tools: {},
    todos: {},
    turns: [],
    notes: [],
    claims: [],
    injection: null,
    lastTurnAt: null,
  }
}

function bump(state, key, amount = 1) {
  state.counts[key] = (state.counts[key] ?? 0) + amount
}

function pruneObject(object, max, compare) {
  const keys = Object.keys(object)
  if (keys.length <= max) return
  keys.sort(compare)
  for (const key of keys.slice(0, keys.length - max)) delete object[key]
}

function pruneArray(array, max) {
  if (array.length > max) array.splice(0, array.length - max)
}

/** Apply one fact in place. Later facts with the same key replace earlier ones. */
export function applyFact(state, fact) {
  if (!state || !fact || typeof fact !== 'object') return
  const at = Number(fact.at ?? Date.now())
  state.updatedAt = Math.max(state.updatedAt ?? 0, at)
  if (Number.isFinite(fact.seq)) state.lastSeq = Math.max(state.lastSeq ?? 0, fact.seq)

  switch (fact.type) {
    case 'user': {
      if (!state.goal) state.goal = fact.text
      return
    }
    case 'file': {
      const existing = state.files[fact.path]
      if (existing) {
        existing.ops = (existing.ops ?? 1) + 1
        existing.tool = fact.tool
        existing.op = fact.op
        existing.ok = fact.ok
        existing.lastAt = at
        existing.turn = fact.turn
      } else {
        state.files[fact.path] = {
          path: fact.path,
          tool: fact.tool,
          op: fact.op,
          ops: 1,
          ok: fact.ok,
          firstAt: at,
          lastAt: at,
          turn: fact.turn,
        }
      }
      bump(state, fact.ok ? (fact.op === 'write' ? 'writes' : 'edits') : 'toolFailures')
      pruneObject(state.files, MAX_FILES, (a, b) => (state.files[a].lastAt ?? 0) - (state.files[b].lastAt ?? 0))
      return
    }
    case 'test': {
      const existing = state.tests[fact.key]
      state.tests[fact.key] = {
        command: fact.command,
        ok: fact.ok,
        exitCode: fact.exitCode ?? null,
        at,
        turn: fact.turn,
        runs: (existing?.runs ?? 0) + 1,
      }
      bump(state, 'tests')
      if (existing?.ok && !fact.ok) state.counts.testsPassed = Math.max(0, state.counts.testsPassed - 1)
      if (fact.ok) bump(state, 'testsPassed')
      pruneObject(state.tests, MAX_TESTS, (a, b) => (state.tests[a].at ?? 0) - (state.tests[b].at ?? 0))
      return
    }
    case 'command': {
      state.commands[fact.key] = {
        command: fact.command,
        ok: fact.ok,
        exitCode: fact.exitCode ?? null,
        at,
        turn: fact.turn,
      }
      bump(state, 'commands')
      pruneObject(state.commands, MAX_COMMANDS, (a, b) => (state.commands[a].at ?? 0) - (state.commands[b].at ?? 0))
      return
    }
    case 'tool': {
      const entry = state.tools[fact.name] ?? { calls: 0, failures: 0, lastAt: 0 }
      entry.calls += 1
      if (!fact.ok) entry.failures += 1
      entry.lastAt = at
      state.tools[fact.name] = entry
      bump(state, 'toolCalls')
      if (!fact.ok) bump(state, 'toolFailures')
      return
    }
    case 'todo': {
      state.todos[fact.key] = { content: fact.content, status: fact.status, at, turn: fact.turn }
      pruneObject(state.todos, MAX_TODOS, (a, b) => (state.todos[a].at ?? 0) - (state.todos[b].at ?? 0))
      return
    }
    case 'claim': {
      state.claims.push({ text: fact.text, at })
      pruneArray(state.claims, MAX_CLAIMS)
      return
    }
    case 'note': {
      state.notes.push({ text: fact.text, at })
      pruneArray(state.notes, MAX_NOTES)
      return
    }
    case 'turn': {
      state.turns.push({
        turn: fact.turn,
        at,
        status: fact.status,
        calls: fact.calls ?? 0,
        failures: fact.failures ?? 0,
        edits: fact.edits ?? 0,
        tests: fact.tests ?? 0,
        passed: fact.passed ?? 0,
      })
      pruneArray(state.turns, MAX_TURNS)
      state.counts.turns = Math.max(state.counts.turns ?? 0, state.turns.length)
      state.lastTurnAt = at
      return
    }
    default:
      return
  }
}

/** Mark a session as live/ended without touching its evidence. */
export function markStatus(state, status, at = Date.now()) {
  state.status = status
  state.updatedAt = Math.max(state.updatedAt ?? 0, at)
}

export function markInjected(state, at = Date.now(), seq = 0, turn = 0) {
  state.injection = { at, seq, turn }
  state.updatedAt = Math.max(state.updatedAt ?? 0, at)
}

export function sessionAgeDays(state, now = Date.now()) {
  return (now - (state.updatedAt ?? 0)) / 86400000
}

export function isActiveSession(state, now = Date.now()) {
  return state.status !== 'ended' && now - (state.updatedAt ?? 0) < 24 * 3600 * 1000
}

/** Facts that are safe to re-apply after a crash: ordered by seq. */
export function sortBySeq(facts) {
  return [...facts].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

export function normalizeSessionState(raw, meta) {
  if (!raw || typeof raw !== 'object' || raw.v !== STATE_VERSION) return createSessionState(meta)
  const state = { ...createSessionState(meta), ...raw }
  state.counts = { ...createSessionState(meta).counts, ...(raw.counts ?? {}) }
  state.files = raw.files ?? {}
  state.tests = raw.tests ?? {}
  state.commands = raw.commands ?? {}
  state.tools = raw.tools ?? {}
  state.todos = raw.todos ?? {}
  state.turns = Array.isArray(raw.turns) ? raw.turns : []
  state.notes = Array.isArray(raw.notes) ? raw.notes : []
  state.claims = Array.isArray(raw.claims) ? raw.claims : []
  state.injection = raw.injection ?? null
  return state
}