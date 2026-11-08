import assert from 'node:assert/strict'
import test from 'node:test'

import { factsFromToolResult } from '../lib/evidence.js'

const config = { redactSecrets: true }

function resultEvent({ callId, exitCode, text, isError = false }) {
  return {
    type: 'tool/result',
    seq: 10,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: callId,
        isError,
        source: { kind: 'tool', callId },
        content: text === undefined ? [] : [{ type: 'text', text }],
      },
      ...(exitCode === undefined ? {} : { meta: { exitCode } }),
    },
  }
}

function testFacts(pending, event) {
  return factsFromToolResult(pending, event, config).filter((fact) => fact.type === 'test')
}

test('a test command with a passing exit code is verified', () => {
  const pending = { callId: 'c1', name: 'pwsh', args: { command: 'node --test test/' }, turn: 1, step: 1 }
  const [fact] = testFacts(pending, resultEvent({ callId: 'c1', exitCode: 0, text: 'pass' }))
  assert.equal(fact.ok, true)
})

test('a failing exit code is recorded as failed', () => {
  const pending = { callId: 'c2', name: 'pwsh', args: { command: 'pytest' }, turn: 1, step: 1 }
  const [fact] = testFacts(pending, resultEvent({ callId: 'c2', exitCode: 1, text: '1 failed' }))
  assert.equal(fact.ok, false)
  assert.equal(fact.exitCode, 1)
})

test('an unsuccessful shell that never ran the command is not a pass', () => {
  const pending = { callId: 'c3', name: 'pwsh', args: { command: 'npm test; "EXIT=$LASTEXITCODE"' }, turn: 1, step: 1 }
  const [fact] = testFacts(pending, resultEvent({ callId: 'c3', text: 'npm : CommandNotFoundException ... EXIT=' }))
  assert.equal(fact.ok, false)
})

test('EXIT=n markers are parsed as exit codes', () => {
  const pending = { callId: 'c4', name: 'pwsh', args: { command: 'npm test; "EXIT=$LASTEXITCODE"' }, turn: 1, step: 1 }
  const [fact] = testFacts(pending, resultEvent({ callId: 'c4', text: 'failed\nEXIT=1' }))
  assert.equal(fact.exitCode, 1)
  assert.equal(fact.ok, false)
})

test('file writes are recorded without any file content', () => {
  const pending = { callId: 'c5', name: 'write', args: { file_path: 'src/a.js', content: 'const secret = "sk-abcdef123456"' }, turn: 1, step: 1 }
  const facts = factsFromToolResult(pending, resultEvent({ callId: 'c5', text: 'ok' }), config)
  const file = facts.find((fact) => fact.type === 'file')
  assert.equal(file.path, 'src/a.js')
  assert.ok(!JSON.stringify(facts).includes('const secret'))
  assert.ok(!JSON.stringify(facts).includes('sk-abcdef'))
})