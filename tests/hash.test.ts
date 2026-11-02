import { describe, it, expect } from 'vitest'
import { stableStringify, hash, NonSerializableError } from '../src/hash'

describe('stableStringify', () => {
  it('对象 key 顺序不影响结果', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })

  it('嵌套对象同样按 key 排序', () => {
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe(
      stableStringify({ z: { x: 2, y: 1 } }),
    )
  })

  it('数组顺序敏感', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it('区分 undefined 与缺失值的处理是稳定的', () => {
    expect(stableStringify({ a: undefined })).toBe(stableStringify({ a: undefined }))
  })

  it('遇到 FormData 抛 NonSerializableError', () => {
    expect(() => stableStringify({ fd: new FormData() })).toThrow(NonSerializableError)
  })

  it('遇到 Blob 抛 NonSerializableError', () => {
    expect(() => stableStringify({ b: new Blob(['x']) })).toThrow(NonSerializableError)
  })

  it('循环引用抛 NonSerializableError', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => stableStringify(a)).toThrow(NonSerializableError)
  })

  it('函数抛 NonSerializableError', () => {
    expect(() => stableStringify({ fn: () => 1 })).toThrow(NonSerializableError)
  })

  it('Map/Set 抛 NonSerializableError', () => {
    expect(() => stableStringify(new Map([['a', 1]]))).toThrow(NonSerializableError)
    expect(() => stableStringify(new Set([1]))).toThrow(NonSerializableError)
  })
})

describe('hash', () => {
  it('相同输入得到相同 hash', () => {
    expect(hash('hello')).toBe(hash('hello'))
  })

  it('不同输入大概率不同 hash', () => {
    expect(hash('hello')).not.toBe(hash('world'))
  })

  it('输出为 8 位 hex', () => {
    expect(hash('abc')).toMatch(/^[0-9a-f]{8}$/)
  })
})
