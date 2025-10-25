// src/hashing.ts
import * as crypto from 'crypto'
export function stableHash16(obj: unknown) {
  const h = crypto.createHash('sha256')
  h.update(JSON.stringify(obj))
  return h.digest('hex').slice(0, 16)
}
