/**
 * Markdown views over one aggregated workspace state:
 * - progress.md: full, human-readable, evidence-labelled.
 * - summary.md: bounded low-token state for injection.
 */
import { clampToTokens, estimateTokens } from './policy.js'
import { formatTime, shortId } from './aggregate.js'

const STATUS_TEXT = { live: '活跃', idle: '空闲', ended: '已结束' }

function statusText(state) {
  return STATUS_TEXT[state.status] ?? state.status ?? '未知'
}

function push(line, value) {
  if (value === undefined || value === null || value === '') return
  line.push(String(value))
}

function truncateText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A goal is the first meaningful sentence, not the whole pasted brief. */
function shortGoal(value, max = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim()
  const heading = / #+\s/.exec(text)
  const cut = heading && heading.index > 12 ? text.slice(0, heading.index) : text
  return truncateText(cut, max)
}

function sessionTitle(state) {
  const goal = state.goal ? state.goal.slice(0, 60) : ''
  return goal ? `${shortId(state.id)}（${goal}）` : shortId(state.id)
}

function sessionEvidence(state) {
  const counts = state.counts ?? {}
  const parts = []
  if (counts.toolCalls) parts.push(`工具调用 ${counts.toolCalls}`)
  if (counts.toolFailures) parts.push(`失败 ${counts.toolFailures}`)
  if (counts.edits || counts.writes) parts.push(`修改文件 ${(counts.edits ?? 0) + (counts.writes ?? 0)}`)
  if (counts.tests) parts.push(`测试 ${counts.tests}（通过 ${counts.testsPassed ?? 0}）`)
  return parts.length ? parts.join(' / ') : '暂无执行记录'
}

/** Full progress document. */
export function renderProgress(aggregate) {
  const { workspace, sessions, totals } = aggregate
  const lines = []
  push(lines, `# 工作区进度 — ${workspace.name}`)
  lines.push('')
  push(lines, `> 自动生成于 ${formatTime(aggregate.updatedAt)}。证据来自 DSH Session 事件、工具执行结果与测试命令；**AI 声称**与**已验证**分开记录，不能互相替代。`)
  lines.push('')
  lines.push('## 项目当前状态')
  lines.push('')
  push(lines, `- 工作区：\`${workspace.root}\``)
  push(lines, `- Session：共 ${totals.sessions} 个，最近 24h 活跃 ${totals.active} 个`)
  push(lines, `- 执行统计：工具调用 ${totals.toolCalls} 次（失败 ${totals.toolFailures}），文件修改 ${totals.edits} 次，测试执行 ${totals.tests} 次（通过 ${totals.testsPassed}）`)
  lines.push('')

  lines.push('### 当前项目目标')
  const goals = sessions.filter((state) => state.goal).slice(0, 5)
  if (goals.length === 0) lines.push('- （尚未记录到用户任务描述）')
  else for (const state of goals) push(lines, `- ${sessionTitle(state)}：${shortGoal(state.goal, 120)}`)
  lines.push('')

  lines.push('### 已验证（有执行证据）')
  if (aggregate.verified.length === 0) {
    lines.push('- 暂无通过测试命令验证的完成项（仅有工具调用不等同于任务完成）')
  } else {
    for (const item of aggregate.verified) {
      push(lines, `- [x] ${item.label}${item.count > 1 ? ` ×${item.count}` : ''}（${shortId(item.sessionId)} · ${formatTime(item.at)}）${item.detail ? ` · ${item.detail}` : ''}${item.incomplete ? ' · 历史记录，命令行已截断' : ''}`)
    }
  }
  lines.push('')

  lines.push('### AI 声明完成（未独立验证）')
  if (aggregate.claimedDone.length === 0) lines.push('- 无')
  else for (const item of aggregate.claimedDone) push(lines, `- [~] ${item.text}（${shortId(item.sessionId)} · ${formatTime(item.at)}）`)
  lines.push('')

  lines.push('### 正在进行的任务')
  if (aggregate.inProgress.length === 0 && !aggregate.lastTurn) lines.push('- 无')
  else {
    for (const item of aggregate.inProgress) push(lines, `- ${item.text}（${shortId(item.sessionId)}）`)
    if (aggregate.lastTurn && aggregate.lastTurn.turn.status === 'completed') {
      push(lines, `- 最近一轮：${shortId(aggregate.lastTurn.state.id)} 第 ${aggregate.lastTurn.turn.turn} 轮结束（${formatTime(aggregate.lastTurn.turn.at)}）`)
    }
  }
  lines.push('')

  lines.push('### 关键技术决策')
  if (aggregate.decisions.length === 0) lines.push('- 暂无显式记录（可用 `/progress note <内容>` 记录）')
  else for (const item of aggregate.decisions) push(lines, `- ${item.text}（${shortId(item.sessionId)} · ${formatTime(item.at)}）`)
  lines.push('')

  lines.push('### 当前阻塞和风险')
  if (aggregate.blockers.length === 0) lines.push('- 未发现测试失败或阻塞任务')
  else for (const item of aggregate.blockers) push(lines, `- ${item.label ?? item.text}（${shortId(item.sessionId)} · ${formatTime(item.at)}）`)
  if (aggregate.claims.length > 0) {
    lines.push('')
    lines.push('未验证的 AI 完成声明（仅原文摘要，不代表实际结果）：')
    for (const item of aggregate.claims) push(lines, `- “${item.text}”（${shortId(item.sessionId)} · ${formatTime(item.at)}）`)
  }
  lines.push('')

  lines.push('### 下一步优先任务')
  if (aggregate.nextSteps.length === 0) lines.push('- 无待办记录')
  else for (const item of aggregate.nextSteps) push(lines, `- [ ] ${item.text}（${shortId(item.sessionId)}）`)
  lines.push('')

  lines.push('### 最近重要文件变更')
  if (aggregate.files.length === 0) lines.push('- 无文件修改记录')
  else {
    lines.push('| 文件 | 最近操作 | Session | 时间 | 证据 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const file of aggregate.files) {
      const sessionsText = [...file.sessions].map(shortId).join(', ')
      push(lines, `| \`${file.path.replace(/\|/g, '\\|')}\` | ${file.op === 'write' ? '写入' : '编辑'} ×${file.ops} | ${sessionsText} | ${formatTime(file.lastAt)} | ${file.ok ? '工具调用成功' : '存在失败调用'} |`)
    }
  }
  lines.push('')

  lines.push('## Session 明细')
  lines.push('')
  const detailed = sessions.slice(0, 12)
  if (detailed.length === 0) lines.push('- 无')
  for (const state of detailed) {
    push(lines, `### ${state.id}`)
    push(lines, `- 任务目标：${state.goal || '（未记录）'}`)
    push(lines, `- 当前状态：${statusText(state)}${state.branch ? ` · 分支 ${state.branch}` : ''}${state.worktree ? ` · worktree ${state.worktree}` : ''}`)
    push(lines, `- 本次完成：${sessionEvidence(state)}`)
    const files = Object.values(state.files ?? {}).slice(-5)
    if (files.length > 0) {
      for (const file of files) push(lines, `- 文件变更及证据：\`${file.path}\`（${file.op === 'write' ? '写入' : '编辑'} ×${file.ops} · ${file.ok ? '成功' : '失败'} · ${formatTime(file.lastAt)}）`)
    }
    const tests = Object.values(state.tests ?? {}).slice(-3)
    for (const test of tests) push(lines, `- 测试证据：\`${test.command}\` → ${test.ok ? '通过' : '失败'}${test.exitCode !== null && test.exitCode !== undefined ? `（exit ${test.exitCode}）` : ''} · ${formatTime(test.at)}`)
    const pending = Object.values(state.todos ?? {}).filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled')
    if (pending.length > 0) push(lines, `- 遗留事项：${pending.slice(0, 6).map((todo) => todo.content).join('；')}`)
    push(lines, `- 最后更新：${formatTime(state.updatedAt)}`)
    lines.push('')
  }
  return lines.join('\n')
}

function bulletSection(title, items, empty = '无') {
  const lines = [title]
  if (!items.length) lines.push(`- ${empty}`)
  else for (const item of items) lines.push(`- ${item}`)
  return lines.join('\n')
}

/** Low-token summary for injection and quick reading. */
export function renderSummary(aggregate, options = {}) {
  const maxTokens = options.maxTokens ?? 700
  const sessionLimit = options.maxSessionsInSummary ?? 5
  const header = `# ${aggregate.workspace.name} — 工作区进度摘要\nupdated: ${formatTime(aggregate.updatedAt)}`
  const goalItems = aggregate.sessions
    .filter((state) => state.goal)
    .slice(0, 3)
    .map((state) => `${shortId(state.id)}: ${shortGoal(state.goal, 80)}`)
  const verifiedItems = aggregate.verified
    .filter((item) => !item.incomplete)
    .slice(0, 3)
    .map((item) => `${truncateText(item.label, 90)}${item.count > 1 ? ` ×${item.count}` : ''}（${shortId(item.sessionId)}）`)
  const claimedItems = aggregate.claimedDone.slice(0, 3).map((item) => `${truncateText(item.text, 70)}（${shortId(item.sessionId)}，AI 声明）`)
  const runningItems = aggregate.inProgress.slice(0, 3).map((item) => `${truncateText(item.text, 70)}（${shortId(item.sessionId)}）`)
  const nextItems = aggregate.nextSteps.slice(0, 3).map((item) => truncateText(item.text, 70))
  const blockedItems = aggregate.blockers.slice(0, 2).map((item) => truncateText(item.label ?? item.text, 100))
  const fileItems = aggregate.files.slice(0, 3).map((file) => `\`${file.path}\``)
  const sessionItems = aggregate.sessions.slice(0, sessionLimit).map((state) => `${shortId(state.id)} ${statusText(state)}`)

  const sections = [
    { key: 'goal', text: bulletSection('## 目标', goalItems) },
    { key: 'verified', text: bulletSection('## 已验证', verifiedItems, '无（尚无测试通过记录）') },
    { key: 'running', text: bulletSection('## 进行中', runningItems, '无') },
    { key: 'next', text: bulletSection('## 下一步', nextItems, '无') },
    { key: 'blocked', text: bulletSection('## 阻塞', blockedItems, '无') },
    { key: 'claimed', text: bulletSection('## AI 声明完成（未验证）', claimedItems, '无') },
    { key: 'files', text: bulletSection('## 近期文件', fileItems, '无') },
    { key: 'sessions', text: bulletSection('## Session', sessionItems, '无') },
  ]
  const footer = `read: ${String(aggregate.workspace.root).replace(/\\/g, '/')}/.dsh/progress/progress.md`

  const assemble = (keys) =>
    [header, ...sections.filter((section) => keys.has(section.key)).map((section) => section.text), footer].join('\n\n')

  const priority = ['blocked', 'claimed', 'files', 'sessions']
  let included = new Set(['goal', 'verified', 'running', 'next', 'blocked', 'claimed', 'files', 'sessions'])
  let text = assemble(included)
  while (estimateTokens(text) > maxTokens) {
    const drop = priority.find((key) => included.has(key))
    if (!drop) break
    included.delete(drop)
    text = assemble(included)
  }
  if (estimateTokens(text) > maxTokens) text = clampToTokens(text, maxTokens - 1)
  // Essential sections (goal/verified/running/next) are never dropped; the hard clamp is the last resort.
  return text
}

/** The single message injected into a session's first model step. */
export function renderInjection(aggregate, summary, options = {}) {
  const maxTokens = options.maxTokens ?? 800
  const root = String(aggregate?.workspace?.root ?? '').replace(/\\/g, '/')
  const head = [
    '[workspace-progress] 同工作区最新进度（自动注入一次，来自 DSH 事件与工具执行证据）',
    `workspace: ${root}`,
    `sessions: ${aggregate?.totals?.sessions ?? 0}（活跃 ${aggregate?.totals?.active ?? 0}）`,
  ].join('\n')
  const tail = [
    `完整进度（含逐 Session 证据）：${root}/.dsh/progress/progress.md`,
    '说明：上面“已验证”仅指测试命令通过；“AI 声明”未经独立验证。不要据此推断未列出的工作已完成。',
  ].join('\n')
  const fixed = estimateTokens(head) + estimateTokens(tail) + 6
  const budget = Math.max(120, maxTokens - fixed)
  const body = clampToTokens(String(summary || '').trim(), budget)
  return `${head}\n\n${body}\n\n${tail}`
}