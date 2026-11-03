/**
 * 项目状态注册表。
 *
 * cacheRequest 初始化后在此登记项目的全部运行时状态，adapter 与
 * setUserId/clearCache 等全局方法通过 projectCode 取回状态，
 * 业务方因此无需保存 cacheRequest 的返回值。
 */
import type { ProjectStores } from './storage'

export interface ProjectState {
  projectCode: string
  stores: ProjectStores
  userId: string | number | null // 参与缓存 key，切换账号时清缓存
  enabled: boolean // IndexedDB 不可用等情况下降级为 false，全部请求透传
  ttl: number // 0 表示永久
  ignoreParams: string[] // 全局忽略参数
  ready: Promise<void> // 初始化（DB 打开 + 版本校验）完成
  userOp: Promise<void> | null // 进行中的 setUserId/清缓存操作，请求需等待
}

const states = new Map<string, ProjectState>()

export function registerState(state: ProjectState): void {
  states.set(state.projectCode, state)
}

export function getState(projectCode: string): ProjectState {
  const state = states.get(projectCode)
  if (!state) throw new Error(`cache-request not initialized for project: ${projectCode}`)
  return state
}
