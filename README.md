# 🧰 `@nomadpixelgeek/squid-cache`

**Unified caching and replay system for Subsquid-based projects**
*(Supports: multi-project, multi-chain, concurrent writers, replay filtering, retention management.)*

---

## 📖 Overview

`@nomadpixelgeek/squid-cache` lets you:

* **Record** every block/log batch processed by your Subsquid indexers.
* **Cache** them locally (or on shared storage).
* **Replay** them later to rebuild or test database schemas — *without fetching from RPC*.
* **Clean** old or oversized caches automatically.
* **Safely share** caches across multiple concurrent writers with a built-in lock.

---

## 🧱 Folder Layout

Cache files are organized by:

```
<SQUID_CACHE_ROOT>/<project>/<chain>/<configHash>/<YYYY-MM-DD>/<from>-<to>.ndjson.gz
```

Each namespace (combination of project/chain/config) has its own:

```
manifest.json         # index of cached batches
manifest.json.lock    # safe write lock for multi-writer setups
```

---

## ⚙️ Environment Variables

| Variable                      | Default         | Description                                                |
| ----------------------------- | --------------- | ---------------------------------------------------------- |
| `SQUID_CACHE_ROOT`            | `./squid-cache` | Root directory for all cache data                          |
| `SQUID_CACHE_MODE`            | `record`        | `record`, `replay`, or `off`                               |
| `SQUID_CACHE_LOG_LEVEL`       | `info`          | Log verbosity (`silent`, `error`, `warn`, `info`, `debug`) |
| `SQUID_CACHE_LOCK_TIMEOUT_MS` | `5000`          | Timeout for manifest lock acquisition (ms)                 |

---

## 🚀 Installation

```bash
npm install @nomadpixelgeek/squid-cache
```

or

```bash
yarn add @nomadpixelgeek/squid-cache
```

---

## 🪄 Recording Flow (Live Mode)

Use this in **live processors** to capture all EVM batches.

```ts
import { makeRecorder } from '@nomadpixelgeek/squid-cache'

// Create the recorder once per chain
const recorder = makeRecorder({
  project: 'events',             // your project name
  chain: 'arbitrum',             // network name
  configIdentity: {              // what defines your current dataset
    finality: 0,
    contracts: cfg.contractConfigs.map(c => ({
      address: c.address.toLowerCase(),
      from: c.from ?? 0,
      to: c.to ?? null,
      abiVer: `${c.abi}_${c.version}`,
    })),
  },
})

// inside proc.run(...)
await recorder.recordBatch(ctx.blocks)
```

### Run in record mode

```bash
export SQUID_CACHE_MODE=record
export SQUID_CACHE_ROOT=/var/lib/squid-cache
export SQUID_CACHE_LOG_LEVEL=info

yarn start
```

**Logs you’ll see:**

```
cache root: /var/lib/squid-cache/events/arbitrum/abcd1234
mode=record → batches will be written
cached batch 19000000-19000015 (42 logs)
```

---

## 🔁 Replay Flow (Offline Mode)

Replay previously cached input batches to rebuild the DB (no RPC needed).

### 1. Project-level replay script

Each project (e.g., `events`, `analytics`) defines:

```ts
import { makeRecorder } from '@nomadpixelgeek/squid-cache'
import { replayBatch } from './replayRunner'

const rec = makeRecorder({
  project: 'events',
  chain: 'arbitrum',
  configIdentity: { finality: 0, contracts: [/* ... */] },
  mode: 'replay',
})

const files = rec.listReplayFiles()
for (const f of files) {
  for await (const blocks of rec.readFile(f.absPath)) {
    await replayBatch('events', 'arbitrum', blocks)
  }
}
```

Run it:

```bash
export SQUID_CACHE_MODE=replay
node dist/replay.js
```

---

## 🧩 Unified Replay CLI (Multi-project orchestration)

### 1️⃣ Create `replay.targets.json`

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
  },
  {
    "project": "analytics",
    "chain": "base",
    "runner": "../analytics/dist/replayRunner.js",
    "configIdentity": {
      "finality": 0,
      "contracts": [
        { "address": "0xdef...", "from": 456, "to": null, "abiVer": "symmio_0_8_3" }
      ]
    }
  }
]
```

### 2️⃣ Run CLI

```bash
export SQUID_CACHE_ROOT=/var/lib/squid-cache
export SQUID_CACHE_MODE=replay

# Replay all
squid-cache-replay --targets ./replay.targets.json

# Replay with concurrency
squid-cache-replay --targets ./replay.targets.json --concurrency 3

# Replay filtered by project/chain
squid-cache-replay --targets ./replay.targets.json --projects events --chains arbitrum

# Replay a block range
squid-cache-replay --targets ./replay.targets.json --fromBlock 19000000 --toBlock 19100000

# Dry run
squid-cache-replay --targets ./replay.targets.json --dry-run
```

---

## 🧼 Cache Cleaning CLI

`@nomadpixelgeek/squid-cache` includes a built-in cleaner to manage cache size and age.

### 🧽 Delete caches older than N days

```bash
squid-cache-clean --days 14
```

### 🧹 Keep total under a size limit

```bash
squid-cache-clean --max-bytes 536870912000   # 500 GB
```

### 🕹️ Filter by project/chain

```bash
squid-cache-clean --days 14 --projects events,analytics --chains arbitrum,base
```

### 🧪 Dry-run mode

```bash
squid-cache-clean --max-bytes 214748364800 --dry-run
```

### CLI Summary

| Flag                      | Description                           |
| ------------------------- | ------------------------------------- |
| `--root <dir>`            | Override cache root                   |
| `--days <n>`              | Delete date folders older than N days |
| `--max-bytes <n>`         | Keep total size under N bytes         |
| `--projects` / `--chains` | Filter by project/chain               |
| `--dry-run`               | Show actions but don’t delete         |

---

## 🔐 Manifest Locking

To prevent corruption when **multiple processors write to the same namespace**,
`manifest.json` updates are now serialized via `manifest.json.lock`.

### Behavior

* Each write operation tries to create `manifest.json.lock` exclusively.
* If it exists, another writer waits (default timeout = 5s).
* The lock is automatically deleted after each update.

```bash
export SQUID_CACHE_LOCK_TIMEOUT_MS=10000  # optional, 10 seconds
```

### What it looks like

```
manifest.json
manifest.json.lock   # temporary while one writer updates
```

If timeout is reached:

```
Timeout acquiring manifest lock: /cache/events/arbitrum/abcd1234/manifest.json.lock
```

---

## 🧠 Recommended Workflow

| Situation                       | What to do                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- |
| **Normal live indexing**        | Set `SQUID_CACHE_MODE=record`. All batches will be cached while processing. |
| **Schema migration or rebuild** | Set `SQUID_CACHE_MODE=replay` and run replay (project or unified CLI).      |
| **Multiple chains/projects**    | Add all to `replay.targets.json` and run unified CLI with concurrency.      |
| **Cache too large**             | Run `squid-cache-clean --days N` or `--max-bytes`.                          |
| **Sharded processors**          | Locking ensures safe manifest updates automatically.                        |

---

## 🧾 Typical Directory Example

```
/var/lib/squid-cache/
├── events/
│   └── arbitrum/
│       └── 4a1cdefd1290abcd/
│           ├── manifest.json
│           ├── manifest.json.lock
│           ├── 2025-10-31/
│           │   ├── 19000000-19000015.ndjson.gz
│           │   ├── 19000016-19000030.ndjson.gz
│           └── 2025-11-01/
│               └── 19000031-19000045.ndjson.gz
├── analytics/
│   └── base/
│       └── 09ab1234def98765/
│           ├── manifest.json
│           └── 2025-10-31/
│               ├── 12000000-12000020.ndjson.gz
│               └── ...
```

---

## 🪵 Logging Examples

### `SQUID_CACHE_LOG_LEVEL=info`

```
[squid-cache] [events/arbitrum@4a1cdefd1290abcd] mode=record → batches will be written
[squid-cache] [events/arbitrum@4a1cdefd1290abcd] cached batch 19000000-19000015 (42 logs)
[squid-cache] [events/arbitrum@4a1cdefd1290abcd] replay index: 128 file(s) available
```

### `SQUID_CACHE_LOG_LEVEL=debug`

```
[squid-cache] [events/arbitrum@4a1cdefd1290abcd] writing batch 19000000-19000015 → .../2025-11-01/19000000-19000015.ndjson.gz
[squid-cache] [events/arbitrum@4a1cdefd1290abcd] loaded 16 blocks from 19000000-19000015.ndjson.gz
```

---

## 🧩 Package Summary

| Component                 | Description                                               | Binary / Entry                |
| ------------------------- | --------------------------------------------------------- | ----------------------------- |
| `makeRecorder()`          | Creates cache recorder for recording or replaying batches | via `import { makeRecorder }` |
| `squid-cache-replay`      | Unified replay CLI for multiple projects/chains           | `./dist/cli.js`               |
| `squid-cache-clean`       | Cache retention & cleaning CLI                            | `./dist/clean.js`             |
| `manifest lock`           | Automatic cross-process safety                            | Built-in                      |
| `--fromBlock / --toBlock` | Replay subset of cached data                              | Added to CLI                  |
| `SQUID_CACHE_LOG_LEVEL`   | Global verbosity control                                  | Built-in                      |

---

## 🏁 Example End-to-End Workflow

1️⃣ **Record**

```bash
export SQUID_CACHE_MODE=record
yarn start
```

2️⃣ **Schema changes** → rebuild DB offline:

```bash
export SQUID_CACHE_MODE=replay
squid-cache-replay --targets ./replay.targets.json
```

3️⃣ **Trim cache weekly**

```bash
squid-cache-clean --days 30
```

4️⃣ **Monitor logs**

```bash
export SQUID_CACHE_LOG_LEVEL=info
tail -f processor.log | grep squid-cache
```

---

## 🧾 License

**MIT License**
Copyright © 2025
Published as [`@nomadpixelgeek/squid-cache`](https://www.npmjs.com/package/@nomadpixelgeek/squid-cache)

---

Would you like me to append a **“Quick Start Example Repo Structure”** section (showing an example monorepo layout with the `squid-cache` package + 2 projects like `events` and `analytics`)? It helps teams onboard faster.
