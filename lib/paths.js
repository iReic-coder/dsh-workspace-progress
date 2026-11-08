/**
 * Workspace identity resolution: Windows-safe path normalization plus Git
 * repository / worktree detection without spawning git.
 *
 * A "project" is the Git repository root when the session directory lives in
 * one (so sub-directories and linked worktrees share progress), otherwise the
 * session directory itself.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export function isWindows() {
  return process.platform === 'win32'
}

/** Normalize separators and remove a trailing separator. */
export function normalizePath(input) {
  let value = String(input || '').trim()
  if (!value) return ''
  value = path.normalize(value)
  if (value.length > 3 && /[\\/]$/.test(value)) value = value.replace(/[\\/]+$/, '')
  return value
}

/** Stable identity key for a path (case-insensitive on Windows). */
export function canonicalKey(input) {
  const normalized = normalizePath(input)
  if (!normalized) return ''
  let key = normalized
  try {
    key = realpathSync.native(normalized)
  } catch {
    // The path may not exist yet; the normalized form is still stable enough.
  }
  key = key.replace(/\\/g, '/')
  if (isWindows()) {
    key = key.toLowerCase()
  }
  return key
}

/** Fast path comparison without touching the filesystem. */
export function samePath(a, b) {
  const left = normalizePath(a).replace(/\\/g, '/')
  const right = normalizePath(b).replace(/\\/g, '/')
  if (!left || !right) return false
  return isWindows() ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Human-facing path: forward slashes, `~` for the home directory. */
export function displayPath(input, home = process.env.USERPROFILE || process.env.HOME) {
  const normalized = normalizePath(input).replace(/\\/g, '/')
  if (home) {
    const homeKey = canonicalKey(home)
    const valueKey = canonicalKey(normalized)
    if (homeKey && valueKey.startsWith(homeKey + '/')) {
      return '~' + normalized.slice(normalizePath(home).replace(/\\/g, '/').length)
    }
  }
  return normalized
}

function safeStat(target) {
  try {
    return statSync(target)
  } catch {
    return undefined
  }
}

/**
 * Walk up from `start` looking for `.git`, supporting both a repository
 * directory and a linked-worktree `.git` file.
 *
 * @returns {{repoRoot: string, gitDir: string, worktreeRoot: string, isWorktree: boolean}|null}
 */
export function findGitMetadata(start) {
  let dir = normalizePath(start)
  for (let depth = 0; dir && depth < 64; depth += 1) {
    const dotGit = path.join(dir, '.git')
    if (existsSync(dotGit)) {
      const stat = lstatSync(dotGit)
      if (stat.isDirectory()) {
        return { repoRoot: dir, gitDir: dotGit, worktreeRoot: dir, isWorktree: false }
      }
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
        if (match) {
          const gitDir = path.resolve(dir, match[1].trim())
          let commonDir = gitDir
          const commonFile = path.join(gitDir, 'commondir')
          if (existsSync(commonFile)) {
            const relative = readFileSync(commonFile, 'utf8').trim()
            if (relative) commonDir = path.resolve(gitDir, relative)
          }
          // A linked worktree's common dir is `<main>/.git`; its parent is the repository root.
          const repoRoot = path.dirname(commonDir)
          return { repoRoot, gitDir, worktreeRoot: dir, isWorktree: true }
        }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Current branch (or a short detached-HEAD marker) read from `.git/HEAD`. */
export function readGitBranch(gitDir) {
  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
    if (/^[0-9a-f]{40}$/i.test(head)) return `detached@${head.slice(0, 8)}`
    if (head.startsWith('ref: ')) return head.slice(5)
  } catch {
    // HEAD is optional for our purposes.
  }
  return null
}

/** Ignore Git's internal plumbing when a session happens to run inside `.git`. */
function isInsideGitDir(target, gitDir) {
  if (!gitDir) return false
  const targetKey = canonicalKey(target)
  const gitKey = canonicalKey(gitDir)
  return targetKey === gitKey || targetKey.startsWith(gitKey + '/')
}

/**
 * Resolve the workspace that owns a session directory.
 *
 * @param {string} cwd - the session's effective working directory.
 * @param {{scope?: 'repository'|'worktree'|'directory'}} [options]
 */
export function resolveWorkspace(cwd, options = {}) {
  const start = normalizePath(cwd)
  if (!start) return null
  const scope = options.scope === 'worktree' || options.scope === 'directory' ? options.scope : 'repository'
  const git = findGitMetadata(start)
  let projectRoot = start
  let branch = null
  let worktreeRoot = null
  let isWorktree = false
  let repoRoot = null

  if (git) {
    repoRoot = git.repoRoot
    worktreeRoot = git.worktreeRoot
    isWorktree = git.isWorktree
    branch = readGitBranch(git.gitDir)
    if (scope === 'repository') projectRoot = git.repoRoot
    else if (scope === 'worktree') projectRoot = git.worktreeRoot
    else projectRoot = start
  }

  // A session opened inside `.git` should still report the owning repository.
  if (git && isInsideGitDir(start, git.gitDir)) projectRoot = git.repoRoot

  const existing = safeStat(projectRoot)
  const name = path.basename(projectRoot) || projectRoot

  return {
    cwd: start,
    root: projectRoot,
    key: canonicalKey(projectRoot),
    name,
    exists: Boolean(existing && existing.isDirectory()),
    progressDir: path.join(projectRoot, '.dsh', 'progress'),
    git: git
      ? {
          repoRoot,
          worktreeRoot,
          branch,
          isWorktree,
          gitDir: git.gitDir,
        }
      : null,
  }
}