import assert from 'node:assert/strict'
import test from 'node:test'

import {
  estimateTokens,
  isTestCommand,
  redact,
  resolveConfig,
  sanitizeCommand,
  sanitizeText,
} from '../lib/policy.js'

test('redacts obvious credentials', () => {
  const samples = [
    'export DASHSCOPE_API_KEY=sk-abcdef1234567890',
    'Authorization: Bearer abcdefghijklmnop',
    'password = "hunter2"',
    '--token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'email me at someone@example.com',
  ]
  for (const sample of samples) {
    const result = redact(sample)
    assert.ok(!result.includes('sk-abcdef'), result)
    assert.ok(!result.includes('abcdefghijklmnop'), result)
    assert.ok(!result.includes('hunter2'), result)
    assert.ok(!result.includes('someone@example.com'), result)
  }
})

test('sanitizeText bounds length and collapses newlines', () => {
  const result = sanitizeText('line one\nline two\n' + 'x'.repeat(500), 80)
  assert.ok(result.length <= 80)
  assert.ok(!result.includes('\n'))
})

test('sanitizeCommand masks inline tokens', () => {
  const command = sanitizeCommand('curl -H "Authorization: Bearer abcdefghijklmnop" https://x.test')
  assert.ok(!command.includes('abcdefghijklmnop'))
})

test('recognizes common test commands', () => {
  for (const command of [
    'npm test',
    'pnpm run test',
    'python -m pytest -q',
    'pytest tests/',
    'node --test test/',
    'cargo test',
    'go test ./...',
    'matlab -batch "runtests"',
  ]) {
    assert.equal(isTestCommand(command), true, command)
  }
  for (const command of ['ls -la', 'npm run build', 'git status', 'matlab -batch "disp(1)"']) {
    assert.equal(isTestCommand(command), false, command)
  }
})

test('token estimate is conservative for Chinese text', () => {
  const text = '这是一段中文进度摘要，用来估算 token 数量。'
  assert.ok(estimateTokens(text) >= 15)
  assert.ok(estimateTokens('hello world') < 10)
})

test('config resolution rejects bad values', () => {
  const config = resolveConfig({ summaryMaxTokens: 999999, injectionMode: 'bogus', scope: 'nope', enabled: 'yes' })
  assert.equal(config.summaryMaxTokens, 4000)
  assert.equal(config.injectionMode, 'once')
  assert.equal(config.scope, 'repository')
  assert.equal(config.enabled, true)
})