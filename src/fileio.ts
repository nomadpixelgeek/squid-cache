// src/fileio.ts
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import * as os from 'os'

export type ReplayFile = { absPath: string; minBlock: number; maxBlock: number }
type Header = Record<string, unknown>

// ---------- utilities ----------

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true })
}

function nowIso() {
  return new Date().toISOString()
}

function sleepBlocking(ms: number) {
  // Block the current thread without burning CPU
  // (keeps withManifest() synchronous for backwards compat)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readJsonFile<T = any>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

// ---------- gzip helpers ----------

export async function gzipWriteNDJSON<T>(filePath: string, header: Header, rows: T[]) {
  const tmp = `${filePath}.tmp`
  const gz = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })
  const ws = fs.createWriteStream(tmp)
  gz.pipe(ws)

  gz.write(JSON.stringify(header) + '\n')
  for (const r of rows) gz.write(JSON.stringify(r) + '\n')
  gz.end()

  await new Promise<void>((resolve, reject) => {
    ws.on('finish', () => {
      fs.renameSync(tmp, filePath)
      resolve()
    })
    ws.on('error', reject)
    gz.on('error', reject)
  })
}

export async function* gunzipReadNDJSON<T>(fileAbsPath: string, skipHeader = false): AsyncGenerator<T[]> {
  const gunzip = zlib.createGunzip()
  const rs = fs.createReadStream(fileAbsPath)
  rs.pipe(gunzip)

  let first = true
  const rows: T[] = []
  let buf = ''

  for await (const chunk of gunzip) {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line) continue
      if (first && skipHeader) {
        first = false
        continue
      }
      rows.push(JSON.parse(line))
    }
  }
  if (rows.length) yield rows
}

// ---------- Manifest + Locking ----------

type Manifest = { files: { path: string; minBlock: number; maxBlock: number }[] }

type LockMeta = {
  pid: number
  host: string
  at: string // ISO
}

function lockPath(manifestPath: string) {
  return `${manifestPath}.lock`
}

function writeLock(lp: string) {
  const fd = fs.openSync(lp, 'wx')
  const meta: LockMeta = { pid: process.pid, host: os.hostname(), at: nowIso() }
  fs.writeFileSync(fd, JSON.stringify(meta))
  fs.closeSync(fd)
}

function getLockAgeMs(lp: string): number {
  try {
    const s = fs.statSync(lp)
    return Date.now() - s.mtimeMs
  } catch {
    return 0
  }
}

function readLockMeta(lp: string): LockMeta | undefined {
  return readJsonFile<LockMeta>(lp)
}

function removeLock(lp: string) {
  try {
    fs.unlinkSync(lp)
  } catch {
    // ignore
  }
}

/**
 * Acquire an exclusive manifest lock, with:
 *  - adaptive backoff + jitter
 *  - stale-lock eviction (TTL)
 *  - configurable timeout
 */
function acquireLock(
  manifestPath: string,
  {
    timeoutMs = Number(process.env.SQUID_CACHE_LOCK_TIMEOUT_MS ?? 15000),
    staleMs = Number(process.env.SQUID_CACHE_LOCK_STALE_MS ?? 60000),
    baseDelayMs = Number(process.env.SQUID_CACHE_LOCK_BASE_DELAY_MS ?? 25),
    backoffFactor = Number(process.env.SQUID_CACHE_LOCK_BACKOFF_FACTOR ?? 1.5),
    maxDelayMs = Number(process.env.SQUID_CACHE_LOCK_MAX_DELAY_MS ?? 500),
    jitterMs = Number(process.env.SQUID_CACHE_LOCK_JITTER_MS ?? 25),
  } = {}
) {
  const lp = lockPath(manifestPath)
  const start = Date.now()
  let attempt = 0
  let delay = baseDelayMs

  // Ensure dir exists before locking
  ensureDir(path.dirname(manifestPath))

  // Fast path: try once
  try {
    writeLock(lp)
    return
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e
  }

  // Contention path: wait with backoff, clear stale lock if needed
  while (true) {
    // If lock looks stale, remove it optimistically
    const age = getLockAgeMs(lp)
    if (age > staleMs) {
      // As a last safeguard, read meta for diagnostics before removing
      const meta = readLockMeta(lp)
      try {
        removeLock(lp)
      } catch {
        // race: someone else removed it
      }
    }

    try {
      writeLock(lp)
      return
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
    }

    // timeout?
    const waited = Date.now() - start
    if (waited >= timeoutMs) {
      const meta = readLockMeta(lp)
      const metaStr = meta ? ` (held by pid=${meta.pid} host=${meta.host} since ${meta.at})` : ''
      throw new Error(`Timeout acquiring manifest lock: ${lp}${metaStr}; ageMs=${age}; waitedMs=${waited}`)
    }

    // backoff + jitter
    attempt += 1
    const jitter = Math.floor(Math.random() * Math.max(0, jitterMs))
    sleepBlocking(Math.min(delay + jitter, maxDelayMs))
    delay = Math.min(Math.floor(delay * backoffFactor), maxDelayMs)
  }
}

function releaseLock(manifestPath: string) {
  removeLock(lockPath(manifestPath))
}

export function withManifest(manifestPath: string, mutate?: (m: Manifest) => Manifest): any {
  // Always lock around manifest access for multi-writer safety
  acquireLock(manifestPath)
  try {
    let m: Manifest
    try {
      m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      m = { files: [] }
    }

    if (!mutate) {
      return m.files.map((f) => ({
        absPath: path.join(path.dirname(manifestPath), f.path),
        minBlock: f.minBlock,
        maxBlock: f.maxBlock,
      }))
    }

    const next = mutate(m)
    const tmp = `${manifestPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, manifestPath)
    return next
  } finally {
    releaseLock(manifestPath)
  }
}
