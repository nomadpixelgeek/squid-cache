// src/index.ts
import { gzipWriteNDJSON, gunzipReadNDJSON, ensureDir, withManifest, ReplayFile } from './fileio'
import { stableHash16 } from './hashing'
import { makeLogger, Logger } from './logger'
import * as path from 'path'

export { makeLogger } from './logger'

export type SlimLog = {
  address: string
  data: string
  topics: string[]
  transactionHash: string
  blockNumber: number
  logIndex: number
  transactionIndex: number
  blockHash?: string
}
export type SlimTx = { hash?: string; from?: string; to?: string }

export type SlimBlock = {
  header: { height: number; hash?: string | null; timestamp: number }
  logs: SlimLog[]
  transactions?: SlimTx[]
}

export type CacheMode = 'record' | 'replay' | 'off'

export type CacheInit = {
  root?: string
  project: string
  chain: string
  configIdentity: unknown
  mode?: CacheMode
  logger?: Logger
}

export type Recorder = {
  readonly root: string
  readonly project: string
  readonly chain: string
  readonly configHash: string
  readonly mode: CacheMode
  recordBatch(blocks: any[]): Promise<void>
  listReplayFiles(): ReplayFile[]
  readFile(fileAbsPath: string): AsyncGenerator<SlimBlock[]>
  autoSwapBlocks(liveBlocks: SlimBlock[], logger?: Pick<Logger, 'info' | 'debug'>): Promise<SlimBlock[]>
}

function envMode(): CacheMode {
  const m = (process.env.SQUID_CACHE_MODE || 'record').toLowerCase()
  return (['record', 'replay', 'off'].includes(m) ? m : 'record') as CacheMode
}
function envRoot(defaultRoot: string) {
  return process.env.SQUID_CACHE_ROOT || defaultRoot
}
function envAutoUse(): boolean {
  const v = String(process.env.SQUID_CACHE_AUTO_USE || 'off').toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}
function envRequireFullCover(): boolean {
  const v = String(process.env.SQUID_CACHE_AUTO_REQUIRE_FULL_COVER || 'true').toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

// helpers
function minMaxFrom(blocks: SlimBlock[]) {
  if (!blocks.length) return { min: 0, max: -1 }
  const hs = blocks.map(b => b.header.height)
  return { min: Math.min(...hs), max: Math.max(...hs) }
}
function intersects(aMin: number, aMax: number, bMin: number, bMax: number) {
  return !(aMax < bMin || bMax < aMin)
}
function fullyCovered(aMin: number, aMax: number, segs: { min: number; max: number }[]) {
  let cursor = aMin
  const sorted = segs.filter(s => s.max >= aMin && s.min <= aMax).sort((x, y) => x.min - y.min)
  for (const s of sorted) {
    if (s.min > cursor) return false
    cursor = Math.max(cursor, s.max + 1)
    if (cursor > aMax) return true
  }
  return cursor > aMax
}

export function makeRecorder(init: CacheInit): Recorder {
  const mode = init.mode ?? envMode()
  const root = envRoot(path.join(process.cwd(), 'squid-cache'))
  const project = init.project
  const chain = init.chain
  const configHash = stableHash16({ project, chain, identity: init.configIdentity })
  const base = path.join(root, project, chain, configHash)
  const log = (init.logger ?? makeLogger('squid-cache')).child({ prefix: `${project}/${chain}@${configHash}` })

  // Banner
  log.info(`cache root: ${base}`)
  if (mode === 'record') log.info(`mode=record → batches will be written`)
  if (mode === 'replay') log.info(`mode=replay → batches will be read; no writes`)
  if (mode === 'off')    log.info(`mode=off → caching disabled`)

  async function recordBatch(blocks: any[]) {
    if (mode === 'off' || mode === 'replay') {
      log.debug(`record skipped (mode=${mode})`)
      return
    }
    if (!blocks?.length) {
      log.debug(`record skipped (empty batch)`)
      return
    }

    const slim: SlimBlock[] = blocks.map((b) => {
      const slimLogs: SlimLog[] = (b.logs ?? []).map((l: any) => ({
        address: l.address,
        data: l.data,
        topics: l.topics,
        transactionHash: l.transactionHash,
        blockNumber: l.blockNumber ?? b.header?.height ?? 0,
        logIndex: l.logIndex ?? 0,
        transactionIndex: l.transactionIndex ?? 0,
        blockHash: l.blockHash,
      }))

      // Prefer block.header.hash; if missing, backfill from the first log
      const headerHash =
        b.header?.hash ??
        slimLogs[0]?.blockHash ??
        null

      return {
        header: {
          height: b.header?.height ?? b.header?.number ?? b.number ?? 0,
          hash: headerHash,
          timestamp: b.header?.timestamp ?? 0,
        },
        logs: slimLogs,
        transactions: (b.transactions ?? []).map((t: any) => ({
          hash: t.hash,
          from: t.from,
          to: t.to,
        })),
      }
    })

    const minBlock = slim[0]?.header.height ?? 0
    const maxBlock = slim[slim.length - 1]?.header.height ?? minBlock
    const day = new Date().toISOString().slice(0, 10)
    const dayDir = path.join(base, day)
    ensureDir(dayDir)

    const filePath = path.join(dayDir, `${minBlock}-${maxBlock}.ndjson.gz`)

    log.debug(`writing batch ${minBlock}-${maxBlock} → ${filePath}`)
    await gzipWriteNDJSON(filePath, {
      kind: 'subsquid-evm-batch', project, chain, configHash, fileVersion: 1,
      minBlock, maxBlock, createdAt: new Date().toISOString(),
    }, slim)

    await withManifest(path.join(base, 'manifest.json'), (man) => {
      man.files.push({ path: path.relative(base, filePath), minBlock, maxBlock })
      man.files.sort((a: any, b: any) => a.minBlock - b.minBlock)
      return man
    })

    const totalLogs = slim.reduce((n, b) => n + (b.logs?.length || 0), 0)
    log.info(`cached batch ${minBlock}-${maxBlock} (${totalLogs} logs)`)
  }

  function listReplayFiles(): ReplayFile[] {
    const files = withManifest(path.join(base, 'manifest.json')) as ReplayFile[]
    log.info(`replay index: ${files.length} file(s) available`)
    return files
  }

  async function* readFile(fileAbsPath: string) {
    const fileName = path.basename(fileAbsPath)
    log.info(`using cache file: ${fileName}`)
    for await (const blocks of gunzipReadNDJSON<SlimBlock>(fileAbsPath, true)) {
      log.debug(`loaded ${blocks.length} block(s) from ${fileName}`)
      yield blocks
    }
    log.debug(`finished file: ${fileName}`)
  }

  async function autoSwapBlocks(liveBlocks: SlimBlock[], logger?: Pick<Logger, 'info' | 'debug'>): Promise<SlimBlock[]> {
    const autoOn = envAutoUse()
    if (!autoOn || !liveBlocks?.length) return liveBlocks

    const { min, max } = minMaxFrom(liveBlocks)
    const files = listReplayFiles()
    if (!files.length) return liveBlocks

    const inRange = files.filter(f => intersects(min, max, f.minBlock, f.maxBlock))
    if (!inRange.length) return liveBlocks

    const requireFull = envRequireFullCover()
    if (requireFull) {
      const covers = fullyCovered(min, max, inRange.map(f => ({ min: f.minBlock, max: f.maxBlock })))
      if (!covers) {
        logger?.debug?.(`[cache:auto] coverage not full for ${chain} ${min}-${max}, live path stays`)
        return liveBlocks
      }
    }

    const collected: SlimBlock[] = []
    for (const f of inRange) {
      for await (const blocks of readFile(f.absPath)) {
        for (const b of blocks) {
          const h = b.header.height
          if (h >= min && h <= max) collected.push(b)
        }
      }
    }

    // sort + dedup by height
    collected.sort((a, b) => a.header.height - b.header.height)
    const dedup: SlimBlock[] = []
    let last = -1
    for (const b of collected) {
      if (b.header.height !== last) { dedup.push(b); last = b.header.height }
    }

    if (requireFull) {
      const gotFirst = dedup[0]?.header.height
      const gotLast = dedup[dedup.length - 1]?.header.height
      if (!(gotFirst === min && gotLast === max && dedup.length >= (max - min + 1))) {
        logger?.debug?.(`[cache:auto] stitched blocks didn’t fully cover ${min}-${max}, live path stays`)
        return liveBlocks
      }
    }

    const info = logger ?? log
    info.info(`[cache:auto] using cached input for ${project}/${chain} covering ${min}-${max} from ${inRange.length} file(s)`)
    return dedup
  }

  return { root, project, chain, configHash, mode, recordBatch, listReplayFiles, readFile, autoSwapBlocks }
}
