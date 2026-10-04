import { SEED_BRIDGE_JOBS } from './bridge-seed'
import type { BridgeJob } from './bridge-types'

// 廊桥许可独立存一份，和通用条目分开；机位台账通过服务层读这里的许可结论，不会各算各的。
const STORAGE_KEY = 'airport-ground-ops:bridge-permits'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): BridgeJob[] {
  const fallback = clone(SEED_BRIDGE_JOBS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as BridgeJob[]
    if (!Array.isArray(parsed)) {
      throw new Error('invalid bridge store')
    }
    return parsed
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: BridgeJob[] | null = null

export function listBridgeJobs(): BridgeJob[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveBridgeJobs(jobs: BridgeJob[]): void {
  cache = clone(jobs)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}

export function resetBridgeJobs(): BridgeJob[] {
  const jobs = clone(SEED_BRIDGE_JOBS)
  saveBridgeJobs(jobs)
  return jobs
}

export function bridgeStorageKey(): string {
  return STORAGE_KEY
}
