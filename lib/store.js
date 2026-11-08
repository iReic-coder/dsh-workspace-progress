/**
 * Durable local storage primitives: atomic replacement, directory locks and
 * append-only JSONL. Tuned for Windows (rename retries, lock directories)
 * while remaining portable to macOS/Linux.
 */
import { randomBytes } from 'node:crypto'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

const WINDOWS_TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'])

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

export async function readText(file, fallback = '') {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return fallback
  }
}

export async function readJson(file, fallback = null) {
  try {
    const text = await readFile(file, 'utf8')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function writeJson(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

/** Replace a file atomically: write a sibling temp file, flush, then rename. */
export async function writeFileAtomic(file, content) {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let handle
  try {
    handle = await open(temp, 'w')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle?.close()
  }
  let attempt = 0
  for (;;) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      attempt += 1
      if (!WINDOWS_TRANSIENT_RENAME.has(error?.code) || attempt > 8) {
        await rm(temp, { force: true })
        throw error
      }
      await sleep(20 * attempt)
    }
  }
}

export async function appendJsonl(file, records) {
  if (!records || records.length === 0) return
  await ensureDir(path.dirname(file))
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await appendFile(file, text, 'utf8')
}

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function removeStaleLock(lockDir, staleMs) {
  try {
    const info = await stat(lockDir)
    if (Date.now() - info.mtimeMs < staleMs) return false
    const ownerFile = path.join(lockDir, 'owner.json')
    let owner = null
    try {
      owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    } catch {
      owner = null
    }
    if (owner && (await pidAlive(owner.pid)) && Date.now() - Number(owner.at || 0) < staleMs) {
      return false
    }
    await rm(lockDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Serialize a workspace-level operation across processes using a lock
 * directory. Readers that do not write never take the lock.
 */
export async function withFileLock(lockDir, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000
  const staleMs = options.staleMs ?? 15000
  const started = Date.now()
  let delay = 15
  await ensureDir(path.dirname(lockDir))
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() - started > timeoutMs) {
        if (await removeStaleLock(lockDir, staleMs)) continue
        throw new Error(`progress lock timed out: ${lockDir}`)
      }
      await sleep(delay)
      delay = Math.min(200, Math.round(delay * 1.6))
    }
  }
  try {
    try {
      await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
    } catch {
      // Ownership metadata is advisory only.
    }
    return await operation()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function listFiles(dir, filter = () => true) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && filter(entry.name)).map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

export async function removeFile(file) {
  await unlink(file).catch(() => {})
}

/** Move one session's durable files into a dated archive directory. */
export async function archiveSessionFiles(progressDir, sessionId, stamp = new Date()) {
  const month = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}`
  const targetDir = path.join(progressDir, 'archive', month)
  await ensureDir(targetDir)
  const moved = []
  for (const [dir, ext] of [
    [path.join(progressDir, 'sessions'), '.json'],
    [path.join(progressDir, 'events'), '.jsonl'],
  ]) {
    const source = path.join(dir, `${sessionId}${ext}`)
    try {
      await rename(source, path.join(targetDir, `${sessionId}${ext}`))
      moved.push(source)
    } catch {
      // Absent files are fine.
    }
  }
  return moved
}