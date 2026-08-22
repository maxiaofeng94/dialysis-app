import { localRepository } from './localRepository'
import { cloudRepository } from '../lib/cloudRepository'
import { isCloudConfigured } from '../lib/supabase'
import { isLoggedIn } from '../stores/auth'
import type { Repository } from './repository'

/** 云端已配置且已登录 → 用云端仓储；否则用本地仓储 */
function activeRepository(): Repository {
  return isCloudConfigured && isLoggedIn.value ? cloudRepository : localRepository
}

// 动态分发代理：既有代码 import { repository } 不变，方法调用按登录态自动切换本地/云端
export const repository: Repository = new Proxy({} as Repository, {
  get(_target, prop: keyof Repository) {
    const repo = activeRepository()
    const value = (repo as unknown as Record<string, unknown>)[prop]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(repo) : value
  },
}) as Repository

export type { Repository }
