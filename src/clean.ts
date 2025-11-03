// src/clean.ts
// #!/usr/bin/env node
/* eslint-disable no-console */
import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'

type Args = {
  root: string
  days?: number
  maxBytes?: number
  filterProjects: Set<string> | null
  filterChains: Set<string> | null
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    root: process.env.SQUID_CACHE_ROOT || path.join(process.cwd(), 'squid-cache'),
    filterProjects: null,
    filterChains: null,
    dryRun: false
  }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--root') a.root = argv[++i]
    else if (k === '--days') a.days = Number(argv[++i])
    else if (k === '--max-bytes') a.maxBytes = Number(argv[++i])
    else if (k === '--projects' || k === '-p') a.filterProjects = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (k === '--chains'   || k === '-n') a.filterChains = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean))
    else if (k === '--dry-run') a.dryRun = true
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0) }
  }
  if (a.days == null && a.maxBytes == null) {
    console.error('Error: specify --days or --max-bytes'); printHelp(); process.exit(1)
  }
  return a
}

function printHelp() {
  console.log(`
squid-cache-clean
Prune cache by age (days) or total size.

Usage:
  squid-cache-clean [--root <dir>] (--days N | --max-bytes N)
                    [--projects events,analytics] [--chains arbitrum,base] [--dry-run]

Examples:
  # delete date folders older than 14 days
  squid-cache-clean --days 14

  # keep under 200 GB total (delete oldest date folders first)
  squid-cache-clean --max-bytes 214748364800
`)
}

function isDateFolder(name: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name)
}

function dirSizeBytes(p: string): number {
  let total = 0
  const entries = safeReaddir(p)
  for (const e of entries) {
    const full = path.join(p, e)
    const st = safeStat(full)
    if (!st) continue
    if (st.isDirectory()) total += dirSizeBytes(full)
    else total += st.size
  }
  return total
}

function safeReaddir(p: string) {
  try { return fs.readdirSync(p) } catch { return [] }
}
function safeStat(p: string) {
  try { return fs.lstatSync(p) } catch { return null }
}
function rmrf(p: string) {
  fs.rmSync(p, { recursive: true, force: true })
}

function pruneByDays(root: string, days: number, filters: { projects: Set<string>|null, chains: Set<string>|null }, dryRun: boolean) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  let removed = 0
  for (const project of safeReaddir(root)) {
    if (filters.projects && !filters.projects.has(project)) continue
    const pPath = path.join(root, project)
    for (const chain of safeReaddir(pPath)) {
      if (filters.chains && !filters.chains.has(chain)) continue
      const cPath = path.join(pPath, chain)
      for (const hash of safeReaddir(cPath)) {
        const hPath = path.join(cPath, hash)
        for (const day of safeReaddir(hPath)) {
          if (!isDateFolder(day)) continue
          const dPath = path.join(hPath, day)
          const st = safeStat(dPath); if (!st) continue
          const ts = new Date(day + 'T00:00:00Z').getTime()
          if (isNaN(ts) || ts > cutoff) continue
          console.log(`delete (age): ${dPath}`)
          if (!dryRun) rmrf(dPath)
          removed++
        }
      }
    }
  }
  console.log(`Pruned by days: ${removed} folder(s)`)
}

function totalSize(root: string, filters: { projects: Set<string>|null, chains: Set<string>|null }) {
  let sum = 0
  for (const project of safeReaddir(root)) {
    if (filters.projects && !filters.projects.has(project)) continue
    const pPath = path.join(root, project)
    for (const chain of safeReaddir(pPath)) {
      if (filters.chains && !filters.chains.has(chain)) continue
      const cPath = path.join(pPath, chain)
      for (const hash of safeReaddir(cPath)) {
        const hPath = path.join(cPath, hash)
        sum += dirSizeBytes(hPath)
      }
    }
  }
  return sum
}

function collectDateFolders(root: string, filters: { projects: Set<string>|null, chains: Set<string>|null }) {
  // return list of {path, date} sorted oldest first
  const items: { path: string; date: number }[] = []
  for (const project of safeReaddir(root)) {
    if (filters.projects && !filters.projects.has(project)) continue
    const pPath = path.join(root, project)
    for (const chain of safeReaddir(pPath)) {
      if (filters.chains && !filters.chains.has(chain)) continue
      const cPath = path.join(pPath, chain)
      for (const hash of safeReaddir(cPath)) {
        const hPath = path.join(cPath, hash)
        for (const day of safeReaddir(hPath)) {
          if (!isDateFolder(day)) continue
          const dPath = path.join(hPath, day)
          const ts = new Date(day + 'T00:00:00Z').getTime()
          if (!isNaN(ts)) items.push({ path: dPath, date: ts })
        }
      }
    }
  }
  items.sort((a, b) => a.date - b.date)
  return items
}

function pruneBySize(root: string, maxBytes: number, filters: { projects: Set<string>|null, chains: Set<string>|null }, dryRun: boolean) {
  let current = totalSize(root, filters)
  console.log(`Current size: ${current} bytes; target <= ${maxBytes} bytes`)
  if (current <= maxBytes) { console.log('No action needed.'); return }
  const folders = collectDateFolders(root, filters)
  let removed = 0
  for (const item of folders) {
    const sz = dirSizeBytes(item.path)
    console.log(`delete (size): ${item.path} ~${sz} bytes`)
    if (!dryRun) rmrf(item.path)
    current -= sz
    removed++
    if (current <= maxBytes) break
  }
  console.log(`Pruned by size: ${removed} folder(s); new est. size ~${current} bytes`)
}

async function main() {
  const args = parseArgs(process.argv)
  console.log(`Root: ${args.root}; dry-run=${args.dryRun ? 'yes' : 'no'}`)
  const filters = { projects: args.filterProjects, chains: args.filterChains }
  if (args.days != null) pruneByDays(args.root, args.days, filters, args.dryRun)
  if (args.maxBytes != null) pruneBySize(args.root, args.maxBytes, filters, args.dryRun)
}
main().catch(e => { console.error(e); process.exit(1) })
