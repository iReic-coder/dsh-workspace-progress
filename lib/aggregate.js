/**
 * Workspace aggregation: derive one workspace-level view from per-session
 * states. This is a pure function so it can be tested without DSH.
 */
import { isActiveSession, sessionAgeDays } from './state.js'
import { testLabel } from './evidence.js'

export function formatTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortId(id) {
  const text = String(id || '')
  return text.startsWith('session-') ? text.slice(0, 16) : text.slice(0, 12)
}

function latestTurn(state) {
  return state.turns?.length ? state.turns[state.turns.length - 1] : null
}

/**
 * @param {Array<object>} states - per-session states.
 * @param {{root: string, name: string, maxAgeDays?: number}} workspace
 */
export function aggregateStates(states, workspace, options = {}) {
  const now = Date.now()
  const maxAgeDays = options.maxAgeDays ?? 45
  const sessions = (states || [])
    .filter((state) => state && state.id)
    .filter((state) => sessionAgeDays(state, now) <= maxAgeDays)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  const active = sessions.filter((state) => isActiveSession(state, now))
  const totals = {
    sessions: sessions.length,
    active: active.length,
    toolCalls: 0,
    toolFailures: 0,
    edits: 0,
    tests: 0,
    testsPassed: 0,
  }

  const verified = []
  const verifiedByLabel = new Map()
  const claimedDone = []
  const inProgress = []
  const nextSteps = []
  const blockers = []
  const decisions = []
  const claims = []
  const files = new Map()

  for (const state of sessions) {
    totals.toolCalls += state.counts?.toolCalls ?? 0
    totals.toolFailures += state.counts?.toolFailures ?? 0
    totals.edits += (state.counts?.edits ?? 0) + (state.counts?.writes ?? 0)
    totals.tests += state.counts?.tests ?? 0
    totals.testsPassed += state.counts?.testsPassed ?? 0

    for (const test of Object.values(state.tests ?? {})) {
      const label = test.label || testLabel(test.command)
      if (test.ok) {
        const key = `${state.id}|${label}`
        const existing = verifiedByLabel.get(key)
        if (existing) {
          existing.count += 1
          existing.at = Math.max(existing.at, test.at)
        } else {
          verifiedByLabel.set(key, {
            sessionId: state.id,
            label: `测试通过：\`${label}\``,
            detail: test.exitCode === 0 || test.exitCode === null ? '' : `exit ${test.exitCode}`,
            at: test.at,
            count: 1,
            incomplete: String(test.command).endsWith('…'),
          })
        }
      } else {
        blockers.push({
          sessionId: state.id,
          label: `测试失败：\`${label}\`${test.exitCode === undefined || test.exitCode === null ? '' : `（exit ${test.exitCode}）`}`,
          at: test.at,
        })
      }
    }

    for (const todo of Object.values(state.todos ?? {})) {
      const item = { sessionId: state.id, text: todo.content, at: todo.at }
      if (todo.status === 'completed') claimedDone.push(item)
      else if (todo.status === 'in_progress') inProgress.push(item)
      else if (todo.status === 'blocked') blockers.push({ ...item, label: `任务阻塞：${todo.content}` })
      else if (todo.status === 'cancelled') continue
      else nextSteps.push(item)
    }

    for (const note of state.notes ?? []) {
      decisions.push({ sessionId: state.id, text: note.text, at: note.at })
    }
    for (const claim of state.claims ?? []) {
      claims.push({ sessionId: state.id, text: claim.text, at: claim.at })
    }
    for (const file of Object.values(state.files ?? {})) {
      const entry = files.get(file.path) ?? { path: file.path, sessions: new Set(), lastAt: 0, ops: 0, ok: true, op: 'edit' }
      entry.sessions.add(state.id)
      entry.lastAt = Math.max(entry.lastAt, file.lastAt ?? 0)
      entry.ops += file.ops ?? 1
      entry.ok = entry.ok && file.ok !== false
      if ((file.lastAt ?? 0) >= entry.lastAt) entry.op = file.op ?? entry.op
      files.set(file.path, entry)
    }
  }

  const byTimeDesc = (a, b) => (b.at ?? 0) - (a.at ?? 0)
  const dedupe = (items) => {
    const seen = new Set()
    return items.filter((item) => {
      const key = `${item.sessionId}|${item.text ?? item.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const lastTurn = sessions
    .map((state) => ({ state, turn: latestTurn(state) }))
    .filter((entry) => entry.turn)
    .sort((a, b) => (b.turn.at ?? 0) - (a.turn.at ?? 0))[0]

  // Keep the verified list diverse: at most two entries per session.
  const perSessionLimit = options.maxVerifiedPerSession ?? 2
  const perSession = new Map()
  for (const item of [...verifiedByLabel.values()].sort(byTimeDesc)) {
    const count = perSession.get(item.sessionId) ?? 0
    if (count >= perSessionLimit) continue
    perSession.set(item.sessionId, count + 1)
    verified.push(item)
  }

  return {
    workspace: {
      root: workspace?.root ?? '',
      name: workspace?.name || 'workspace',
    },
    updatedAt: now,
    sessions,
    active,
    totals,
    verified: verified.sort(byTimeDesc).slice(0, 12),
    claimedDone: dedupe(claimedDone).sort(byTimeDesc).slice(0, 12),
    inProgress: dedupe(inProgress).sort(byTimeDesc).slice(0, 10),
    nextSteps: dedupe(nextSteps).sort(byTimeDesc).slice(0, 10),
    blockers: dedupe(blockers).sort(byTimeDesc).slice(0, 10),
    decisions: dedupe(decisions).sort(byTimeDesc).slice(0, 10),
    claims: dedupe(claims).sort(byTimeDesc).slice(0, 6),
    files: [...files.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 12),
    lastTurn,
    hasOtherSessions: sessions.length > 1,
  }
}

export { shortId }