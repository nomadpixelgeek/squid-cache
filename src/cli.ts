#!/usr/bin/env node
/* eslint-disable no-console */
import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { makeRecorder, SlimBlock } from './index.ts'

type Target = {
  project: string                      // e.g., "events" | "analytics" | "vibe" | "symmioGeneral"
  chain: string                        // e.g., "arbitrum"
  runner: string                       // absolute or relative module path that exports replayBatch()
  configIdentity: unknown              // JSON-serializable identity used to select cache namespace
}

type Args = {
  targetsPath: string
  concurrency: number
  filterProjects: Set<string> | null
  filterChains: Set<string> | null
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    targetsPath: '',
    concurrency: Number(process.env.REPLAY_CONCURRENCY ?? 2),
    filterProjects: null,
    filterChains: null,
    dryRun: false,
  }

  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--targets' || k === '-t') a.targetsPath = argv[++i]
    else if (k === '--concurrency' || k === '-c') a.concurrency = Math.max(1, Number(argv[++i]))
    else if (k === '--projects' || k === '-p') a.filterProjects = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (k === '--chains' || k === '-n') a.filterChains = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (k === '--dry-run') a.dryRun = true
    else if (k === '--help' || k === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  if (!a.targetsPath) {
    console.error('Error: --targets <file.json> is required.')
    printHelp()
    process.exit(1)
  }
  return a
}

function printHelp() {
  console.log(`
Unified Squid Cache Replay

Usage:
  squid-cache-replay --targets ./replay.targets.json [--concurrency 3] [--projects events,analytics] [--chains arbitrum,base] [--dry-run]

Flags:
  -t, --targets       Path to JSON file with replay targets
  -c, --concurrency   Max concurrent replays (default: env REPLAY_CONCURRENCY or 2)
  -p, --projects      Comma-separated project filter
  -n, --chains        Comma-separated chain filter
      --dry-run       List what would run and exit

Environment:
  SQUID_CACHE_ROOT    Root directory for cache (shared by all projects)
  SQUID_CACHE_MODE    Should be "replay" for this CLI (but CLI forces replay internally)
  REPLAY_CONCURRENCY  Default concurrency if not passed as a flag
`)
}

function readTargets(p: string): Target[] {
  const abs = path.resolve(p)
  const raw = fs.readFileSync(abs, 'utf8')
  const arr = JSON.parse(raw)
  if (!Array.isArray(arr)) throw new Error('targets JSON must be an array of {project, chain, runner, configIdentity}')
  return arr
}

type RunnerModule = {
  // REQUIRED: invoked once per cached batch (file) of blocks
  replayBatch: (project: string, chain: string, blocks: SlimBlock[]) => Promise<void>
}

async function dynImportRunner(modPath: string): Promise<RunnerModule> {
  // Support relative paths from cwd or from this file
  const abs = path.isAbsolute(modPath) ? modPath : path.resolve(process.cwd(), modPath)
  const url = pathToFileURL(abs).href
  const mod = await import(url)
  if (typeof mod.replayBatch !== 'function') {
    throw new Error(`Runner ${modPath} must export async function replayBatch(project, chain, blocks)`)
  }
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
      const p = task().finally(() => {
        running--
        runNext()
      })
      running++
      results.push(p)
    }
  }

  runNext()
  return Promise.allSettled(results)
}

async function runTarget(t: Target) {
  const rec = makeRecorder({
    project: t.project,
    chain: t.chain,
    configIdentity: t.configIdentity,
    mode: 'replay',
  })
  const files = rec.listReplayFiles()
  if (!files.length) {
    console.log(`ℹ️  No cache for ${t.project}/${t.chain}@${rec.configHash} — skipping`)
    return
  }

  const runner = await dynImportRunner(t.runner)

  console.log(`🔁 Replaying ${files.length} file(s) for ${t.project}/${t.chain} (hash ${rec.configHash})`)

  // Iterate every cached file -> every file yields one array of blocks
  for (const f of files) {
    for await (const blocks of rec.readFile(f.absPath)) {
      // Delegate DB work to the project-specific runner
      await runner.replayBatch(t.project, t.chain, blocks)
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
    for (const t of targets) {
      console.log(`Would replay -> project=${t.project} chain=${t.chain} runner=${t.runner}`)
    }
    return
  }

  console.log(`▶️  Starting unified replay for ${targets.length} target(s) with concurrency=${args.concurrency}`)
  const tasks = targets.map(t => () => runTarget(t))
  const results = await limitConcurrency(args.concurrency, tasks)

  let ok = 0, fail = 0
  results.forEach(r => { if (r.status === 'fulfilled') ok++; else fail++; })
  console.log(`🏁 Replay complete: ok=${ok} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
