// src/cli.ts
// #!/usr/bin/env node
/* eslint-disable no-console */
import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { makeRecorder, SlimBlock } from './index.ts'

type Target = {
  project: string
  chain: string
  runner: string
  configIdentity: unknown
}

type Args = {
  targetsPath: string
  concurrency: number
  filterProjects: Set<string> | null
  filterChains: Set<string> | null
  dryRun: boolean
  fromBlock?: number
  toBlock?: number
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    targetsPath: '',
    concurrency: Number(process.env.REPLAY_CONCURRENCY ?? 2),
    filterProjects: null,
    filterChains: null,
    dryRun: false
  }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--targets' || k === '-t') a.targetsPath = argv[++i]
    else if (k === '--concurrency' || k === '-c') a.concurrency = Math.max(1, Number(argv[++i]))
    else if (k === '--projects' || k === '-p') a.filterProjects = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (k === '--chains' || k === '-n') a.filterChains = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (k === '--fromBlock') a.fromBlock = Number(argv[++i])
    else if (k === '--toBlock') a.toBlock = Number(argv[++i])
    else if (k === '--dry-run') a.dryRun = true
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0) }
  }
  if (!a.targetsPath) { console.error('Error: --targets <file.json> is required.'); printHelp(); process.exit(1) }
  return a
}

function printHelp() {
  console.log(`
Unified Squid Cache Replay

Usage:
  squid-cache-replay --targets ./replay.targets.json [--concurrency 3] [--projects events,analytics] [--chains arbitrum,base] [--fromBlock 19000000] [--toBlock 19100000] [--dry-run]

Block filters:
  --fromBlock N   Only replay blocks >= N
  --toBlock   N   Only replay blocks <= N
`)
}

function readTargets(p: string): Target[] {
  const abs = path.resolve(p)
  return JSON.parse(fs.readFileSync(abs, 'utf8'))
}

type RunnerModule = { replayBatch: (project: string, chain: string, blocks: SlimBlock[]) => Promise<void> }

async function dynImportRunner(modPath: string): Promise<RunnerModule> {
  const abs = path.isAbsolute(modPath) ? modPath : path.resolve(process.cwd(), modPath)
  const url = pathToFileURL(abs).href
  const mod = await import(url)
  if (typeof mod.replayBatch !== 'function') throw new Error(`Runner ${modPath} must export async function replayBatch(project, chain, blocks)`)
  return mod as RunnerModule
}

function limitConcurrency<T>(n: number, tasks: (() => Promise<T>)[]) {
  const queue = tasks.slice()
  let running = 0
  const results: Promise<T>[] = []
  function runNext(): void {
    if (!queue.length) return
    while (running < n && queue.length) {
      const task = queue.shift()!
      const p = task().finally(() => { running--; runNext() })
      running++
      results.push(p)
    }
  }
  runNext()
  return Promise.allSettled(results)
}

function fileInRange(fileMin: number, fileMax: number, fromB?: number, toB?: number) {
  if (fromB != null && fileMax < fromB) return false
  if (toB   != null && fileMin > toB) return false
  return true
}

function filterBlocks(blocks: SlimBlock[], fromB?: number, toB?: number) {
  if (fromB == null && toB == null) return blocks
  return blocks.filter(b => {
    const h = b.header.height ?? 0
    if (fromB != null && h < fromB) return false
    if (toB   != null && h > toB)   return false
    return true
  })
}

async function runTarget(t: Target, fromBlock?: number, toBlock?: number) {
  const rec = makeRecorder({ project: t.project, chain: t.chain, configIdentity: t.configIdentity, mode: 'replay' })
  const files = rec.listReplayFiles()
  if (!files.length) { console.log(`ℹ️  No cache for ${t.project}/${t.chain}@${rec.configHash} — skipping`); return }

  const runner = await dynImportRunner(t.runner)
  console.log(`🔁 Replaying for ${t.project}/${t.chain} (hash ${rec.configHash})`)

  for (const f of files) {
    if (!fileInRange(f.minBlock, f.maxBlock, fromBlock, toBlock)) continue
    for await (const blocks of rec.readFile(f.absPath)) {
      const sub = filterBlocks(blocks, fromBlock, toBlock)
      if (!sub.length) continue
      await runner.replayBatch(t.project, t.chain, sub)
    }
  }
  console.log(`✅ Done: ${t.project}/${t.chain}`)
}

async function main() {
  const args = parseArgs(process.argv)
  const targets = readTargets(args.targetsPath)
    .filter(t => !args.filterProjects || args.filterProjects.has(t.project))
    .filter(t => !args.filterChains || args.filterChains.has(t.chain))

  if (args.dryRun) {
    for (const t of targets) console.log(`Would replay -> project=${t.project} chain=${t.chain} from=${args.fromBlock ?? '-'} to=${args.toBlock ?? '-'}`)
    return
  }

  console.log(`▶️  Starting unified replay for ${targets.length} target(s) concurrency=${args.concurrency} from=${args.fromBlock ?? '-'} to=${args.toBlock ?? '-'}`)
  const tasks = targets.map(t => () => runTarget(t, args.fromBlock, args.toBlock))
  const results = await limitConcurrency(args.concurrency, tasks)

  let ok = 0, fail = 0
  results.forEach(r => { if (r.status === 'fulfilled') ok++; else fail++; })
  console.log(`🏁 Replay complete: ok=${ok} fail=${fail}`)
  if (fail > 0) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
