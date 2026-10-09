/**
 * src/stores/patient.ts 单元测试
 *
 * 这个 store 是「当前是谁的病人」的唯一来源，出错的后果是显示别人的病历，
 * 因此重点覆盖：
 * 1. 本地模式的防护：绝不能读到云端遗留的 localStorage 值；
 * 2. 云端模式下的校准：换账号 / 被移出成员后要自动落到第一个可访问的病人；
 * 3. 所有失败路径（listMyPatients 抛错）都不能把人卡死。
 *
 * 注意：模块级的 `isNative` 在导入时就定了（jsdom 下 Capacitor 判定为 web），
 * 所以这里断言的是 localStorage 分支。
 */
import { describe, it, expect, vi } from 'vitest'
import { makePatient } from '../helpers/factories'
import { fakeSupabaseModule } from '../helpers/cloud'

const STORAGE_KEY = 'dialysis.currentPatientId'
const DEFAULT_ID = 'patient-default'

interface LoadOptions {
  /** 是否配置云端（决定 restorePatientId / ensureCloudPatient 的分支） */
  configured?: boolean
  /** listMyPatients 的实现 */
  list?: () => Promise<{ patient: ReturnType<typeof makePatient>; role: string }[]>
}

/** 装载一份全新的 patient store（lib/cloudAdmin 被替换成间谍） */
async function loadPatient(opts: LoadOptions = {}) {
  const listMyPatients = vi.fn(opts.list ?? (async () => []))
  vi.doMock('../../src/lib/supabase', () => fakeSupabaseModule({ configure: opts.configured ?? true, client: {} }))
  vi.doMock('../../src/lib/cloudAdmin', () => ({ listMyPatients }))
  vi.resetModules()
  const mod = await import('../../src/stores/patient')
  return { mod, listMyPatients }
}

/** 造一条「我的病人」列表项 */
function item(id: string, role = 'owner') {
  return { patient: makePatient({ id }), role }
}

describe('currentPatientId 初始值', () => {
  it('默认为 DEFAULT_PATIENT_ID', async () => {
    const { mod } = await loadPatient()
    expect(mod.currentPatientId.value).toBe(DEFAULT_ID)
  })
})

describe('setCurrentPatientId', () => {
  it('立即改内存值并写入 localStorage', async () => {
    const { mod } = await loadPatient()

    mod.setCurrentPatientId('patient-abc')

    expect(mod.currentPatientId.value).toBe('patient-abc')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('patient-abc')
  })

  it('连续切换会覆盖旧值', async () => {
    const { mod } = await loadPatient()

    mod.setCurrentPatientId('p1')
    mod.setCurrentPatientId('p2')

    expect(mod.currentPatientId.value).toBe('p2')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('p2')
  })
})

describe('restorePatientId', () => {
  it('未配置云端：即使 localStorage 里有云端遗留 id，也强制回到默认病人', async () => {
    const { mod } = await loadPatient({ configured: false })
    localStorage.setItem(STORAGE_KEY, 'cloud-patient-uuid')
    mod.currentPatientId.value = 'cloud-patient-uuid'

    await mod.restorePatientId()

    expect(mod.currentPatientId.value).toBe(DEFAULT_ID)
    // 记录实际行为：遗留值仍在 localStorage 里（只是内存不再采用）
    expect(localStorage.getItem(STORAGE_KEY)).toBe('cloud-patient-uuid')
  })

  it('已配置云端：读回 localStorage 里上次选中的病人', async () => {
    const { mod } = await loadPatient({ configured: true })
    localStorage.setItem(STORAGE_KEY, 'patient-uuid-1')

    await mod.restorePatientId()

    expect(mod.currentPatientId.value).toBe('patient-uuid-1')
  })

  it('已配置云端但没有存档：保持当前值（不强行改写）', async () => {
    const { mod } = await loadPatient({ configured: true })
    mod.setCurrentPatientId('patient-in-memory')
    localStorage.removeItem(STORAGE_KEY)

    await mod.restorePatientId()

    expect(mod.currentPatientId.value).toBe('patient-in-memory')
  })
})

describe('clearCurrentPatient', () => {
  it('内存回到默认病人，并删掉 localStorage 键', async () => {
    const { mod } = await loadPatient()
    mod.setCurrentPatientId('patient-abc')

    await mod.clearCurrentPatient()

    expect(mod.currentPatientId.value).toBe(DEFAULT_ID)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('没有存档时调用也不抛错', async () => {
    const { mod } = await loadPatient()
    await expect(mod.clearCurrentPatient()).resolves.toBeUndefined()
    expect(mod.currentPatientId.value).toBe(DEFAULT_ID)
  })
})

describe('ensureCloudPatient', () => {
  it('未配置云端：直接返回，不请求病人列表', async () => {
    const { mod, listMyPatients } = await loadPatient({ configured: false })

    await mod.ensureCloudPatient()

    expect(listMyPatients).not.toHaveBeenCalled()
    expect(mod.currentPatientId.value).toBe(DEFAULT_ID)
  })

  it('当前病人不在列表里（首次登录 / 换账号 / 被移出成员）→ 自动切到第一个', async () => {
    const { mod } = await loadPatient({
      configured: true,
      list: async () => [item('p1'), item('p2', 'viewer')],
    })
    mod.currentPatientId.value = 'not-mine'

    await mod.ensureCloudPatient()

    expect(mod.currentPatientId.value).toBe('p1')
    // 切换会同步持久化，重开 App 不丢
    expect(localStorage.getItem(STORAGE_KEY)).toBe('p1')
  })

  it('当前病人已在列表里 → 不切换、不写存储', async () => {
    const { mod } = await loadPatient({
      configured: true,
      list: async () => [item('p1'), item('p2')],
    })
    mod.currentPatientId.value = 'p2'
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    await mod.ensureCloudPatient()

    expect(mod.currentPatientId.value).toBe('p2')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('列表为空（一个病人都没有）→ 保持现状，交由页面引导新建', async () => {
    const { mod, listMyPatients } = await loadPatient({ configured: true, list: async () => [] })
    mod.currentPatientId.value = 'whatever'
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    await mod.ensureCloudPatient()

    expect(listMyPatients).toHaveBeenCalledTimes(1)
    expect(mod.currentPatientId.value).toBe('whatever')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('listMyPatients 抛错（离线/网络抖动）→ 不崩、保持现状', async () => {
    const { mod } = await loadPatient({
      configured: true,
      list: async () => {
        throw new Error('network down')
      },
    })
    mod.currentPatientId.value = 'kept'

    await expect(mod.ensureCloudPatient()).resolves.toBeUndefined()
    expect(mod.currentPatientId.value).toBe('kept')
  })

  it('未登录时 listMyPatients 返回 [] → 不切换（避免把默认值意外写出去）', async () => {
    const { mod } = await loadPatient({ configured: true, list: async () => [] })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    await mod.ensureCloudPatient()

    expect(mod.currentPatientId.value).toBe(DEFAULT_ID)
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('hasNoCloudPatient', () => {
  it('列表为空 → true（首页显示「新建病人」引导）', async () => {
    const { mod, listMyPatients } = await loadPatient({ configured: true, list: async () => [] })
    await expect(mod.hasNoCloudPatient()).resolves.toBe(true)
    expect(listMyPatients).toHaveBeenCalledTimes(1)
  })

  it('列表有数据 → false', async () => {
    const { mod } = await loadPatient({ configured: true, list: async () => [item('p1')] })
    await expect(mod.hasNoCloudPatient()).resolves.toBe(false)
  })

  it('listMyPatients 抛错（离线/网络抖动）→ 返回 false，不能断言「没有病人」', async () => {
    const { mod, listMyPatients } = await loadPatient({
      configured: true,
      list: async () => {
        throw new Error('offline')
      },
    })

    // 回归：曾经 `await listMyPatients().catch(() => [])` 把异常吞成空列表 → 返回 true，
    // 首页据此提示「还没有病人档案，去设置新建」，离线时会诱导用户重复建档。
    await expect(mod.hasNoCloudPatient()).resolves.toBe(false)
    expect(listMyPatients).toHaveBeenCalledTimes(1)
  })

  it('未配置云端 → false，且不请求列表', async () => {
    const { mod, listMyPatients } = await loadPatient({ configured: false })
    await expect(mod.hasNoCloudPatient()).resolves.toBe(false)
    expect(listMyPatients).not.toHaveBeenCalled()
  })
})

describe('currentRole / isReadOnly / refreshCurrentRole', () => {
  it('本地模式：角色为 null，不把界面锁成只读', async () => {
    const { mod } = await loadPatient({ configured: false })

    await mod.refreshCurrentRole()

    expect(mod.currentRole.value).toBeNull()
    expect(mod.isReadOnly.value).toBe(false)
  })

  it('云端：按「当前病人」取角色', async () => {
    const { mod } = await loadPatient({
      configured: true,
      list: async () => [item('p1', 'viewer'), item('p2', 'owner')],
    })
    mod.setCurrentPatientId('p2')

    await mod.refreshCurrentRole()

    expect(mod.currentRole.value).toBe('owner')
    expect(mod.isReadOnly.value).toBe(false)
  })

  it('doctor / viewer 视为只读（界面据此隐藏编辑入口）', async () => {
    for (const role of ['doctor', 'viewer']) {
      const { mod } = await loadPatient({ configured: true, list: async () => [item('p1', role)] })
      mod.setCurrentPatientId('p1')
      await mod.refreshCurrentRole()
      expect(mod.isReadOnly.value, `role=${role}`).toBe(true)
    }
  })

  it('owner / caregiver 不是只读', async () => {
    for (const role of ['owner', 'caregiver']) {
      const { mod } = await loadPatient({ configured: true, list: async () => [item('p1', role)] })
      mod.setCurrentPatientId('p1')
      await mod.refreshCurrentRole()
      expect(mod.isReadOnly.value, `role=${role}`).toBe(false)
    }
  })

  it('列表里没有当前病人 → 角色为 null（不误锁界面）', async () => {
    const { mod } = await loadPatient({ configured: true, list: async () => [item('p-other', 'viewer')] })
    mod.setCurrentPatientId('p-mine')

    await mod.refreshCurrentRole()

    expect(mod.currentRole.value).toBeNull()
    expect(mod.isReadOnly.value).toBe(false)
  })

  it('拉取失败 → 角色为 null 且不抛错（服务端仍会拦越权写，不要先把用户锁死）', async () => {
    const { mod } = await loadPatient({
      configured: true,
      list: async () => {
        throw new Error('offline')
      },
    })

    await expect(mod.refreshCurrentRole()).resolves.toBeUndefined()
    expect(mod.currentRole.value).toBeNull()
    expect(mod.isReadOnly.value).toBe(false)
  })

  it('ensureCloudPatient 顺带把当前病人的角色带出来', async () => {
    const { mod } = await loadPatient({ configured: true, list: async () => [item('p1', 'caregiver')] })

    await mod.ensureCloudPatient()

    expect(mod.currentPatientId.value).toBe('p1')
    expect(mod.currentRole.value).toBe('caregiver')
  })

  it('ensureCloudPatient 在没有任何病人时把角色清空', async () => {
    const { mod } = await loadPatient({ configured: true, list: async () => [] })
    mod.currentRole.value = 'owner'

    await mod.ensureCloudPatient()

    expect(mod.currentRole.value).toBeNull()
  })
})
