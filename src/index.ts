// src/index.ts
import { gzipWriteNDJSON, gunzipReadNDJSON, ensureDir, withManifest, ReplayFile } from './fileio'
import { stableHash16 } from './hashing'
import { makeLogger, Logger } from './logger'
import * as path from 'path'

export { makeLogger }
export type SlimLog = { address: string; data: string; topics: string[]; transactionHash: string; blockNumber: number; logIndex: number; transactionIndex: number }
export type SlimTx = { hash?: string; from?: string; to?: string }
export type SlimBlock = { header: { height: number; hash?: string | null; timestamp: number }; logs: SlimLog[]; transactions?: SlimTx[] }

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
}

function envMode(): CacheMode {
  const m = (process.env.SQUID_CACHE_MODE || 'record').toLowerCase()
  return (['record','replay','off'].includes(m) ? m : 'record') as CacheMode
}
function envRoot(defaultRoot: string) {
  return process.env.SQUID_CACHE_ROOT || defaultRoot
}

export function makeRecorder(init: CacheInit): Recorder {
  const mode = init.mode ?? envMode()
  const root = envRoot(path.join(process.cwd(), 'squid-cache'))
  const project = init.project
  const chain = init.chain
  const configHash = stableHash16({ project, chain, identity: init.configIdentity })

  const base = path.join(root, project, chain, configHash)
  const log = (init.logger ?? makeLogger('squid-cache'))
    .child({ prefix: `${project}/${chain}@${configHash}` })

  // Startup banner
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

    const slim: SlimBlock[] = blocks.map((b) => ({
      header: { height: b.header?.height ?? b.header?.number ?? b.number ?? 0, hash: b.header?.hash ?? null, timestamp: b.header?.timestamp ?? 0 },
      logs: (b.logs ?? []).map((l: any) => ({
        address: l.address, data: l.data, topics: l.topics, transactionHash: l.transactionHash,
        blockNumber: l.blockNumber ?? b.header?.height ?? 0, logIndex: l.logIndex ?? 0, transactionIndex: l.transactionIndex ?? 0,
      })),
      transactions: (b.transactions ?? []).map((t: any) => ({ hash: t.hash, from: t.from, to: t.to })),
    }))

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

    log.info(`cached batch ${minBlock}-${maxBlock} (${slim.reduce((n, b) => n + (b.logs?.length || 0), 0)} logs)`)
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

  return { root, project, chain, configHash, mode, recordBatch, listReplayFiles, readFile }
}
