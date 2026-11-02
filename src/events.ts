import type { CacheDiffEvent } from './types'

type Listener = (event: CacheDiffEvent) => void
const listeners = new Set<Listener>()

export function onDiff(listener: Listener): () => void {
  listeners.add(listener)
  return () => offDiff(listener)
}

export function offDiff(listener: Listener): void {
  listeners.delete(listener)
}

export function emitDiff(event: CacheDiffEvent): void {
  listeners.forEach((listener) => {
    try {
      listener(event)
    } catch {
      /* 隔离订阅者错误 */
    }
  })
}
