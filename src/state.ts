import type { ProjectStores } from './storage'

export interface ProjectState {
  projectCode: string
  stores: ProjectStores
  userId: string | number | null
  enabled: boolean
  ttl: number
  ready: Promise<void>
  userOp: Promise<void> | null
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
