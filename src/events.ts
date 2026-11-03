/**
 * diff 事件订阅：静默刷新发现新旧响应数据 hash 不一致时，通知所有订阅者。
 */
import type { CacheDiffEvent } from './types'

type Listener = (event: CacheDiffEvent) => void
const listeners = new Set<Listener>()

/** 订阅差异事件，返回取消订阅函数 */
export function onDiff(listener: Listener): () => void {
  listeners.add(listener)
  return () => offDiff(listener)
}

/** 取消订阅 */
export function offDiff(listener: Listener): void {
  listeners.delete(listener)
}

/** 触发差异事件。单个订阅回调抛错不影响其他订阅者与缓存主流程 */
export function emitDiff(event: CacheDiffEvent): void {
  listeners.forEach((listener) => {
    try {
      listener(event)
    } catch {
      /* 隔离订阅者错误 */
    }
  })
}
