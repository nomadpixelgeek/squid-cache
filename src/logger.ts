// src/logger.ts
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

export interface Logger {
  level: LogLevel
  error: (...args: any[]) => void
  warn: (...args: any[]) => void
  info: (...args: any[]) => void
  debug: (...args: any[]) => void
  child: (opts: { prefix?: string }) => Logger
}

function levelToNum(l: LogLevel) {
  return ({ silent: 99, error: 40, warn: 30, info: 20, debug: 10 } as const)[l]
}

function envLevel(): LogLevel {
  const raw = String(process.env.SQUID_CACHE_LOG_LEVEL || 'info').toLowerCase()
  return (['silent','error','warn','info','debug'].includes(raw) ? raw : 'info') as LogLevel
}

export function makeLogger(prefix?: string, level: LogLevel = envLevel()): Logger {
  const base = { level }
  const pfx = prefix ? `[${prefix}]` : ''

  function emit(min: LogLevel, method: 'error'|'warn'|'info'|'debug', args: any[]) {
    if (levelToNum(level) > levelToNum(min)) return
    // eslint-disable-next-line no-console
    console[method](`${pfx}`, ...args)
  }

  return {
    ...base,
    error: (...a) => emit('error','error',a),
    warn:  (...a) => emit('warn','warn',a),
    info:  (...a) => emit('info','info',a),
    debug: (...a) => emit('debug','debug',a),
    child: ({ prefix: childPfx }) => makeLogger([prefix, childPfx].filter(Boolean).join(' '), level),
  }
}
