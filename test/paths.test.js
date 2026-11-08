import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findGitMetadata, resolveWorkspace } from '../lib/paths.js'

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

test('resolves a plain directory as its own workspace', () => {
  const dir = tempDir('wp-plain-')
  const workspace = resolveWorkspace(dir)
  assert.equal(workspace.root, dir)
  assert.equal(workspace.git, null)
  assert.equal(workspace.progressDir, path.join(dir, '.dsh', 'progress'))
})

test('uses the repository root for nested session directories', () => {
  const repo = tempDir('wp-repo-')
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
  const nested = path.join(repo, 'packages', 'app')
  mkdirSync(nested, { recursive: true })

  const workspace = resolveWorkspace(nested)
  assert.equal(workspace.root, repo)
  assert.equal(workspace.git.branch, 'feature/x')
  assert.equal(workspace.git.isWorktree, false)
  assert.equal(workspace.key, resolveWorkspace(repo).key)
})

test('groups a linked worktree with its main repository', () => {
  const main = tempDir('wp-main-')
  mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true })
  writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/topic\n')
  writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')

  const worktree = tempDir('wp-wt-')
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`)

  const metadata = findGitMetadata(worktree)
  assert.equal(metadata.isWorktree, true)
  assert.equal(path.resolve(metadata.repoRoot), path.resolve(main))
  assert.equal(metadata.gitDir, path.join(main, '.git', 'worktrees', 'wt'))

  const repositoryScope = resolveWorkspace(worktree, { scope: 'repository' })
  assert.equal(repositoryScope.root, main)
  assert.equal(repositoryScope.git.branch, 'topic')

  const worktreeScope = resolveWorkspace(worktree, { scope: 'worktree' })
  assert.equal(path.resolve(worktreeScope.root), path.resolve(worktree))
})