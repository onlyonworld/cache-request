/**
 * 稳定序列化与 hash 工具（零依赖、同步实现）。
 *
 * stableStringify：与 JSON.stringify 的关键区别——普通对象的 key 按字典序
 * 排序，使参数书写顺序不影响缓存 key；数组顺序保持不变（顺序本身是参数
 * 语义的一部分）。无法保证序列化结果唯一的类型（FormData/File/Blob、
 * 函数/Symbol、Map/Set/Date 等）以及循环引用一律抛出 NonSerializableError，
 * 由 adapter 捕获后对该请求透传不缓存。
 *
 * hash：djb2 变体，输出 8 位 hex。同步执行（Web Crypto 的 digest 为异步，
 * 不适合在 adapter 内同步计算 key）。
 */

export class NonSerializableError extends Error {
  constructor(message = 'value is not stably serializable') {
    super(message)
    this.name = 'NonSerializableError'
  }
}

/** 是否为普通对象（原型为 Object.prototype 或 null），类实例不算 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 检测无法结构化克隆/序列化的浏览器对象 */
function isUnsupported(value: unknown): boolean {
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true
  if (typeof File !== 'undefined' && value instanceof File) return true
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true
  // 所有 TypedArray（Uint8Array 等）拒绝；DataView 本身可视为普通视图，保持原有判定
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return true
  return false
}

/**
 * 递归序列化。seen 只记录当前递归路径上的祖先对象，用于检测真正的环；
 * 处理完当前对象后从 seen 移除，因此菱形共享引用（{a: o, b: o}）不会被
 * 误判为循环引用。
 */
function stringifyValue(value: unknown, seen: Set<object>): string {
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

  // 当前祖先链上已存在该对象：真正的循环引用
  if (seen.has(obj)) throw new NonSerializableError('circular reference')
  seen.add(obj)

  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stringifyValue(item, seen)).join(',')}]`
    }

    // 对象含 Symbol key：Object.keys 会跳过它们，若放行会导致不同对象
    // 序列化结果碰撞，因此直接拒绝
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new NonSerializableError()
    }

    // key 排序后递归：消除参数书写顺序的影响
    const keys = Object.keys(value).sort()
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stringifyValue(value[k], seen)}`)
      .join(',')}}`
  } finally {
    // 退出当前子树：允许同一对象在其他分支（菱形引用）再次出现
    seen.delete(obj)
  }
}

export function stableStringify(value: unknown): string {
  return stringifyValue(value, new Set())
}

/** djb2 hash：`h * 33 + c`（左移 5 位即乘 32 再加 h），|0 保持 32 位整数 */
export function hash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  // >>>0 转无符号；padStart 保证固定 8 位
  return (h >>> 0).toString(16).padStart(8, '0')
}
