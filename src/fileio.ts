// src/fileio.ts
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

export type ReplayFile = { absPath: string; minBlock: number; maxBlock: number }
type Header = Record<string, unknown>

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true })
}

export async function gzipWriteNDJSON<T>(filePath: string, header: Header, rows: T[]) {
  const tmp = `${filePath}.tmp`
  const gz = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })
  const ws = fs.createWriteStream(tmp)
  gz.pipe(ws)

  gz.write(JSON.stringify(header) + '\n')
  for (const r of rows) gz.write(JSON.stringify(r) + '\n')
  gz.end()

  await new Promise<void>((resolve, reject) => {
    ws.on('finish', () => { fs.renameSync(tmp, filePath); resolve() })
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
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
      if (!line) continue
      if (first && skipHeader) { first = false; continue }
      rows.push(JSON.parse(line))
    }
  }
  if (rows.length) yield rows
}

// Manifest helpers (atomic-ish update)
type Manifest = { files: { path: string; minBlock: number; maxBlock: number }[] }

export function withManifest(manifestPath: string, mutate?: (m: Manifest) => Manifest): any {
  let m: Manifest
  try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { m = { files: [] } }
  if (!mutate) {
    return m.files.map(f => ({
      absPath: path.join(path.dirname(manifestPath), f.path),
      minBlock: f.minBlock, maxBlock: f.maxBlock
    }))
  }
  const next = mutate(m)
  const tmp = `${manifestPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, manifestPath)
  return next
}
