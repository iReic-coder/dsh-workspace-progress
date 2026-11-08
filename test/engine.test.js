import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ProgressEngine } from '../index.js'
import { estimateTokens } from '../lib/policy.js'

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function makeCtx(sessions = []) {
  return {
    get(service) {
      if (service === 'sessions') return { list: () => sessions }
      if (service === 'workingDirectory') return { get: (session) => session.header.cwd }
      return undefined
    },
    logger: { warn() {} },
    on() {
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
}

function makeSession(id, cwd) {
  const session = {
    id,
    header: { id, cwd, createdAt: Date.now() },
    events: [],
    seq: 0,
    snapshotEvents(from) {
      return this.events.filter((event) => event.seq > from)
    },
  }
  return session
}

function commit(session, type, data) {
  const event = { type, seq: session.events.length + 1, time: Date.now(), data }
  session.events.push(event)
  session.seq = session.events.length
  return event
}

async function drain(engine, session, action) {
  action()
  await engine.chains.get(session.id)
}

const SESSION_A = 'session-aaaaaaaa-1111-4111-8111-111111111111'
const SESSION_B = 'session-bbbbbbbb-2222-4222-8222-222222222222'

test('session A work is persisted and injected into session B exactly once', async () => {
  const dir = tempDir('wp-engine-')
  const sessionA = makeSession(SESSION_A, dir)
  const engine = new ProgressEngine(makeCtx([sessionA]), { idleDebounceMs: 0, summaryMaxTokens: 700 })
  await engine.start()

  await drain(engine, sessionA, () => {
    engine.onSessionEvent(sessionA, commit(sessionA, 'user/message', { role: 'user', content: [{ type: 'text', text: '实现登录接口并跑测试' }], source: { kind: 'user' } }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'turn/start', { turn: 1 }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'src/login.js', content: 'secret=1' }) }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'Wrote src/login.js' }] },
    }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'tool/call', { turn: 1, step: 2, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'tool/result', {
      turn: 1,
      step: 2,
      meta: { exitCode: 0 },
      message: { role: 'tool', toolCallId: 'c2', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: '10 passing [exit code: 0]' }] },
    }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'tool/call', { turn: 1, step: 3, callId: 'c3', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '登录接口', status: 'completed' }, { content: '补单元测试', status: 'pending' }] }) }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'tool/result', {
      turn: 1,
      step: 3,
      message: { role: 'tool', toolCallId: 'c3', source: { kind: 'tool', callId: 'c3' }, content: [{ type: 'text', text: 'ok' }] },
    }))
    engine.onSessionEvent(sessionA, commit(sessionA, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  })

  const entryA = engine.entries.get(SESSION_A)
  assert.ok(entryA?.ws, 'session A has a workspace')
  const rendered = await engine.refreshWorkspace(entryA.ws)
  assert.match(rendered.progress, /已验证（有执行证据）/)
  assert.match(rendered.progress, /npm test/)
  assert.match(rendered.progress, /AI 声明完成/)
  assert.match(rendered.progress, /登录接口/)
  assert.match(rendered.progress, /src\/login\.js|src\\login\.js/)
  assert.ok(estimateTokens(rendered.summary) <= 700, 'summary fits the token budget')

  const sessionB = makeSession(SESSION_B, dir)
  const decision = await engine.preStep(
    { agent: { session: sessionB }, step: 1, turn: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.messages.length, 1, 'injected exactly one message')
  const injected = decision.messages[0].content.map((block) => block.text).join('\n')
  assert.match(injected, /workspace-progress/)
  assert.match(injected, /npm test/)
  assert.ok(estimateTokens(injected) <= 800, `injection is ${estimateTokens(injected)} tokens`)

  const second = await engine.preStep(
    { agent: { session: sessionB }, step: 1, turn: 2, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(second.messages.length, 0, 'no duplicate injection across turns')
})

test('a failing test is never summarized as verified progress', async () => {
  const dir = tempDir('wp-fail-')
  const session = makeSession('session-cccccccc-3333-4333-8333-333333333333', dir)
  const engine = new ProgressEngine(makeCtx([session]), { idleDebounceMs: 0 })
  await engine.start()

  await drain(engine, session, () => {
    engine.onSessionEvent(session, commit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: '修复解析 bug' }], source: { kind: 'user' } }))
    engine.onSessionEvent(session, commit(session, 'turn/start', { turn: 1 }))
    engine.onSessionEvent(session, commit(session, 'tool/call', { turn: 1, step: 1, callId: 't1', name: 'pwsh', arguments: JSON.stringify({ command: 'pytest tests/test_parse.py' }) }))
    engine.onSessionEvent(session, commit(session, 'tool/result', {
      turn: 1,
      step: 1,
      meta: { exitCode: 1 },
      message: { role: 'tool', toolCallId: 't1', isError: true, source: { kind: 'tool', callId: 't1' }, content: [{ type: 'text', text: '1 failed [exit code: 1]' }] },
    }))
    engine.onSessionEvent(session, commit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  })

  const entry = engine.entries.get(session.id)
  const rendered = await engine.refreshWorkspace(entry.ws)
  assert.match(rendered.progress, /测试失败/)
  assert.doesNotMatch(rendered.summary, /pytest tests\/test_parse\.py（/)
  const verifiedSection = rendered.summary.split('## 已验证')[1]?.split('##')[0] ?? ''
  assert.match(verifiedSection, /无/)
  assert.doesNotMatch(verifiedSection, /pytest/)
  const blockedSection = rendered.summary.split('## 阻塞')[1]?.split('##')[0] ?? ''
  assert.match(blockedSection, /pytest/)
})

test('repeated edits to one file stay a single deduplicated record', async () => {
  const dir = tempDir('wp-dedupe-')
  const session = makeSession('session-dddddddd-4444-4444-8444-444444444444', dir)
  const engine = new ProgressEngine(makeCtx([session]), { idleDebounceMs: 0 })
  await engine.start()

  await drain(engine, session, () => {
    for (let index = 1; index <= 3; index += 1) {
      engine.onSessionEvent(session, commit(session, 'tool/call', { turn: 1, step: index, callId: `e${index}`, name: 'edit', arguments: JSON.stringify({ file_path: 'src/app.js', old_string: 'a', new_string: 'b' }) }))
      engine.onSessionEvent(session, commit(session, 'tool/result', {
        turn: 1,
        step: index,
        message: { role: 'tool', toolCallId: `e${index}`, source: { kind: 'tool', callId: `e${index}` }, content: [{ type: 'text', text: 'ok' }] },
      }))
    }
    engine.onSessionEvent(session, commit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  })

  const entry = engine.entries.get(session.id)
  const rendered = await engine.refreshWorkspace(entry.ws)
  const rows = rendered.progress.split('\n').filter((line) => line.startsWith('| `src/app.js`'))
  assert.equal(rows.length, 1, 'one table row for the file')
  assert.match(rows[0], /×3/)
  assert.equal(entry.state.counts.edits, 3)
  assert.equal(Object.keys(entry.state.files).length, 1)
})

test('missed events are replayed after a restart without duplicating turns', async () => {
  const dir = tempDir('wp-recover-')
  const session = makeSession('session-eeeeeeee-5555-4555-8555-555555555555', dir)

  // Run once over the first two events only, then persist.
  commit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: '重启恢复测试' }], source: { kind: 'user' } })
  commit(session, 'turn/start', { turn: 1 })
  const first = new ProgressEngine(makeCtx([session]), { idleDebounceMs: 0 })
  await first.start()
  await drain(first, session, () => {
    first.onSessionEvent(session, session.events[0])
    first.onSessionEvent(session, session.events[1])
  })
  await first.flush(first.entries.get(session.id), true)

  // The log keeps growing while the plugin is down.
  commit(session, 'tool/call', { turn: 1, step: 1, callId: 'r1', name: 'pwsh', arguments: JSON.stringify({ command: 'node --test' }) })
  commit(session, 'tool/result', {
    turn: 1,
    step: 1,
    meta: { exitCode: 0 },
    message: { role: 'tool', toolCallId: 'r1', source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'text', text: 'pass [exit code: 0]' }] },
  })
  commit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  const second = new ProgressEngine(makeCtx([session]), { idleDebounceMs: 0 })
  await second.start()
  await second.chains.get(session.id)
  const entry = second.entries.get(session.id)
  await second.flush(entry, true)
  const rendered = await second.refreshWorkspace(entry.ws)
  assert.match(rendered.progress, /node --test/)
  assert.equal(entry.state.counts.turns, 1, 'turn recorded once')
  assert.equal(entry.state.tests['test:node --test'].ok, true)
})

test('a session that changes its working directory records later facts there', async () => {
  const first = tempDir('wp-cd-a-')
  const second = tempDir('wp-cd-b-')
  const session = makeSession('session-99999999-7777-4777-8777-777777777777', first)
  let current = first
  const ctx = makeCtx([session])
  ctx.get = (service) => {
    if (service === 'sessions') return { list: () => [session] }
    if (service === 'workingDirectory') return { get: () => current }
    return undefined
  }
  const engine = new ProgressEngine(ctx, { idleDebounceMs: 0 })
  await engine.start()

  await drain(engine, session, () => {
    engine.onSessionEvent(session, commit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: '切换工作区' }], source: { kind: 'user' } }))
    engine.onSessionEvent(session, commit(session, 'turn/start', { turn: 1 }))
    engine.onSessionEvent(session, commit(session, 'tool/call', { turn: 1, step: 1, callId: 'w1', name: 'working_directory', arguments: JSON.stringify({ cd: second }) }))
    engine.onSessionEvent(session, commit(session, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'w1', source: { kind: 'tool', callId: 'w1' }, content: [{ type: 'text', text: second }] },
    }))
  })
  current = second
  await drain(engine, session, () => {
    engine.onSessionEvent(session, commit(session, 'tool/call', { turn: 1, step: 2, callId: 'w2', name: 'write', arguments: JSON.stringify({ file_path: path.join(second, 'moved.txt'), content: 'x' }) }))
    engine.onSessionEvent(session, commit(session, 'tool/result', {
      turn: 1,
      step: 2,
      message: { role: 'tool', toolCallId: 'w2', source: { kind: 'tool', callId: 'w2' }, content: [{ type: 'text', text: 'ok' }] },
    }))
    engine.onSessionEvent(session, commit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  })

  const entry = engine.entries.get(session.id)
  assert.equal(path.resolve(entry.ws.root), path.resolve(second))
  const rendered = await engine.refreshWorkspace(entry.ws)
  assert.match(rendered.progress, /moved\.txt/)
  const secondDir = path.join(second, '.dsh', 'progress')
  const { readFile } = await import('node:fs/promises')
  const summary = await readFile(path.join(secondDir, 'summary.md'), 'utf8')
  assert.match(summary, /工作区进度摘要/)
})

test('the progress command reports status for the current workspace', async () => {
  const dir = tempDir('wp-cmd-')
  const session = makeSession('session-ffffffff-6666-4666-8666-666666666666', dir)
  const engine = new ProgressEngine(makeCtx([session]), { idleDebounceMs: 0 })
  await engine.start()

  await drain(engine, session, () => {
    engine.onSessionEvent(session, commit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: '命令测试' }], source: { kind: 'user' } }))
    engine.onSessionEvent(session, commit(session, 'turn/start', { turn: 1 }))
    engine.onSessionEvent(session, commit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  })
  await engine.refreshWorkspace(engine.entries.get(session.id).ws)

  const result = await engine.command({ agent: { session }, rawInput: 'status' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /工作区进度摘要/)

  const note = await engine.command({ agent: { session }, rawInput: 'note 采用 JSONL 存储' })
  assert.equal(note.kind, 'success')
  const refreshed = await engine.command({ agent: { session }, rawInput: 'refresh' })
  assert.match(refreshed.text, /工作区进度摘要/)
  const { readFile } = await import('node:fs/promises')
  const progressText = await readFile(path.join(dir, '.dsh', 'progress', 'progress.md'), 'utf8')
  assert.match(progressText, /JSONL/)
})