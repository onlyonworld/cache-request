export class NonSerializableError extends Error {
  constructor(message = 'value is not stably serializable') {
    super(message)
    this.name = 'NonSerializableError'
  }
}

type Seen = WeakSet<object>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isUnsupported(value: unknown): boolean {
  const g = globalThis as Record<string, unknown>
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true
  if (typeof File !== 'undefined' && value instanceof File) return true
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return true
  void g
  return false
}

function stringifyValue(value: unknown, seen: Seen): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'number' || t === 'boolean') return String(value)
  if (t === 'bigint') return `bigint:${(value as bigint).toString()}`
  if (t === 'function' || t === 'symbol') throw new NonSerializableError()

  const obj = value as object
  if (isUnsupported(value)) throw new NonSerializableError()
  if (!isPlainObject(value) && !Array.isArray(value)) {
    // Date / Map / Set / RegExp / DOM 节点等一律拒绝
    throw new NonSerializableError()
  }
  if (seen.has(obj)) throw new NonSerializableError('circular reference')
  seen.add(obj)

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyValue(item, seen)).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stringifyValue(value[k], seen)}`)
    .join(',')}}`
}

export function stableStringify(value: unknown): string {
  return stringifyValue(value, new WeakSet())
}

export function hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
