/**
 * repository（src/repo/index.ts）动态分发代理测试
 *
 * 三个依赖全部替换成桩：supabase（云端是否配置）、localRepository、cachedRepository、stores/auth。
 * 做法说明（与「两种登录态用 vi.resetModules + 动态 import」的取舍）：
 *   `src/repo/index.ts` 的分发发生在**每次属性访问**时（activeRepository()），不是模块加载时；
 *   所以这里把 `isCloudConfigured` 做成 getter、`isLoggedIn` 做成可变 ref，
 *   直接切状态即可，比 resetModules 更贴近真实运行期行为（登录态变化不会重载模块）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fakeSupabaseModule } from '../helpers/cloud'
import { makePatient } from '../helpers/factories'

/** 记录每次方法调用的 this 与参数，用于断言 bind 到了哪个仓储 */
interface CallRecord {
  method: string
  thisArg: unknown
  args: unknown[]
}

const hoisted = vi.hoisted(() => {
  const METHODS = [
    'getPatient',
    'savePatient',
    'listDryWeights',
    'saveDryWeight',
    'deleteDryWeight',
    'listSessions',
    'getSession',
    'saveSession',
    'deleteSession',
    'listBloodPressures',
    'saveBloodPressure',
    'deleteBloodPressure',
    'listBloodGlucoses',
    'saveBloodGlucose',
    'deleteBloodGlucose',
    'listBloodFlows',
    'saveBloodFlow',
    'deleteBloodFlow',
    'listAdverseReactions',
    'replaceAdverseReactions',
    'exportAll',
    'importAll',
  ] as const

  /** 造一个仓储桩：所有方法都记录 this/args，并返回接口约定的默认值 */
  function makeRepoStub() {
    const calls: CallRecord[] = []
    const stub: Record<string, unknown> = {}
    for (const m of METHODS) {
      stub[m] = vi.fn(function (this: unknown, ...args: unknown[]) {
        calls.push({ method: m, thisArg: this, args })
        if (m === 'getPatient' || m === 'getSession') return Promise.resolve(undefined)
        if (m === 'exportAll') return Promise.resolve('{"version":1}')
        if (m.startsWith('list')) return Promise.resolve([])
        return Promise.resolve(undefined)
      })
    }
    return { stub, calls }
  }

  const local = makeRepoStub()
  const cached = makeRepoStub()

  return {
    localRepo: local.stub,
    localCalls: local.calls,
    cachedRepo: cached.stub,
    cachedCalls: cached.calls,
    /** 运行期可切换的开关 */
    isLoggedIn: { value: false } as { value: boolean },
    cloudConfigured: false,
    reset() {
      local.calls.length = 0
      cached.calls.length = 0
      for (const fn of Object.values(local.stub)) (fn as { mockClear: () => void }).mockClear()
      for (const fn of Object.values(cached.stub)) (fn as { mockClear: () => void }).mockClear()
      this.isLoggedIn.value = false
      this.cloudConfigured = false
    },
  }
})

vi.mock('../../src/lib/supabase', () => {
  const mod = fakeSupabaseModule({ configure: true })
  // isCloudConfigured 做成 getter：模拟「构建期固定、测试中可变」的项目配置开关
  Object.defineProperty(mod, 'isCloudConfigured', {
    get: () => hoisted.cloudConfigured,
    configurable: true,
    enumerable: true,
  })
  return mod
})

vi.mock('../../src/repo/localRepository', () => ({ localRepository: hoisted.localRepo }))
vi.mock('../../src/repo/cachedRepository', () => ({ cachedCloudRepository: hoisted.cachedRepo }))
// isLoggedIn 是 computed ref，repo/index.ts 只读 .value → 用普通对象即可
vi.mock('../../src/stores/auth', () => ({ isLoggedIn: hoisted.isLoggedIn }))

import { repository } from '../../src/repo/index'

beforeEach(() => {
  hoisted.reset()
})

describe('repository · 分发规则', () => {
  it('云端未配置（纯本地单机模式）→ 命中 localRepository', async () => {
    hoisted.cloudConfigured = false
    hoisted.isLoggedIn.value = false

    await repository.getPatient('p1')

    expect(hoisted.localCalls.map((c) => c.method)).toEqual(['getPatient'])
    expect(hoisted.localCalls[0].args).toEqual(['p1'])
    expect(hoisted.cachedCalls).toEqual([])
  })

  it('云端已配置且已登录 → 命中 cachedCloudRepository', async () => {
    hoisted.cloudConfigured = true
    hoisted.isLoggedIn.value = true

    await repository.listSessions('p1')

    expect(hoisted.cachedCalls.map((c) => c.method)).toEqual(['listSessions'])
    expect(hoisted.cachedCalls[0].args).toEqual(['p1'])
    expect(hoisted.localCalls).toEqual([])
  })

  it('云端已配置但未登录 → 仍走 localRepository', async () => {
    hoisted.cloudConfigured = true
    hoisted.isLoggedIn.value = false

    await repository.getPatient('p1')

    expect(hoisted.localCalls.map((c) => c.method)).toEqual(['getPatient'])
    expect(hoisted.cachedCalls).toEqual([])
  })

  it('未配置云端时即便 isLoggedIn 意外为 true 也只走本地（isCloudConfigured 优先）', async () => {
    hoisted.cloudConfigured = false
    hoisted.isLoggedIn.value = true

    await repository.getPatient('p1')

    expect(hoisted.localCalls.map((c) => c.method)).toEqual(['getPatient'])
    expect(hoisted.cachedCalls).toEqual([])
  })

  it('每次调用都重新判断登录态：同一 repository 对象可在本地/云端之间切换', async () => {
    hoisted.cloudConfigured = true
    hoisted.isLoggedIn.value = false
    await repository.getPatient('p1')

    hoisted.isLoggedIn.value = true
    await repository.getPatient('p1')

    hoisted.isLoggedIn.value = false
    await repository.getPatient('p1')

    expect(hoisted.localCalls.map((c) => c.method)).toEqual(['getPatient', 'getPatient'])
    expect(hoisted.cachedCalls.map((c) => c.method)).toEqual(['getPatient'])
  })
})

describe('repository · 方法与返回值透传', () => {
  it('方法被 bind 到实际生效的仓储上（this 指向该仓储桩本身）', async () => {
    hoisted.cloudConfigured = false
    await repository.savePatient(makePatient({ id: 'p1' }))
    expect(hoisted.localCalls[0].thisArg).toBe(hoisted.localRepo)

    hoisted.cloudConfigured = true
    hoisted.isLoggedIn.value = true
    await repository.savePatient(makePatient({ id: 'p2' }))
    expect(hoisted.cachedCalls[0].thisArg).toBe(hoisted.cachedRepo)
  })

  it('参数原样透传（多个参数、对象参数）', async () => {
    const patient = makePatient({ id: 'p1' })

    await repository.savePatient(patient)

    expect(hoisted.localCalls[0].args).toEqual([patient])
  })

  it('返回值（含 promise 结果）原样返回', async () => {
    hoisted.cloudConfigured = true
    hoisted.isLoggedIn.value = true
    ;(hoisted.cachedRepo.listSessions as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce([
      { id: 's1' },
    ])

    await expect(repository.listSessions('p1')).resolves.toEqual([{ id: 's1' }])
  })

  it('写操作的拒绝也会原样向上抛（不被代理吞掉）', async () => {
    ;(hoisted.localRepo.savePatient as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error('本地写失败'),
    )

    await expect(repository.savePatient(makePatient())).rejects.toThrow('本地写失败')
  })

  it('未在桩上定义的方法返回 undefined，而不是抛错', () => {
    const unknownRepo = repository as unknown as Record<string, unknown>
    expect(unknownRepo.不存在的属性).toBeUndefined()
  })
})
