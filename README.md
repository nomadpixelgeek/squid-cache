# `@nomadpixelgeek/squid-cache`

**Unified caching + automatic replay for Subsquid projects**

* Record raw input (blocks/logs/txs) in **gzipped NDJSON**.
* **Auto-use** cached inputs on normal runs when coverage is available (no manual replay step needed).
* Unified replay CLI for multi-project rebuilds (with `--fromBlock/--toBlock`).
* Cleaner CLI for retention (by days or total size).
* Multi-writer safe manifest updates (lightweight lock).


## Install

```bash
npm i @nomadpixelgeek/squid-cache
# or
yarn add @nomadpixelgeek/squid-cache
```

---

## Environment Variables

| Variable                              | Default         | Purpose                                                      |
| ------------------------------------- | --------------- | ------------------------------------------------------------ |
| `SQUID_CACHE_ROOT`                    | `./squid-cache` | Root directory for caches                                    |
| `SQUID_CACHE_MODE`                    | `record`        | `record` | `replay` | `off`                                  |
| `SQUID_CACHE_LOG_LEVEL`               | `info`          | `silent` | `error` | `warn` | `info` | `debug`               |
| `SQUID_CACHE_AUTO_USE`                | `off`           | `on` → try to auto-swap this batch with cached data          |
| `SQUID_CACHE_AUTO_REQUIRE_FULL_COVER` | `true`          | Require the entire `[min..max]` to be cached before swapping |
| `SQUID_CACHE_LOCK_TIMEOUT_MS`         | `5000`          | Lock wait time for manifest updates                          |
| `SQUID_CACHE_LOCK_TIMEOUT_MS`         | `30000`        | total time we'll wait before giving up|
| `SQUID_CACHE_LOCK_STALE_MS`           | `60000`        | consider a lock stale after 60s and remove it|
| `SQUID_CACHE_LOCK_BASE_DELAY_MS`      | `25`          | initial wait|
| `SQUID_CACHE_LOCK_BACKOFF_FACTOR`     | `1.5`         | exponential backoff|
| `SQUID_CACHE_LOCK_MAX_DELAY_MS`       | `500`         | cap per-iteration wait|
| `SQUID_CACHE_LOCK_JITTER_MS`          | `25`          | add 0..25ms random jitter|

---

## What’s New (Auto-Use Cache)

On each batch, the package can **automatically replace** the live `ctx.blocks` with cached blocks when it detects full coverage:

```ts
const cached = await recorder.autoSwapBlocks(ctx.blocks, log)
// If cached coverage is available, `cached` contains the blocks from cache.
// Otherwise, `cached === ctx.blocks`.
(ctx as any).blocks = cached
```

Enable it with:

```bash
export SQUID_CACHE_AUTO_USE=on
export SQUID_CACHE_AUTO_REQUIRE_FULL_COVER=true   # recommended
```

> Tip: In environments where you *only* want to read cache (no writes), set `SQUID_CACHE_MODE=replay`.

---

## Folder Layout

```
<SQUID_CACHE_ROOT>/<project>/<chain>/<configHash>/
  manifest.json
  manifest.json.lock    # multi-writer safe
  <YYYY-MM-DD>/
    <from>-<to>.ndjson.gz
```

---

## Quick Start (Recording + Auto-Use)

In your processor (e.g., `src/main.ts`):

```ts
import { makeRecorder, makeLogger } from '@nomadpixelgeek/squid-cache'

const logger = makeLogger('cache')

// Build this from your chain config (must match for replay/auto-swap)
const configIdentity = {
  finality: cfg.finality ?? 0,
  contracts: cfg.contractConfigs.map(c => ({
    address: c.address.toLowerCase(),
    from: c.from ?? 0,
    to: c.to ?? null,
    abiVer: `${c.abi}_${c.version}`,
  })),
}

const recorder = makeRecorder({
  project: 'events',
  chain: chainName,
  configIdentity,
  logger: logger.child({ prefix: `events/${chainName}` }),
})

proc.run(database, async (ctx) => {
  // 1) Auto-swap blocks from cache if coverage is available
  //    (requires SQUID_CACHE_AUTO_USE=on)
  ;(ctx as any).blocks = await recorder.autoSwapBlocks(ctx.blocks, logger)

  // 2) Optionally record this batch (skipped automatically in SQUID_CACHE_MODE=replay)
  await recorder.recordBatch(ctx.blocks)

  // 3) Your normal extraction + DB writes
  await extractAndPersist(ctx)
})
```

Recommended env in prod (recording + auto-use **off** by default):

```bash
export SQUID_CACHE_ROOT=/var/lib/squid-cache
export SQUID_CACHE_MODE=record
export SQUID_CACHE_LOG_LEVEL=info
# Turn on auto-use only where you want it:
# export SQUID_CACHE_AUTO_USE=on
# export SQUID_CACHE_AUTO_REQUIRE_FULL_COVER=true
```

---

## Unified Replay CLI (Optional)

You can still rebuild DBs offline without RPC using the unified CLI:

```bash
squid-cache-replay \
  --targets ./replay.targets.json \
  --concurrency 3 \
  --fromBlock 19000000 \
  --toBlock 19100000 \
  --projects events,analytics \
  --chains arbitrum,base
```

`replay.targets.json`:

```json
[
  {
    "project": "events",
    "chain": "arbitrum",
    "runner": "../events/dist/replayRunner.js",
    "configIdentity": {
      "finality": 0,
      "contracts": [
        { "address": "0xabc...", "from": 123, "to": null, "abiVer": "symmio_0_8_4" }
      ]
    }
  }
]
```

---

## Cache Cleaner CLI

Keep caches tidy:

```bash
# delete date folders older than 14 days
squid-cache-clean --days 14

# keep total under 500 GB
squid-cache-clean --max-bytes 536870912000

# scope to projects/chains
squid-cache-clean --days 21 --projects events,analytics --chains arbitrum,base

# dry run
squid-cache-clean --max-bytes 214748364800 --dry-run
```

---

## API Reference

### `makeRecorder(options) → Recorder`

**Options:**

* `project: string`
* `chain: string`
* `configIdentity: unknown` — object describing what you index (finality, contracts, abiVer…)
* `mode?: 'record' | 'replay' | 'off'` (default picks from `SQUID_CACHE_MODE`)
* `logger?: Logger` (optional)

**Recorder methods:**

* `recordBatch(blocks: any[]): Promise<void>`
  Writes a gzipped NDJSON with a small header, updates `manifest.json`.
  Skips automatically if `mode='replay'` or `mode='off'`.
* `listReplayFiles(): ReplayFile[]`
  Lists `{ absPath, minBlock, maxBlock }` from the manifest.
* `readFile(absPath: string): AsyncGenerator<SlimBlock[]>`
  Streams cached blocks from one file (skips header line).
* `autoSwapBlocks(liveBlocks: SlimBlock[], logger?): Promise<SlimBlock[]>`
  If `SQUID_CACHE_AUTO_USE=on` and **full coverage** (by default) exists for `[min..max]` of `liveBlocks`, returns **cached blocks** stitched and deduped. Otherwise returns `liveBlocks` unchanged.

**Types:**

* `SlimBlock` — minimal block shape the package stores/returns.
* `SlimLog`, `SlimTx` — minimal shapes for logs/txs.

---

## Multi-Writer Safety

Manifest updates are wrapped by an **advisory lock** (`manifest.json.lock`) with a configurable timeout:

```bash
export SQUID_CACHE_LOCK_TIMEOUT_MS=10000  # 10 seconds
```

If the lock can’t be acquired in time, an error is thrown (fail fast, avoid corruption).

---

## Logging

Set verbosity globally:

```bash
export SQUID_CACHE_LOG_LEVEL=debug
```

Typical messages (info/debug):

```
[squid-cache] [events/arbitrum@abcd…] cache root: /var/lib/squid-cache/events/arbitrum/abcd…
[squid-cache] [events/arbitrum@abcd…] mode=record → batches will be written
[squid-cache] [events/arbitrum@abcd…] cached batch 19000000-19000015 (42 logs)
[squid-cache] [events/arbitrum@abcd…] using cached input for events/arbitrum covering 19000000-19000015 from 1 file(s)
```

---

## End-to-End Example Flow

1. **Record live:** `SQUID_CACHE_MODE=record` while indexing.
2. **Auto-use** (optional): turn on `SQUID_CACHE_AUTO_USE=on` to prefer cache if a batch range is fully covered.
3. **Schema change?** Use `squid-cache-replay` (optionally with block range filters) to rebuild offline.
4. **Retention:** run `squid-cache-clean` weekly.

---

## 🧾 License

**MIT License**
Copyright © 2025
Published as [`@nomadpixelgeek/squid-cache`](https://www.npmjs.com/package/@nomadpixelgeek/squid-cache)