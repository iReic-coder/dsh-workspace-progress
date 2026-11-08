import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aggregateStates } from '../lib/aggregate.js'
import { estimateTokens } from '../lib/policy.js'
import { renderInjection, renderProgress, renderSummary } from '../lib/render.js'
import { applyFact, createSessionState } from '../lib/state.js'
import { readJson, sleep, withFileLock, writeJson } from '../lib/store.js'

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

test('a 100-turn replay stays inside the summary and injection budgets', () => {
  const sessions = []
  for (let s = 0; s < 20; s += 1) {
    const state = createSessionState({ id: `session-${String(s).padStart(8, '0')}-0000-4000-8000-000000000000`, cwd: '/tmp/project', root: '/tmp/project', name: 'project' })
    for (let turn = 1; turn <= 5; turn += 1) {
      applyFact(state, { type: 'user', text: `任务 ${s}-${turn}：实现一个很长的功能描述，包含多个步骤与验收要求`, at: Date.now() })
      applyFact(state, { type: 'file', path: `src/module-${s}-${turn}.js`, tool: 'edit', op: 'edit', ok: true, at: Date.now(), seq: turn * 10 })
      applyFact(state, { type: 'test', key: `test:npm test -- ${s}-${turn}`, command: `npm test -- --suite ${s}-${turn}`, ok: turn % 4 !== 0, exitCode: turn % 4 !== 0 ? 0 : 1, at: Date.now(), seq: turn * 10 + 1 })
      applyFact(state, { type: 'todo', key: `todo:${s}-${turn}`, content: `子任务 ${s}-${turn}：完成数据校验、错误处理与回归测试，并记录结论`, status: turn % 3 === 0 ? 'completed' : turn % 3 === 1 ? 'in_progress' : 'pending', at: Date.now() })
      applyFact(state, { type: 'turn', turn, status: 'completed', calls: 8, failures: 1, edits: 2, tests: 1, passed: turn % 4 === 0 ? 0 : 1, at: Date.now(), seq: turn * 10 + 2 })
    }
    sessions.push(state)
  }
  const aggregate = aggregateStates(sessions, { root: '/tmp/project', name: 'project' })
  const summary = renderSummary(aggregate, { maxTokens: 700 })
  const injection = renderInjection(aggregate, summary, { maxTokens: 800 })
  const progress = renderProgress(aggregate)

  assert.ok(estimateTokens(summary) <= 700, `summary=${estimateTokens(summary)}`)
  assert.ok(estimateTokens(injection) <= 800, `injection=${estimateTokens(injection)}`)
  assert.match(injection, /progress\.md/)
  assert.ok(progress.length > summary.length)
  assert.equal(aggregate.sessions.length, 20)
})

test('file locking loses no concurrent updates', async () => {
  const dir = tempDir('wp-lock-')
  const file = path.join(dir, 'counter.json')
  const lock = path.join(dir, '.lock')
  await writeJson(file, { n: 0 })
  const workers = Array.from({ length: 12 }, () =>
    withFileLock(lock, async () => {
      const current = await readJson(file, { n: 0 })
      await sleep(Math.floor(Math.random() * 8))
      await writeJson(file, { n: current.n + 1 })
    }),
  )
  await Promise.all(workers)
  const final = await readJson(file, { n: -1 })
  assert.equal(final.n, 12)
})

test('atomic writes survive a stale lock from a dead process', async () => {
  const dir = tempDir('wp-stale-')
  const lock = path.join(dir, '.lock')
  const { mkdirSync, writeFileSync, utimesSync } = await import('node:fs')
  mkdirSync(lock)
  writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, at: Date.now() - 60000 }))
  const old = new Date(Date.now() - 60000)
  utimesSync(lock, old, old)
  let ran = false
  await withFileLock(lock, async () => {
    ran = true
  }, { timeoutMs: 2000 })
  assert.equal(ran, true)
})