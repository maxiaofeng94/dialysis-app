/**
 * SettingsView（设置页）组件测试
 *
 * 覆盖：档案回填（含旧数据缺字段、用户正在填表时不被覆盖）、保存档案（入参/createdAt 保留/updatedAt 刷新）、
 * 干体重新增与删除、数值输入的清洗与兜底、导出/导入数据（含确认、失败原因、云端收口）、
 * 云端专属区块的显隐、新建/迁移的防重复提交与列表强制刷新、非 owner 的界面收口。
 *
 * jsdom 限制说明：
 * - `URL.createObjectURL` / `URL.revokeObjectURL` 在 jsdom 里没有实现，测试里显式打桩；
 * - 文件导入不去模拟 FileReader，而是给 File 实例补一个 text()（组件只用 file.text()）；
 * - Vant popup 默认 teleport 到 body，用 `stubs: { teleport: true }` 渲染回组件树内；
 * - Capacitor 插件（Filesystem/Share）与 isNativePlatform 全部打桩，浏览器与原生两条分支都能测。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import SettingsView from '../../src/views/SettingsView.vue'
import { repository } from '../../src/repo'
import { currentPatientId, setCurrentPatientId } from '../../src/stores/patient'
import * as patientModule from '../../src/stores/patient'
import * as authModule from '../../src/stores/auth'
import { listMyPatients, createPatient, getMyProfile, updateMyName } from '../../src/lib/cloudAdmin'
import { Capacitor } from '@capacitor/core'
import { Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type { Patient } from '../../src/types'
import { makePatient, makeDryWeight, makeChangeLog } from '../helpers/factories'

const mocks = vi.hoisted(() => ({
  uuid: vi.fn(() => 'uuid-fixed-1'),
  showToast: vi.fn(),
  showConfirmDialog: vi.fn(async () => undefined),
  showDialog: vi.fn(),
  logout: vi.fn(async () => undefined),
  migrateLocalToCloud: vi.fn(async () => ({ ok: true, message: '迁移完成' })),
  setCurrentPatientId: vi.fn(),
  refreshCurrentRole: vi.fn(async () => undefined),
  ensureCloudPatient: vi.fn(async () => undefined),
  cacheDelete: vi.fn(async () => undefined),
}))

vi.mock('../../src/repo', () => ({
  repository: {
    getPatient: vi.fn(),
    listDryWeights: vi.fn(),
    savePatient: vi.fn(async () => undefined),
    saveDryWeight: vi.fn(async () => undefined),
    deleteDryWeight: vi.fn(async () => undefined),
    exportAll: vi.fn(async () => '{"patients":[]}'),
    importAll: vi.fn(async () => undefined),
    // 轮椅及衣物重量的变更留痕（需求②）：保存档案时若该值有变化会追加一条
    addPatientChangeLog: vi.fn(async () => undefined),
    listPatientChangeLogs: vi.fn(async () => []),
  },
}))

vi.mock('../../src/lib/cloudAdmin', () => ({
  listMyPatients: vi.fn(async () => []),
  createPatient: vi.fn(async () => ({ ok: true, data: { patient: { id: 'new-patient' } } })),
  getMyProfile: vi.fn(async () => null),
  updateMyName: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../src/lib/migrate', () => ({ migrateLocalToCloud: mocks.migrateLocalToCloud }))

// 「我的病人」列表缓存：M2 需要断言「先删 key 再重拉」
vi.mock('../../src/lib/cloudCache', () => ({
  cacheDelete: mocks.cacheDelete,
  cacheVersion: { value: 0 },
}))

// currentPatientId / currentRole 用真 ref（模板里要自动解包，角色还要能驱动界面收口）
vi.mock('../../src/stores/patient', async () => {
  const { ref } = await import('vue')
  const currentPatientId = ref('patient-default')
  const currentRole = ref<string | null>(null)
  return {
    currentPatientId,
    currentRole,
    setCurrentPatientId: mocks.setCurrentPatientId,
    refreshCurrentRole: mocks.refreshCurrentRole,
    ensureCloudPatient: mocks.ensureCloudPatient,
    __currentRole: currentRole,
    // 测试要能真的切病人（跨病人隔离的用例需要）。`setCurrentPatientId` 是 mock，
    // 不会改这个 ref，所以直接暴露出来让用例赋值。
    __currentPatientId: currentPatientId,
  }
})

// isLoggedIn 在模板里直接用（v-if="isLoggedIn"），必须是真 ref 才能被自动解包
vi.mock('../../src/stores/auth', async () => {
  const { ref } = await import('vue')
  const isLoggedIn = ref(false)
  const user = ref<{ id: string } | null>({ id: 'uid-1' })
  return { useAuth: () => ({ user, isLoggedIn, logout: mocks.logout }), __isLoggedIn: isLoggedIn }
})

vi.mock('../../src/utils/id', () => ({ uuid: mocks.uuid }))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }))
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: vi.fn(async () => ({ uri: 'file:///cache/备份.json' })) },
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn(async () => undefined) } }))

vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return {
    ...actual,
    showToast: mocks.showToast,
    showConfirmDialog: mocks.showConfirmDialog,
    showDialog: mocks.showDialog,
  }
})

/** 直接取用被 mock 出来的那个 isLoggedIn ref，用来切换「是否已登录」 */
const isLoggedInRef = (authModule as unknown as { __isLoggedIn: { value: boolean } }).__isLoggedIn
/** 当前账号对当前病人的角色（null = 本地模式/未知，'owner'/'caregiver'/… 由云端返回） */
const currentRoleRef = (patientModule as unknown as { __currentRole: { value: string | null } }).__currentRole

/**
 * 当前病人 id 的真 ref。跨病人隔离的用例必须**直接改这个 ref** ——
 * `setCurrentPatientId` 在本 spec 里是 mock，改不动它。
 */
const currentPatientIdRef = (patientModule as unknown as { __currentPatientId: { value: string } })
  .__currentPatientId

let wrapper: VueWrapper | null = null
let router: Router
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

interface SettingsData {
  patient?: Patient | null
  dryWeights?: ReturnType<typeof makeDryWeight>[]
}

function stubSettingsData(data: SettingsData = {}) {
  vi.mocked(repository.getPatient).mockResolvedValue(
    data.patient === undefined ? makePatient({ id: 'patient-default' }) : (data.patient ?? undefined),
  )
  vi.mocked(repository.listDryWeights).mockResolvedValue(data.dryWeights ?? [])
}

async function mountSettings(data: SettingsData = {}): Promise<VueWrapper> {
  stubSettingsData(data)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: defineComponent({ render: () => h('div') }) },
      { path: '/login', component: defineComponent({ render: () => h('div') }) },
      { path: '/members', component: defineComponent({ render: () => h('div') }) },
    ],
  })
  await router.push('/')
  await router.isReady()
  wrapper = mount(SettingsView, {
    global: { plugins: [Vant, router], stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

function fieldInput(
  scope: VueWrapper | DOMWrapper<Node>,
  label: string,
  tag: 'input' | 'textarea' = 'input',
): DOMWrapper<HTMLInputElement> {
  const field = scope.findAll('.van-field').find((f) => f.text().includes(label))
  if (!field) throw new Error(`未找到 label 为「${label}」的 van-field`)
  const el = field.find(tag)
  if (!el.exists()) throw new Error(`「${label}」里没有 ${tag}`)
  return el as DOMWrapper<HTMLInputElement>
}

function buttonByText(scope: VueWrapper | DOMWrapper<Node>, text: string): DOMWrapper<HTMLButtonElement> {
  const btn = scope.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`未找到文案包含「${text}」的按钮`)
  return btn as DOMWrapper<HTMLButtonElement>
}

function cardByTitle(w: VueWrapper, title: string): DOMWrapper<Node> {
  const card = w
    .findAll('.card')
    .find((c) => c.find('.card-title').exists() && c.find('.card-title').text().startsWith(title))
  if (!card) throw new Error(`未找到标题为「${title}」的卡片`)
  return card as DOMWrapper<Node>
}

function popupByText(w: VueWrapper, text: string): DOMWrapper<Node> {
  const popup = w.findAll('.van-popup').find((p) => p.text().includes(text))
  if (!popup) throw new Error(`未找到包含「${text}」的弹窗`)
  return popup as DOMWrapper<Node>
}

/** 截获 downloadBlob 创建的那个 <a download="…"> */
function captureAnchor(): () => HTMLAnchorElement | null {
  const original = document.createElement.bind(document)
  let anchor: HTMLAnchorElement | null = null
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const el = original(tag, options)
    if (tag === 'a') anchor = el as HTMLAnchorElement
    return el
  }) as typeof document.createElement)
  return () => anchor
}

/** 走一遍「选中文件 → change」的导入流程（组件只依赖 file.text()，不经过 FileReader） */
async function selectImportFile(w: VueWrapper, text: string, name = '备份.json'): Promise<void> {
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: async () => text })
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

/** 把 showToast 的全部调用拼起来，便于断言「提示里包含某某文案」 */
function toastText(): string {
  return mocks.showToast.mock.calls.map((c) => String(c[0])).join('｜')
}

/** 取出第 n 次 showConfirmDialog 的 message */
function confirmMessage(index = 0): string {
  return String((mocks.showConfirmDialog.mock.calls[index][0] as { message: string }).message)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2024-06-01T10:00:00')) // 冻结「今天」，干体重有效期与导出文件名可预期

  isLoggedInRef.value = false
  currentRoleRef.value = null
  currentPatientId.value = 'patient-default'
  mocks.uuid.mockReset().mockReturnValue('uuid-fixed-1')
  mocks.showToast.mockReset()
  mocks.showConfirmDialog.mockReset().mockResolvedValue(undefined)
  mocks.showDialog.mockReset()
  mocks.logout.mockClear()
  mocks.migrateLocalToCloud
    .mockReset()
    .mockResolvedValue({ ok: true, message: '已迁移 2 条透析记录到云端', patientId: 'p-new' })
  mocks.setCurrentPatientId.mockReset()
  mocks.refreshCurrentRole.mockReset().mockResolvedValue(undefined)
  mocks.ensureCloudPatient.mockReset().mockResolvedValue(undefined)
  mocks.cacheDelete.mockReset().mockResolvedValue(undefined)

  for (const fn of Object.values(repository) as unknown as ReturnType<typeof vi.fn>[]) {
    fn.mockReset()
  }
  vi.mocked(repository.savePatient).mockResolvedValue(undefined)
  vi.mocked(repository.saveDryWeight).mockResolvedValue(undefined)
  vi.mocked(repository.deleteDryWeight).mockResolvedValue(undefined)
  vi.mocked(repository.exportAll).mockResolvedValue('{"patients":[]}')
  vi.mocked(repository.importAll).mockResolvedValue(undefined)
  vi.mocked(repository.addPatientChangeLog).mockResolvedValue(undefined)
  vi.mocked(repository.listPatientChangeLogs).mockResolvedValue([])
  vi.mocked(listMyPatients).mockReset().mockResolvedValue([])
  vi.mocked(createPatient).mockReset().mockResolvedValue({ ok: true, data: { patient: { id: 'new-patient' } } })
  vi.mocked(getMyProfile).mockReset().mockResolvedValue(null)
  vi.mocked(updateMyName).mockReset().mockResolvedValue({ ok: true })

  vi.mocked(Capacitor.isNativePlatform).mockReset().mockReturnValue(false)
  vi.mocked(Filesystem.writeFile).mockReset().mockResolvedValue({ uri: 'file:///cache/备份.json' })
  vi.mocked(Share.share).mockReset().mockResolvedValue(undefined)

  // jsdom 不实现对象 URL，导出下载需要它
  createObjectURL = vi.fn(() => 'blob:test-url')
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true, configurable: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('SettingsView · 病人档案回填', () => {
  it('用 getPatient 的值回填表单，并显示当前年龄', async () => {
    const w = await mountSettings({
      patient: makePatient({
        id: 'patient-default',
        name: '张三',
        birthday: '1950-06-01',
        wheelchairWeight: 20,
        rinseBackVolume: 300,
      }),
    })

    expect(fieldInput(w, '姓名').element.value).toBe('张三')
    expect(fieldInput(w, '生日').element.value).toBe('1950-06-01')
    expect(fieldInput(w, '轮椅及衣物重量').element.value).toBe('20')
    expect(fieldInput(w, '回水量').element.value).toBe('300')
    expect(w.text()).toContain('当前年龄约 74 岁') // 冻结在 2024-06-01
  })

  it('旧数据缺 birthday 时不渲染年龄行，也不崩', async () => {
    const legacy = { id: 'patient-default', name: '李四' } as unknown as Patient
    const w = await mountSettings({ patient: legacy })

    expect(fieldInput(w, '姓名').element.value).toBe('李四')
    expect(fieldInput(w, '生日').element.value).toBe('')
    expect(w.text()).not.toContain('当前年龄约')
  })

  it('旧数据缺 wheelchairWeight/rinseBackVolume 时能兜底：输入框留空，保存回落 0 / 300', async () => {
    const legacy = { id: 'patient-default', name: '李四' } as unknown as Patient
    const w = await mountSettings({ patient: legacy })

    // 组件内部是 String(undefined)="undefined"，但 number 型输入框会把它清洗成空串
    expect(fieldInput(w, '轮椅及衣物重量').element.value).toBe('')
    expect(fieldInput(w, '回水量').element.value).toBe('')

    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    const saved = vi.mocked(repository.savePatient).mock.calls[0][0]
    expect(saved.wheelchairWeight).toBe(0)
    expect(saved.rinseBackVolume).toBe(300)
  })

  it('没有病人档案时表单为空，干体重区给出提示', async () => {
    const w = await mountSettings({ patient: null, dryWeights: [] })

    expect(fieldInput(w, '姓名').element.value).toBe('')
    expect(w.text()).toContain('暂无干体重记录，请先添加')
    expect(w.find('.card-title').text()).toBe('病人档案')
  })

  it('用户改过档案表单后，保存干体重触发的 load 不覆盖正在填的内容（M3）', async () => {
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-default', name: '张三', wheelchairWeight: 20 }),
    })

    await fieldInput(w, '姓名').setValue('张三丰')
    await fieldInput(w, '轮椅及衣物重量').setValue('22.5')

    // 新增干体重会走 load()，此时表单已被用户改过 → 不能回填
    await buttonByText(cardByTitle(w, '干体重历史'), '新增').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '新增干体重')
    await fieldInput(popup, '干体重').setValue('58')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.listDryWeights).toHaveBeenCalledTimes(2) // load 确实跑过
    expect(fieldInput(w, '姓名').element.value).toBe('张三丰')
    expect(fieldInput(w, '轮椅及衣物重量').element.value).toBe('22.5')
  })

  it('表单没被改过时，load 仍会正常回填（避免 M3 的收口把回填整个关掉）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '张三' }) })
    vi.mocked(repository.getPatient).mockResolvedValue(makePatient({ id: 'patient-default', name: '李四' }))

    await buttonByText(cardByTitle(w, '干体重历史'), '新增').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '新增干体重')
    await fieldInput(popup, '干体重').setValue('58')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(fieldInput(w, '姓名').element.value).toBe('李四')
  })

  it('切换病人时无条件回填（用户主动换人，旧的输入不该带到新病人身上）', async () => {
    isLoggedInRef.value = true
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'p1', name: '王五' }), role: 'owner' },
    ])
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '张三' }) })
    vi.mocked(repository.getPatient).mockResolvedValue(makePatient({ id: 'p1', name: '王五' }))

    await fieldInput(w, '姓名').setValue('改了一半的名字')
    const row = w.findAll('div').find((d) => (d.attributes('style') ?? '').includes('cursor: pointer'))
    await row!.trigger('click')
    await flushPromises()

    expect(setCurrentPatientId).toHaveBeenCalledWith('p1')
    expect(fieldInput(w, '姓名').element.value).toBe('王五')
  })
})

describe('SettingsView · 保存病人档案', () => {
  it('保存：姓名 trim、数值解析、createdAt 保留、updatedAt 刷新', async () => {
    const w = await mountSettings({
      patient: makePatient({
        id: 'patient-default',
        name: '张三',
        birthday: '1950-06-01',
        wheelchairWeight: 20,
        rinseBackVolume: 300,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      }),
    })

    await fieldInput(w, '姓名').setValue('  张三丰  ')
    await fieldInput(w, '轮椅及衣物重量').setValue('22.5')
    await fieldInput(w, '回水量').setValue('350')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(repository.savePatient).mock.calls[0][0]
    expect(saved).toMatchObject({
      id: 'patient-default',
      name: '张三丰',
      birthday: '1950-06-01',
      wheelchairWeight: 22.5,
      rinseBackVolume: 350,
      createdAt: 1_700_000_000_000,
    })
    expect(saved.updatedAt).toBe(Date.now())
    // 轮椅及衣物重量从 20 → 22.5：保存成功后要留一条变更记录（需求②），
    // 日志写成功时提示仍是「已保存」（写失败才有额外提示，见后续用例）
    expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.addPatientChangeLog).mock.calls[0][0]).toMatchObject({
      patientId: 'patient-default',
      field: 'wheelchairWeight',
      oldValue: 20,
      newValue: 22.5,
    })
    expect(mocks.showToast).toHaveBeenCalledWith('已保存')
  })

  it('保存：姓名为空落成「未命名」，轮椅缺失落成 0、回水缺失落成 300', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await fieldInput(w, '姓名').setValue('   ')
    await fieldInput(w, '轮椅及衣物重量').setValue('')
    await fieldInput(w, '回水量').setValue('')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    const saved = vi.mocked(repository.savePatient).mock.calls[0][0]
    expect(saved.name).toBe('未命名')
    expect(saved.wheelchairWeight).toBe(0)
    expect(saved.rinseBackVolume).toBe(300)
  })

  it('非法输入被拦截成兜底值（number 输入框接受不了字母，解析为 null → 回落默认值）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await fieldInput(w, '轮椅及衣物重量').setValue('abc')
    await fieldInput(w, '回水量').setValue('一百')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    const saved = vi.mocked(repository.savePatient).mock.calls[0][0]
    expect(saved.wheelchairWeight).toBe(0)
    expect(saved.rinseBackVolume).toBe(300)
  })

  it('轮椅及衣物重量为负数 → 拦截并提示，不写库（回归：曾经 -5 会原样入库，首页「实际体重」跟着偏大）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await fieldInput(w, '轮椅及衣物重量').setValue('-5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(toastText()).toContain('轮椅及衣物重量应在 0~100 之间')
  })

  it('回水量 / 轮椅及衣物重量超出上限也被拦下，不写库', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await fieldInput(w, '回水量').setValue('99999')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(toastText()).toContain('回水量应在 0~2000 之间')

    await fieldInput(w, '回水量').setValue('300')
    await fieldInput(w, '轮椅及衣物重量').setValue('150')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(toastText()).toContain('轮椅及衣物重量应在 0~100 之间')
  })
})

describe('SettingsView · 干体重历史', () => {
  const dryWeights = [
    makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01', note: '医生调整' }),
    makeDryWeight({ id: 'd2', value: 59.5, effectiveDate: '2024-03-05', note: null }),
  ]

  it('列表按仓储返回顺序渲染日期、数值与备注，并显示当前有效干体重', async () => {
    const w = await mountSettings({ dryWeights })

    const card = cardByTitle(w, '干体重历史')
    expect(card.text()).toContain('1月1日 周一')
    expect(card.text()).toContain('60.0 kg')
    expect(card.text()).toContain('医生调整')
    expect(card.text()).toContain('3月5日 周二')
    expect(card.text()).toContain('59.5 kg')
    // 冻结在 2024-06-01：<= 今天的最后一条是 2024-03-05 的 59.5
    expect(card.text()).toContain('当前有效干体重 59.5 kg')
  })

  it('新增干体重：saveDryWeight 入参正确、弹窗关闭并刷新列表', async () => {
    const w = await mountSettings()

    await buttonByText(cardByTitle(w, '干体重历史'), '新增').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '新增干体重')

    await fieldInput(popup, '干体重').setValue('58.5')
    await fieldInput(popup, '生效日期').setValue('2024-04-01')
    await fieldInput(popup, '备注').setValue('  医生下调  ')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveDryWeight).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.saveDryWeight).mock.calls[0][0]).toMatchObject({
      id: 'uuid-fixed-1',
      patientId: 'patient-default',
      value: 58.5,
      effectiveDate: '2024-04-01',
      note: '医生下调',
    })
    expect(repository.listDryWeights).toHaveBeenCalledTimes(2) // 保存后 load() 重读
    expect(mocks.showToast).toHaveBeenCalledWith('已添加')
  })

  it('新增干体重：不填数值时提示、不写库、弹窗不关', async () => {
    const w = await mountSettings()

    await buttonByText(cardByTitle(w, '干体重历史'), '新增').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '新增干体重')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveDryWeight).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('请填写干体重')
    expect(w.text()).toContain('新增干体重') // 弹窗仍在
  })

  it('新增干体重：不填生效日期时默认今天', async () => {
    const w = await mountSettings()

    await buttonByText(cardByTitle(w, '干体重历史'), '新增').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '新增干体重')
    await fieldInput(popup, '干体重').setValue('57')
    await fieldInput(popup, '生效日期').setValue('')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(vi.mocked(repository.saveDryWeight).mock.calls[0][0].effectiveDate).toBe('2024-06-01')
  })

  it('删除干体重：确认后调用 deleteDryWeight 并刷新', async () => {
    const w = await mountSettings({ dryWeights })

    await cardByTitle(w, '干体重历史').findAll('.van-icon-delete-o')[0].trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(repository.deleteDryWeight).toHaveBeenCalledWith('d1')
    expect(repository.listDryWeights).toHaveBeenCalledTimes(2)
  })

  it('删除干体重：用户取消时不删库', async () => {
    const w = await mountSettings({ dryWeights })
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel'))

    await cardByTitle(w, '干体重历史').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(repository.deleteDryWeight).not.toHaveBeenCalled()
  })

  it('删除干体重的确认文案说明「会影响其后记录的计算」（L3）', async () => {
    const w = await mountSettings({ dryWeights })

    await cardByTitle(w, '干体重历史').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(confirmMessage()).toContain('该日期之后的记录会按更早的干体重重新计算')
    expect(repository.deleteDryWeight).toHaveBeenCalledWith('d1')
  })

  it('删除失败（无权限 / 已被他人删除）时给出提示，不谎报成功', async () => {
    const w = await mountSettings({ dryWeights })
    vi.mocked(repository.deleteDryWeight).mockRejectedValueOnce(
      new Error('删除干体重失败：可能没有修改权限，或它已被其他人删除'),
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await cardByTitle(w, '干体重历史').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(toastText()).toContain('删除失败：删除干体重失败：可能没有修改权限')
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('SettingsView · 导出与导入数据', () => {
  it('导出全部数据：调用 exportAll 并触发一次浏览器下载（文件名带当天日期），提示带上记录条数', async () => {
    const w = await mountSettings()
    vi.mocked(repository.exportAll).mockResolvedValue(
      JSON.stringify({ version: 1, patients: [{ id: 'p1' }], sessions: [{ id: 's1' }, { id: 's2' }] }),
    )
    const getAnchor = captureAnchor()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await buttonByText(w, '导出全部数据').trigger('click')
    await flushPromises()

    expect(repository.exportAll).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(getAnchor()!.download).toBe('透析记录备份-2024-06-01.json')
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    // H2：提示里必须带条数，否则一份空备份也会被当成「导出成功」
    expect(mocks.showToast).toHaveBeenCalledWith('已导出，共 2 条透析记录')
  })

  it('导出「空备份」时明确说明没有记录，不谎报成功（H2）', async () => {
    const w = await mountSettings()
    vi.mocked(repository.exportAll).mockResolvedValue('{"version":1,"patients":[],"sessions":[]}')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await buttonByText(w, '导出全部数据').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('已导出，备份中没有透析记录')
  })

  it('导出失败：提示真实原因并提醒检查网络，不静默、不谎报（H2）', async () => {
    const w = await mountSettings()
    // 云端仓储在任一表查询失败时会抛「导出失败（血压）：xxx」（数据层保证），页面负责如实展示
    vi.mocked(repository.exportAll).mockRejectedValueOnce(new Error('导出失败（血压）：Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await buttonByText(w, '导出全部数据').trigger('click')
    await flushPromises()

    expect(toastText()).toContain('导出失败（血压）：Failed to fetch')
    expect(toastText()).toContain('检查网络')
    expect(errSpy).toHaveBeenCalled()
  })

  it('原生分支：写入文件并调起系统分享，提示里也带条数（H2）', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
    vi.mocked(repository.exportAll).mockResolvedValue(JSON.stringify({ patients: [{ id: 'p1' }], sessions: [{ id: 's1' }] }))
    const w = await mountSettings()

    await buttonByText(w, '导出全部数据').trigger('click')
    await flushPromises()

    expect(Filesystem.writeFile).toHaveBeenCalledTimes(1)
    expect(Share.share).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('已生成备份（1 条透析记录），请选择保存或发送')
  })

  it('原生分支写入失败也要有提示，不能静默（H2）', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
    vi.mocked(Filesystem.writeFile).mockRejectedValueOnce(new Error('磁盘写入失败'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountSettings()

    await buttonByText(w, '导出全部数据').trigger('click')
    await flushPromises()

    expect(toastText()).toContain('导出失败：磁盘写入失败')
    expect(toastText()).toContain('检查网络')
    expect(errSpy).toHaveBeenCalled()
  })

  it('点「导入数据恢复」会打开隐藏的文件选择框', async () => {
    const w = await mountSettings()
    const fileInput = w.find('input[type="file"]')
    const clickSpy = vi.spyOn(fileInput.element as HTMLInputElement, 'click').mockImplementation(() => {})

    await buttonByText(w, '导入数据恢复').trigger('click')

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('导入数据：先确认（写明覆盖全部数据、无法撤销、记录条数），确认后才调用 importAll 并重读数据（H1）', async () => {
    const w = await mountSettings()
    await selectImportFile(
      w,
      JSON.stringify({ patients: [{ id: 'p1' }], sessions: [{ id: 's1' }, { id: 's2' }] }),
    )

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(confirmMessage()).toContain('覆盖本机现有全部数据')
    expect(confirmMessage()).toContain('无法撤销')
    expect(confirmMessage()).toContain('1 个病人')
    expect(confirmMessage()).toContain('2 条透析记录')

    expect(repository.importAll).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('导入成功')
    expect(repository.getPatient).toHaveBeenCalledTimes(2) // 初始 load + 导入后 load
  })

  it('导入数据：确认框取消时一个字节都不动（H1）', async () => {
    const w = await mountSettings()
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel'))

    await selectImportFile(w, '{"patients":[{"id":"p1"}]}')

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(repository.importAll).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalledWith('导入成功')
  })

  it('导入数据：文件不是合法 JSON 时直接中止，不弹确认、不导入（H1）', async () => {
    const w = await mountSettings()

    await selectImportFile(w, 'not-json', 'bad.json')

    expect(mocks.showToast).toHaveBeenCalledWith('导入失败：不是有效的备份文件')
    expect(mocks.showConfirmDialog).not.toHaveBeenCalled()
    expect(repository.importAll).not.toHaveBeenCalled()
  })

  it('导入数据：坏文件（仓储校验拒绝）时展示真实原因，且不提示成功（H1）', async () => {
    const w = await mountSettings()
    vi.mocked(repository.importAll).mockRejectedValueOnce(
      new Error('备份文件格式不正确：patients 第 1 条缺少 id'),
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await selectImportFile(w, '{"patients":[{"name":"张三"}]}')

    expect(mocks.showToast).toHaveBeenCalledWith('导入失败：备份文件格式不正确：patients 第 1 条缺少 id')
    expect(mocks.showToast).not.toHaveBeenCalledWith('导入成功')
    expect(errSpy).toHaveBeenCalled()
  })

  it('云端模式下「导入数据恢复」置灰并说明原因，点击也不打开文件框（H1）', async () => {
    isLoggedInRef.value = true
    const w = await mountSettings()
    const btn = buttonByText(w, '导入数据恢复')
    expect(btn.classes()).toContain('van-button--disabled')
    expect(w.text()).toContain('云端模式下数据在服务器，恢复备份请先退出登录')

    const clickSpy = vi
      .spyOn(w.find('input[type="file"]').element as HTMLInputElement, 'click')
      .mockImplementation(() => {})
    await btn.trigger('click')
    await flushPromises()

    expect(clickSpy).not.toHaveBeenCalled()
    expect(repository.importAll).not.toHaveBeenCalled()
  })

  it('没有选中文件时什么都不做', async () => {
    const w = await mountSettings()
    const input = w.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [], configurable: true })

    await input.trigger('change')
    await flushPromises()

    expect(repository.importAll).not.toHaveBeenCalled()
  })

  it('使用说明按钮会弹出说明弹窗', async () => {
    const w = await mountSettings()

    await buttonByText(w, '使用说明').trigger('click')

    expect(mocks.showDialog).toHaveBeenCalledTimes(1)
    expect(String((mocks.showDialog.mock.calls[0][0] as { message: string }).message)).toContain('快速创建')
  })
})

describe('SettingsView · 云端专属区块', () => {
  it('未登录（纯本地单机模式）时不渲染「我的病人/账号」区块，也不请求云端接口', async () => {
    const w = await mountSettings()

    expect(w.text()).not.toContain('我的病人')
    expect(w.text()).not.toContain('退出登录')
    expect(w.text()).not.toContain('上传本地数据到云端')
    expect(w.text()).not.toContain('成员管理')
    expect(listMyPatients).not.toHaveBeenCalled()
    expect(getMyProfile).not.toHaveBeenCalled()
  })

  it('已登录时渲染云端区块，并展示病人列表、角色与我的手机号', async () => {
    isLoggedInRef.value = true
    vi.mocked(listMyPatients).mockResolvedValue([{ patient: makePatient({ id: 'p1', name: '王五' }), role: 'owner' }])
    vi.mocked(getMyProfile).mockResolvedValue({ name: '我', phone: '13800000000' })
    const w = await mountSettings()

    expect(w.text()).toContain('我的病人')
    expect(w.text()).toContain('王五')
    expect(w.text()).toContain('创建者')
    expect(w.text()).toContain('手机号 13800000000')
    expect(w.text()).toContain('上传本地数据到云端')
    expect(w.text()).toContain('退出登录')
  })

  it('点击病人可切换当前病人', async () => {
    isLoggedInRef.value = true
    vi.mocked(listMyPatients).mockResolvedValue([{ patient: makePatient({ id: 'p1', name: '王五' }), role: 'owner' }])
    const w = await mountSettings()

    const row = w.findAll('div').find((d) => (d.attributes('style') ?? '').includes('cursor: pointer'))
    expect(row).toBeTruthy()
    await row!.trigger('click')
    await flushPromises()

    expect(setCurrentPatientId).toHaveBeenCalledWith('p1')
    expect(mocks.showToast).toHaveBeenCalledWith('已切换病人')
    expect(repository.getPatient).toHaveBeenCalledTimes(2) // 切换后重新 load
  })

  it('退出登录：调用 logout 并跳回登录页', async () => {
    isLoggedInRef.value = true
    // 真实 store 的 logout 会把 user 清掉 → isLoggedIn 变 false，这里如实模拟
    mocks.logout.mockImplementationOnce(async () => {
      isLoggedInRef.value = false
    })
    const w = await mountSettings()

    await buttonByText(w, '退出登录').trigger('click')
    await flushPromises()

    expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/login')
    // 主动退出不该被当成「登录状态失效」再吓用户一次
    expect(mocks.showToast).not.toHaveBeenCalledWith('登录状态已失效，请重新登录')
  })

  it('退出登录需要二次确认：取消则不登出（M4）', async () => {
    isLoggedInRef.value = true
    const w = await mountSettings()
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel'))

    await buttonByText(w, '退出登录').trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(confirmMessage()).toContain('退出后')
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('已登录时挂载就刷新一次当前角色（H6 的界面收口依赖它）', async () => {
    isLoggedInRef.value = true
    await mountSettings()

    expect(mocks.refreshCurrentRole).toHaveBeenCalledTimes(1)
  })

  it('未登录的纯本地模式不去拉角色（本地数据都是自己的）', async () => {
    await mountSettings()

    expect(mocks.refreshCurrentRole).not.toHaveBeenCalled()
  })

  it('登录状态失效（isLoggedIn 由 true 变 false）时提示并引导回登录页（M6）', async () => {
    isLoggedInRef.value = true
    await mountSettings()

    isLoggedInRef.value = false
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('登录状态已失效，请重新登录')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('「成员管理」跳转到成员页', async () => {
    isLoggedInRef.value = true
    const w = await mountSettings()

    await buttonByText(w, '成员管理').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/members')
  })

  it('保存姓名：提交时按钮 loading，连点只调用一次 updateMyName', async () => {
    isLoggedInRef.value = true
    let release!: (v: { ok: boolean }) => void
    vi.mocked(updateMyName).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const w = await mountSettings()
    await fieldInput(w, '我的姓名').setValue('张三')

    const btn = buttonByText(w, '保存姓名')
    await btn.trigger('click')
    await btn.trigger('click')
    expect(updateMyName).toHaveBeenCalledTimes(1)
    expect(btn.classes()).toContain('van-button--loading')

    release({ ok: true })
    await flushPromises()
    expect(mocks.showToast).toHaveBeenCalledWith('已保存')
    expect(btn.classes()).not.toContain('van-button--loading')
  })

  it('保存姓名抛异常时给出提示，按钮复位（不永久转圈）', async () => {
    isLoggedInRef.value = true
    vi.mocked(updateMyName).mockRejectedValueOnce(new Error('Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountSettings()

    const btn = buttonByText(w, '保存姓名')
    await btn.trigger('click')
    await flushPromises()

    expect(toastText()).toContain('保存失败：Failed to fetch')
    expect(errSpy).toHaveBeenCalled()
    expect(btn.classes()).not.toContain('van-button--loading')
  })
})

describe('SettingsView · 新建病人与迁移（防重复提交 + 列表刷新）', () => {
  async function openNewPatientPopup(w: VueWrapper): Promise<DOMWrapper<Node>> {
    await buttonByText(w, '新建').trigger('click')
    await flushPromises()
    return popupByText(w, '新建病人')
  }

  it('新建成功：设为当前病人、强制重拉列表（先删缓存 key）、重新加载页面数据（M2）', async () => {
    isLoggedInRef.value = true
    vi.mocked(listMyPatients)
      .mockResolvedValueOnce([]) // 挂载时
      .mockResolvedValueOnce([{ patient: makePatient({ id: 'new-patient', name: '王五' }), role: 'owner' }])
    const w = await mountSettings()
    expect(w.text()).toContain('暂无病人，点「＋ 新建」创建')

    const popup = await openNewPatientPopup(w)
    await fieldInput(popup, '姓名').setValue('王五')
    await buttonByText(popup, '创建').trigger('click')
    await flushPromises()

    expect(createPatient).toHaveBeenCalledWith('王五', 0, 300)
    expect(setCurrentPatientId).toHaveBeenCalledWith('new-patient')
    // 缓存命中会返回旧列表 → 必须先把 myPatients:<uid> 删掉再拉
    expect(mocks.cacheDelete).toHaveBeenCalledWith('myPatients:uid-1')
    expect(listMyPatients).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('王五')
    expect(mocks.refreshCurrentRole).toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('已创建')
  })

  it('新建：连点「创建」只调用一次 createPatient（H5）', async () => {
    isLoggedInRef.value = true
    let release!: (v: { ok: boolean; data: { patient: { id: string } } }) => void
    vi.mocked(createPatient).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const w = await mountSettings()
    const popup = await openNewPatientPopup(w)
    await fieldInput(popup, '姓名').setValue('王五')

    // loading 时按钮文案会被 Vant 换成转圈，所以只能按「弹窗里的最后一个按钮」定位
    const buttons = popup.findAll('button')
    const createBtn = buttons[buttons.length - 1]
    await createBtn.trigger('click')
    await createBtn.trigger('click') // 第二次点击必须被 in-flight 守卫挡住
    expect(createPatient).toHaveBeenCalledTimes(1)
    expect(createBtn.classes()).toContain('van-button--loading')

    release({ ok: true, data: { patient: { id: 'new-patient' } } })
    await flushPromises()

    expect(createPatient).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('已创建')
  })

  it('新建失败时提示服务端错误，按钮恢复可点（不永久转圈）', async () => {
    isLoggedInRef.value = true
    vi.mocked(createPatient).mockResolvedValueOnce({ ok: false, data: { error: '该手机号未注册' } })
    const w = await mountSettings()
    const popup = await openNewPatientPopup(w)
    await fieldInput(popup, '姓名').setValue('王五')

    await buttonByText(popup, '创建').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('该手机号未注册')
    expect(buttonByText(popup, '创建').classes()).not.toContain('van-button--loading')
  })

  it('迁移：先确认（不可逆、会新建云端病人），成功后提示新病人与条数并把新病人设为当前（H5）', async () => {
    isLoggedInRef.value = true
    vi.mocked(listMyPatients)
      .mockResolvedValueOnce([]) // 挂载时
      .mockResolvedValueOnce([{ patient: makePatient({ id: 'p-new', name: '张三' }), role: 'owner' }])
    const w = await mountSettings()

    await buttonByText(w, '上传本地数据到云端').trigger('click')
    await flushPromises()

    expect(confirmMessage()).toContain('不可撤销')
    expect(confirmMessage()).toContain('新建一个病人')
    expect(mocks.migrateLocalToCloud).toHaveBeenCalledTimes(1)
    expect(setCurrentPatientId).toHaveBeenCalledWith('p-new')
    expect(mocks.cacheDelete).toHaveBeenCalledWith('myPatients:uid-1')
    expect(mocks.refreshCurrentRole).toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('已在云端新建病人「张三」，已迁移 2 条透析记录到云端')
  })

  it('迁移接口没返回 patientId 时，从刷新后的列表差异里选中新病人（兜底）', async () => {
    isLoggedInRef.value = true
    mocks.migrateLocalToCloud.mockResolvedValueOnce({ ok: true, message: '已迁移 1 条透析记录到云端' })
    vi.mocked(listMyPatients)
      .mockResolvedValueOnce([{ patient: makePatient({ id: 'p-old', name: '旧病人' }), role: 'owner' }])
      .mockResolvedValueOnce([
        { patient: makePatient({ id: 'p-old', name: '旧病人' }), role: 'owner' },
        { patient: makePatient({ id: 'p-new2', name: '新病人' }), role: 'owner' },
      ])
    const w = await mountSettings()

    await buttonByText(w, '上传本地数据到云端').trigger('click')
    await flushPromises()

    expect(setCurrentPatientId).toHaveBeenCalledWith('p-new2')
    expect(mocks.ensureCloudPatient).not.toHaveBeenCalled()
  })

  it('迁移：连点只迁移一次（H5）', async () => {
    isLoggedInRef.value = true
    let releaseConfirm!: () => void
    mocks.showConfirmDialog.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseConfirm = () => resolve()
      }),
    )
    let releaseMigrate!: (v: { ok: boolean; message: string }) => void
    mocks.migrateLocalToCloud.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseMigrate = resolve
      }),
    )
    const w = await mountSettings()

    const btn = buttonByText(w, '上传本地数据到云端')
    await btn.trigger('click')
    await btn.trigger('click') // 确认框还开着时的第二次点击
    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)

    releaseConfirm()
    await flushPromises()
    expect(btn.classes()).toContain('van-button--loading')

    releaseMigrate({ ok: true, message: '已迁移 1 条透析记录到云端' })
    await flushPromises()

    expect(mocks.migrateLocalToCloud).toHaveBeenCalledTimes(1)
    expect(btn.classes()).not.toContain('van-button--loading')
  })

  it('迁移前取消则什么都不做', async () => {
    isLoggedInRef.value = true
    const w = await mountSettings()
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel'))

    await buttonByText(w, '上传本地数据到云端').trigger('click')
    await flushPromises()

    expect(mocks.migrateLocalToCloud).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('迁移失败时提示原因', async () => {
    isLoggedInRef.value = true
    const w = await mountSettings()
    mocks.migrateLocalToCloud.mockResolvedValueOnce({ ok: false, message: '本机没有病人数据' })

    await buttonByText(w, '上传本地数据到云端').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('本机没有病人数据')
    expect(setCurrentPatientId).not.toHaveBeenCalled()
  })

  it('新建成功后列表刷新失败：不能说「创建失败」（否则用户再点会造出重复病人）', async () => {
    isLoggedInRef.value = true
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountSettings()
    vi.mocked(listMyPatients).mockRejectedValueOnce(new Error('Failed to fetch'))

    const popup = await openNewPatientPopup(w)
    await fieldInput(popup, '姓名').setValue('王五')
    await buttonByText(popup, '创建').trigger('click')
    await flushPromises()

    expect(setCurrentPatientId).toHaveBeenCalledWith('new-patient')
    expect(toastText()).not.toContain('创建失败')
    expect(toastText()).toContain('病人已创建')
    expect(errSpy).toHaveBeenCalled()
  })

  it('迁移成功后列表刷新失败：也不能说「迁移失败」（避免重复迁移出重复病人）', async () => {
    isLoggedInRef.value = true
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountSettings()
    vi.mocked(listMyPatients).mockRejectedValueOnce(new Error('Failed to fetch'))

    await buttonByText(w, '上传本地数据到云端').trigger('click')
    await flushPromises()

    expect(toastText()).toContain('已在云端新建病人')
    expect(toastText()).not.toContain('迁移失败')
    expect(toastText()).toContain('迁移已完成')
    expect(errSpy).toHaveBeenCalled()
  })

  /**
   * 回归：进页面时「我的病人」拉取失败，**绝不能**落到「暂无病人，点『＋ 新建』创建」——
   * 用户云端明明有病人，会照着提示建出重复档案（App 内删不掉，只能上后台/跑 SQL）。
   * 评审指出这一整个修复当时零测试覆盖。
   */
  it('「我的病人」拉取失败：显示错误态 + 重试，绝不显示「暂无病人」、也不让新建', async () => {
    isLoggedInRef.value = true
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listMyPatients).mockRejectedValueOnce(new Error('Failed to fetch'))

    const w = await mountSettings()
    await flushPromises()

    expect(w.text()).toContain('病人列表加载失败')
    expect(w.text()).not.toContain('暂无病人，点「＋ 新建」创建')
    // 失败时「＋ 新建」必须禁用，否则用户会顺手建出重复档案
    const newBtn = w.findAll('button').find((b) => b.text().includes('＋ 新建'))!
    expect(newBtn.classes()).toContain('van-button--disabled')
    expect(errSpy).toHaveBeenCalled()
  })

  it('「我的病人」失败后点「重试」能恢复出列表', async () => {
    isLoggedInRef.value = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listMyPatients).mockRejectedValueOnce(new Error('Failed to fetch'))

    const w = await mountSettings()
    await flushPromises()
    expect(w.text()).toContain('病人列表加载失败')

    vi.mocked(listMyPatients).mockResolvedValueOnce([
      { patient: makePatient({ id: 'p1', name: '王五' }), role: 'owner' },
    ])
    await buttonByText(w, '重试').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('王五')
    expect(w.text()).not.toContain('病人列表加载失败')
  })

  it('迁移过程中抛异常也要复位按钮并提示（不永久转圈）', async () => {
    isLoggedInRef.value = true
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountSettings()
    mocks.migrateLocalToCloud.mockRejectedValueOnce(new Error('Failed to fetch'))

    await buttonByText(w, '上传本地数据到云端').trigger('click')
    await flushPromises()

    expect(toastText()).toContain('迁移失败：Failed to fetch')
    expect(errSpy).toHaveBeenCalled()
    expect(buttonByText(w, '上传本地数据到云端').classes()).not.toContain('van-button--loading')
  })
})

describe('SettingsView · 非创建者的写入收口（H6）', () => {
  it('caregiver：保存档案置灰、不写库、绝不提示「已保存」', async () => {
    isLoggedInRef.value = true
    currentRoleRef.value = 'caregiver'
    const w = await mountSettings()

    const btn = buttonByText(w, '保存档案')
    expect(btn.classes()).toContain('van-button--disabled')
    expect(w.text()).toContain('仅创建者可修改病人配置')

    await fieldInput(w, '轮椅及衣物重量').setValue('99')
    await btn.trigger('click')
    await flushPromises()

    // RLS 会静默拦掉这条写入，界面必须先拦住，绝不能提示成功
    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalledWith('已保存')
  })

  it('caregiver：干体重「＋ 新增」置灰、删除图标置灰且点了不删库', async () => {
    isLoggedInRef.value = true
    currentRoleRef.value = 'caregiver'
    const w = await mountSettings({
      dryWeights: [makeDryWeight({ id: 'd1', value: 60, effectiveDate: '2024-01-01' })],
    })

    expect(buttonByText(cardByTitle(w, '干体重历史'), '新增').classes()).toContain('van-button--disabled')
    await cardByTitle(w, '干体重历史').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).not.toHaveBeenCalled()
    expect(repository.deleteDryWeight).not.toHaveBeenCalled()
  })

  it('角色刷新回来后（弹窗已经开着）提交干体重也会被拦下，不写库', async () => {
    const w = await mountSettings() // 角色未知时可正常打开弹窗
    await buttonByText(cardByTitle(w, '干体重历史'), '新增').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '新增干体重')
    await fieldInput(popup, '干体重').setValue('58')

    // 模拟「云端把角色拉回来了」：非 owner 的提交必须被守卫拦下（不只是把按钮置灰）
    currentRoleRef.value = 'caregiver'
    await flushPromises()
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.saveDryWeight).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('仅创建者可修改病人配置')
  })

  it('owner 不受影响：保存档案照常写库并提示成功', async () => {
    isLoggedInRef.value = true
    currentRoleRef.value = 'owner'
    const w = await mountSettings()

    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('已保存')
  })

  it('角色还没拉到时（null）不锁界面：本地单机模式照常可编辑', async () => {
    const w = await mountSettings()

    expect(buttonByText(w, '保存档案').classes()).not.toContain('van-button--disabled')
    expect(w.text()).not.toContain('仅创建者可修改病人配置')
  })
})

describe('SettingsView · 版本号', () => {
  it('页面底部显示当前版本，用户不必去翻系统设置', async () => {
    const w = await mountSettings()

    // 测试跑在 jsdom，等同于网页端：网页端跟着部署走（SW 换新后自动重载），
    // 没有「装在手机上的哪一版」这个概念；原生端走 App.getInfo() 显示真实版本号
    expect(w.text()).toContain('网页版 · 自动更新')
  })
})

/**
 * 乐观锁：两个人同时改同一个病人的档案（轮椅及衣物重量 / 回水量）。
 * 整行覆盖的写法下，后保存的人会把先保存的人刚改的值静默抹掉。
 */
describe('SettingsView · 乐观锁（多人同时改病人档案）', () => {
  const IRS = '2024-01-10T09:00:00.000000+00:00'

  it('保存档案带上「我读到的版本」；冲突时弹确认、且绝不提示「已保存」', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', updatedAtIso: IRS }) })
    mocks.showConfirmDialog.mockResolvedValueOnce(undefined) // 选「重新加载」
    vi.mocked(repository.savePatient).mockRejectedValueOnce(
      Object.assign(new Error('冲突'), { name: 'ConflictError' }),
    )

    await fieldInput(w, '轮椅及衣物重量').setValue('25')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(vi.mocked(repository.savePatient).mock.calls[0][1]).toBe(IRS)
    expect(mocks.showConfirmDialog).toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalledWith('已保存')
  })

  it('冲突选「覆盖保存」：这次不带版本条件重写一次，用户改的值不丢', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', updatedAtIso: IRS }) })
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel')) // 选「覆盖保存」
    vi.mocked(repository.savePatient)
      .mockRejectedValueOnce(Object.assign(new Error('冲突'), { name: 'ConflictError' }))
      .mockResolvedValue('2024-01-10T11:00:00.000000+00:00')

    await fieldInput(w, '轮椅及衣物重量').setValue('26')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.savePatient).toHaveBeenCalledTimes(2)
    expect(vi.mocked(repository.savePatient).mock.calls[1][1]).toBeNull()
    expect(vi.mocked(repository.savePatient).mock.calls[1][0]).toMatchObject({ wheelchairWeight: 26 })
  })

  it('没读到版本号时（本地模式 / 新建档案）不带条件，照常保存', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(vi.mocked(repository.savePatient).mock.calls[0][1]).toBeNull()
  })
})

/**
 * 轮椅及衣物重量变更记录（需求②）的**运行时行为**。
 *
 * 为什么单独一组：`tests/unit/changeLog.spec.ts` 里那几条是「源码级断言」（读 SettingsView.vue
 * 的文本匹配），能钉住「有没有写这一行、顺序对不对」，但**钉不住运行时行为** ——
 * 把 `if (wheelchairChanged)` 改成恒真、或把 toast 三分支合并，源码正则都还可能过。
 * 这里用真实挂载 + mock 调用计数把关。守护的是三个具体缺陷：
 *   ① 重量没变也写日志 → 用户点十次「保存档案」就多十条假记录，历史失去意义
 *   ② oldValue 取错时机（在 patient.value 被覆盖之后取）→ 每条都是「X → X」，看不出变化
 *   ③ 日志写失败被判成「保存失败」→ 档案其实已存，用户反复点击重试
 */
describe('SettingsView · 轮椅及衣物重量变更记录（运行时行为）', () => {
  it('重量没变：不写变更记录（否则反复保存会刷出一堆无意义的历史）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 20 }) })

    // 什么都不改，直接保存
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    expect(repository.addPatientChangeLog).not.toHaveBeenCalled()
    expect(mocks.showToast).toHaveBeenCalledWith('已保存')
  })

  it('重量变了：写一条 old→new，且 oldValue 是保存前的值（不能在覆盖之后取）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })

    await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(1)
    const log = vi.mocked(repository.addPatientChangeLog).mock.calls[0][0]
    expect(log).toMatchObject({
      patientId: 'patient-default',
      field: 'wheelchairWeight',
      // 关键：13.4 是**保存前**的档案值。若在 patient.value = p 之后才取，这里会变成 13.5 → 13.5
      oldValue: 13.4,
      newValue: 13.5,
    })
    expect(log.changedAt).toBeGreaterThan(0)
    expect(mocks.showToast).toHaveBeenCalledWith('已保存')
  })

  it('变更记录写失败：档案仍算保存成功，但提示要明确区分（不能让用户以为档案也没存上）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })
    vi.mocked(repository.addPatientChangeLog).mockRejectedValueOnce(new Error('offline'))

    await fieldInput(w, '轮椅及衣物重量').setValue('14')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 档案确实写进去了
    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.savePatient).mock.calls[0][0]).toMatchObject({ wheelchairWeight: 14 })
    // 日志失败被自己吞掉，不会被当成保存失败去重试
    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('已保存，但变更记录未能写入（下次保存时会自动补记）')
    // 绝不能提示成「保存失败」
    const toasts = mocks.showToast.mock.calls.map((c) => String(c[0]))
    expect(toasts.some((t) => t.includes('保存失败'))).toBe(false)
  })

  /**
   * 评审 M2：**变更记录写失败后必须能补回来**。
   *
   * 原实现 `patient.value = p` 在写日志**之前**，所以日志失败后再点保存时
   * `wheelchairChanged` 为 false → 这条变更永久缺失，提示却只说「请检查网络」，
   * 用户检查完网络也不知道该做什么。而该功能的价值恰恰是「让用户信得过这份历史」。
   *
   * 修法：失败时把这次变更暂存，下次保存自动补写。
   */
  describe('评审 M2 · 变更记录写失败后下次保存自动补记', () => {
    it('第一次写日志失败 → 第二次保存（不改重量）自动补写同一条变更', async () => {
      const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })
      vi.mocked(repository.addPatientChangeLog).mockRejectedValueOnce(new Error('offline'))

      // 第一次：改重量 + 保存，日志写失败
      await fieldInput(w, '轮椅及衣物重量').setValue('14')
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()
      expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(1)
      expect(mocks.showToast).toHaveBeenCalledWith('已保存，但变更记录未能写入（下次保存时会自动补记）')

      // 第二次：什么都不改直接再保存 → 必须把上次那条补上
      mocks.showToast.mockClear()
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(2)
      const backfilled = vi.mocked(repository.addPatientChangeLog).mock.calls[1][0]
      // 补写的必须是「13.4 → 14」这条真实变更，不是凭空造的
      expect(backfilled).toMatchObject({
        patientId: 'patient-default',
        field: 'wheelchairWeight',
        oldValue: 13.4,
        newValue: 14,
      })
      expect(mocks.showToast).toHaveBeenCalledWith('已保存')
    })

    it('补写成功后不重复：再保存一次不会又写一遍（不会在历史里堆重复条目）', async () => {
      const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })
      vi.mocked(repository.addPatientChangeLog).mockRejectedValueOnce(new Error('offline'))

      await fieldInput(w, '轮椅及衣物重量').setValue('14')
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      // 第二次保存补写成功
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()
      expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(2)

      // 第三次保存：待补项已清空，不该再写
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()
      expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(2)
    })

    it('补写仍然失败：待补项保留，提示明确说「仍未能写入」，下次还能再补', async () => {
      const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })
      vi.mocked(repository.addPatientChangeLog)
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))

      await fieldInput(w, '轮椅及衣物重量').setValue('14')
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      mocks.showToast.mockClear()
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()
      expect(mocks.showToast).toHaveBeenCalledWith('已保存，但变更记录仍未能写入（下次保存时会自动补记）')

      // 网络恢复后的第三次保存要能补上（待补项没被丢弃）
      mocks.showToast.mockClear()
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()
      expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(3)
      const last = vi.mocked(repository.addPatientChangeLog).mock.calls[2][0]
      expect(last).toMatchObject({ oldValue: 13.4, newValue: 14 })
      expect(mocks.showToast).toHaveBeenCalledWith('已保存')
    })

    it('改重量 + 存在待补项：先补旧的再记新的，历史顺序不乱', async () => {
      const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })
      vi.mocked(repository.addPatientChangeLog).mockRejectedValueOnce(new Error('offline'))

      // 第一次：13.4 → 14，日志失败，进入待补
      await fieldInput(w, '轮椅及衣物重量').setValue('14')
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      // 第二次：再改成 15 并保存 → 应先补「13.4 → 14」，再写「14 → 15」
      await fieldInput(w, '轮椅及衣物重量').setValue('15')
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(3)
      const calls = vi.mocked(repository.addPatientChangeLog).mock.calls.map((c) => c[0])
      expect(calls[1]).toMatchObject({ oldValue: 13.4, newValue: 14 }) // 补写的旧变更
      expect(calls[2]).toMatchObject({ oldValue: 14, newValue: 15 }) // 本次新变更
    })

    /**
     * 待补项是**模块级变量**，跨病人切换时必须带上归属，否则会把 A 的变更记到 B 名下。
     *
     * 真实场景：A 病人改重量时断网 → 日志写失败、进入待补 → 用户切到 B 病人
     * （同一台手机上照护多位家属很常见）→ 在 B 的设置页保存任意字段 → 补写触发，
     * 把「A 的 13.4→14」写成 B 的变更记录。B 的变更历史里凭空多出一条从未发生过的改动，
     * 而 A 的那条永久缺失 —— 这份历史的可信度直接归零。
     */
    it('待补项不得串到别的病人，切回原病人后仍能补写', async () => {
      currentPatientIdRef.value = 'patient-a'
      const w = await mountSettings({ patient: makePatient({ id: 'patient-a', wheelchairWeight: 13.4 }) })
      vi.mocked(repository.addPatientChangeLog).mockRejectedValueOnce(new Error('offline'))

      // A 改重量 13.4 → 14，日志失败 → 进入待补
      await fieldInput(w, '轮椅及衣物重量').setValue('14')
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()
      expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(1)

      // 切到 B 病人，保存（不改重量）→ 不能触发 A 的补写
      currentPatientIdRef.value = 'patient-b'
      await w.vm.$nextTick()
      await flushPromises()
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      // B 名下绝不能出现任何变更记录
      const bCalls = vi
        .mocked(repository.addPatientChangeLog)
        .mock.calls.map((c) => c[0])
        .filter((l) => l.patientId === 'patient-b')
      expect(bCalls).toHaveLength(0)

      // 切回 A 后保存一次（不改重量）→ 待补项要能补写，且归属是 A（不是丢弃）
      currentPatientIdRef.value = 'patient-a'
      await w.vm.$nextTick()
      await flushPromises()
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      const backfilled = vi
        .mocked(repository.addPatientChangeLog)
        .mock.calls.map((c) => c[0])
        .find((l) => l.oldValue === 13.4 && l.newValue === 14 && l.patientId === 'patient-a')
      expect(backfilled).toBeTruthy()
    })
  })

  it('干体重变了但轮椅重量没变：不写变更记录（这个功能只记轮椅及衣物重量）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 20 }) })

    await fieldInput(w, '回水量').setValue('350')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    expect(repository.addPatientChangeLog).not.toHaveBeenCalled()
  })

  it('点「变更历史」读到失败：显示错误态 + 重试，绝不显示成「暂无变更记录」', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })
    vi.mocked(repository.listPatientChangeLogs).mockRejectedValueOnce(new Error('offline'))

    await buttonByText(w, '变更历史').trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('变更记录加载失败')
    // 关键：不能把「读失败」说成「没有记录」—— 那会让用户以为从没改过重量
    expect(text).not.toContain('暂无变更记录')
    expect(buttonByText(w, '重试').exists()).toBe(true)
    // 读的时候必须绕过缓存，否则刚改完看不到这一条
    expect(vi.mocked(repository.listPatientChangeLogs).mock.calls[0][1]).toEqual({ fresh: true })
  })

  /**
   * 第十一轮（用户截图反馈「没有记录却提示加载失败」）：
   * 生产库没执行 schema.sql → `patient_change_logs` 表不存在（实测 404 PGRST205）。
   * 原来的 catch 把所有异常归一成「请检查网络后重试」—— 用户换网络、点重试一万次也不会好，
   * 排查的人也只会往网络方向查。现在按错误码分开说。
   */
  it('变更历史读失败是「服务端缺表」时：提示联系管理员，不能说成网络问题', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })
    const schemaErr = Object.assign(new Error('Could not find the table'), { code: 'PGRST205' })
    vi.mocked(repository.listPatientChangeLogs).mockRejectedValueOnce(schemaErr)

    await buttonByText(w, '变更历史').trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('尚未在服务器启用')
    // 不能误导成网络问题：换网络、重试都不会好
    expect(text).not.toContain('请检查网络后重试')
    // 仍然不能说成「没有记录」
    expect(text).not.toContain('暂无变更记录')
  })

  /**
   * 轻微-2（第十二轮独立评审）：缺列（42703）与缺表（PGRST205）文案必须分开。
   * 两者都被 isSchemaMissingError 覆盖，但说「缺少数据库表」在缺列时会把排查方向引偏 ——
   * 而这次事故里「表不存在」和「列不存在」同时出现过。
   */
  it('变更历史读失败是「服务端缺列」（42703）时：文案说缺列，不说缺表', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })
    const colErr = Object.assign(new Error('column does not exist'), { code: '42703' })
    vi.mocked(repository.listPatientChangeLogs).mockRejectedValueOnce(colErr)

    await buttonByText(w, '变更历史').trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('尚未在服务器启用')
    expect(text).toContain('缺少数据库列')
    expect(text).not.toContain('缺少数据库表')
  })

  /**
   * 轻微-3（第十二轮独立评审）：PGRST301 是 JWT 无效/过期（登录态失效），
   * 不是「没有权限」—— 提示「请联系创建者」会让用户找错人（实际重登即可）。
   */
  it('变更历史读失败是「登录态失效」（PGRST301）时：引导重新登录，不说没权限', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })
    const jwtErr = Object.assign(new Error('JWT expired'), { code: 'PGRST301' })
    vi.mocked(repository.listPatientChangeLogs).mockRejectedValueOnce(jwtErr)

    await buttonByText(w, '变更历史').trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('登录状态已失效')
    expect(text).not.toContain('没有权限查看变更记录')
  })
  it('变更历史读失败是 RLS 拒绝时：提示没有权限', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })
    const rlsErr = Object.assign(new Error('permission denied'), { code: '42501' })
    vi.mocked(repository.listPatientChangeLogs).mockRejectedValueOnce(rlsErr)

    await buttonByText(w, '变更历史').trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('没有权限查看变更记录')
    expect(text).not.toContain('暂无变更记录')
  })

  /**
   * 问题 2（用户截图反馈 + 拍板）：变更历史按钮必须在轮椅及衣物重量那一行的右侧，
   * 不能单独占一行 —— 原来用 `.row` 的 flex space-between，把按钮挤到约 3 字宽、
   * 「变更历史」被折成两行。
   */
  it('变更历史按钮在轮椅及衣物重量那一行内（不单独占一行）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    // 找到 label 为「轮椅及衣物重量」的那个 van-field（van-cell）
    const cells = [...w.element.querySelectorAll('.van-cell')]
    const wcCell = cells.find((c) => c.textContent?.includes('轮椅及衣物重量'))
    expect(wcCell, '找不到轮椅及衣物重量那一行').toBeTruthy()

    // 按钮必须在这个 cell 内部（#button 插槽渲染在 .van-field__button 里）
    const btn = wcCell!.querySelector('.van-field__button button')
    expect(btn, '变更历史按钮不在该行的 #button 插槽里（又变成单独一行了）').toBeTruthy()
    expect(btn!.textContent).toContain('变更历史')

    // 旧的单独一行（.row 包着提示文字）必须已删除
    const oldRow = [...w.element.querySelectorAll('.row')].find((r) =>
      r.textContent?.includes('会随季节衣物变化'),
    )
    expect(oldRow, '旧的那一行提示文字还在（应该已移进弹窗）').toBeFalsy()
  })

  /** 问题 4（用户拍板）：提示文字移到弹窗标题下方一行灰字 */
  it('变更历史弹窗标题下方有「会随季节衣物变化」的说明', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })
    vi.mocked(repository.listPatientChangeLogs).mockResolvedValueOnce([])

    await buttonByText(w, '变更历史').trigger('click')
    await flushPromises()

    const popup = w.element.querySelector('.van-popup')
    expect(popup, '弹窗没渲染').toBeTruthy()
    expect(popup!.textContent).toContain('会随季节衣物变化')
    // 没有记录时仍要说「暂无」，而不是加载失败
    expect(popup!.textContent).toContain('暂无变更记录')
  })
  it('变更历史按倒序展示 old→new / 时间 / 变更人；老记录没有变更人时显示「未记录」', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })
    vi.mocked(repository.listPatientChangeLogs).mockResolvedValueOnce([
      makeChangeLog({ id: 'c1', oldValue: 14, newValue: 14.5, operator: '张三', changedAt: 1_700_000_200_000 }),
      makeChangeLog({ id: 'c2', oldValue: 13.4, newValue: 14, operator: null, changedAt: 1_700_000_100_000 }),
    ])

    await buttonByText(w, '变更历史').trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('14.0kg → 14.5kg')
    expect(text).toContain('13.4kg → 14.0kg')
    expect(text).toContain('张三')
    expect(text).toContain('未记录')
  })

  /**
   * M-2（独立评审）：待补项原来是**单槽 + 组件实例级变量**，两个后果：
   * ① 连续两次失败时后一条把前一条顶掉；② 离开 `/settings` 即卸载，变量销毁 → 再也补不上。
   *
   * 修法：改成持久化到 localStorage 的**数组队列**。下面两条分别钉住这两点。
   */
  it('连续两次「改重量 + 日志写失败」：两条待补项都要保留，网络恢复后按顺序全部补写', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })

    // 前三次写日志都失败（第一次 append、第二次保存前的 flush、第二次 append），
    // 之后成功。**只记录成功的写入** —— 失败调用也留在 mock.calls 里，
    // 用 `toContain` 断言调用过等于自欺（失败的那次也叫「调用过」）。
    const written: string[] = []
    let attempts = 0
    vi.mocked(repository.addPatientChangeLog).mockImplementation(async (log) => {
      attempts += 1
      if (attempts <= 3) throw new Error('offline')
      written.push(`${log.oldValue}->${log.newValue}`)
      return undefined as never
    })

    // 第一次：13.4 → 13.5（失败）
    await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 第二次：13.5 → 13.6（又失败）
    await fieldInput(w, '轮椅及衣物重量').setValue('13.6')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 第三次保存（网络恢复）→ 两条待补项都要补上
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 关键：两条都必须**成功写入**，且老的在前
    expect(written).toEqual(['13.4->13.5', '13.5->13.6'])
    // 补完队列必须清空
    expect(localStorage.getItem('dialysis-pending-wheelchair-logs')).toBeNull()
  })

  it('写失败后离开设置页再回来（组件重新挂载）：待补项仍在，保存时能补写', async () => {
    currentPatientIdRef.value = 'patient-default'
    const w1 = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })
    vi.mocked(repository.addPatientChangeLog).mockRejectedValueOnce(new Error('offline'))

    await fieldInput(w1, '轮椅及衣物重量').setValue('13.5')
    await buttonByText(w1, '保存档案').trigger('click')
    await flushPromises()

    // 卸载（= 用户离开 /settings 去了别的页面）
    w1.unmount()

    // 重新挂载（= 用户回来），网络已恢复
    vi.mocked(repository.addPatientChangeLog).mockClear()
    const w2 = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.5 }) })
    // 不改任何字段，直接保存 → 应触发补写
    await buttonByText(w2, '保存档案').trigger('click')
    await flushPromises()

    const written = vi
      .mocked(repository.addPatientChangeLog)
      .mock.calls.map((c) => `${c[0].oldValue}->${c[0].newValue}`)
    expect(written).toContain('13.4->13.5')
  })

  /**
   * D1（第三轮独立评审）：补写循环「失败就 continue」会让历史**倒序**。
   *
   * 场景：队列里有两条待补项 [13.4→13.5, 13.5→13.6]，第 1 条偶发失败、第 2 条恰好成功。
   * 旧实现继续试第 2 条 → 13.5→13.6 先落库，历史变成
   * 「13.5→13.6，13.4→13.5」—— 倒着长。而变更历史的意义就是「可信」，
   * 倒置比缺失更误导（用户会以为中间那次是错的）。
   *
   * 修法：失败即 break，把失败的这条和它后面**还没试的**按原顺序放回队列。
   *
   * ⚠️ 这条用例必须断言「第一次补写**只尝试了 1 条**」，只断言最终顺序会被
   * 「先成功后失败」等其他路径蒙过去（评审实测：把实现改成 break 版本，
   * 原有 1739 条用例全绿，说明旧用例对这个交叉场景零判别力）。
   */
  it('补写时第 1 条失败、第 2 条本可成功：必须停下，不能让历史倒序', async () => {
    currentPatientIdRef.value = 'patient-default'
    // 预置两条待补项（模拟之前两次保存都写日志失败）
    localStorage.setItem(
      'dialysis-pending-wheelchair-logs',
      JSON.stringify([
        { patientId: 'patient-default', oldValue: 13.4, newValue: 13.5 },
        { patientId: 'patient-default', oldValue: 13.5, newValue: 13.6 },
      ]),
    )

    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.6 }) })

    // 补写：第 1 次调用失败，第 2 次本会成功 —— 但正确实现根本不该发第 2 次
    const attempted: string[] = []
    const written: string[] = []
    let calls = 0
    vi.mocked(repository.addPatientChangeLog).mockImplementation(async (log) => {
      calls += 1
      const key = `${log.oldValue}->${log.newValue}`
      attempted.push(key)
      if (calls === 1) throw new Error('offline') // 第 1 条失败
      written.push(key)
      return undefined as never
    })

    // 不改重量，直接保存 → 只触发补写
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 关键 1：只尝试了第 1 条，第 2 条**不该被尝试**（否则它就先落库了）
    expect(attempted).toEqual(['13.4->13.5'])
    expect(written).toEqual([])

    // 关键 2：两条都还在队列里，且顺序不变
    const queued = JSON.parse(localStorage.getItem('dialysis-pending-wheelchair-logs') || '[]')
    expect(queued.map((x: { oldValue: number; newValue: number }) => `${x.oldValue}->${x.newValue}`)).toEqual([
      '13.4->13.5',
      '13.5->13.6',
    ])
  })

  it('补写时第 1 条失败、第 2 条本可成功：网络恢复后历史顺序仍是老的在前', async () => {
    currentPatientIdRef.value = 'patient-default'
    localStorage.setItem(
      'dialysis-pending-wheelchair-logs',
      JSON.stringify([
        { patientId: 'patient-default', oldValue: 13.4, newValue: 13.5 },
        { patientId: 'patient-default', oldValue: 13.5, newValue: 13.6 },
      ]),
    )

    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.6 }) })

    const written: string[] = []
    let calls = 0
    vi.mocked(repository.addPatientChangeLog).mockImplementation(async (log) => {
      calls += 1
      if (calls === 1) throw new Error('offline') // 第一次保存：第 1 条失败
      written.push(`${log.oldValue}->${log.newValue}`)
      return undefined as never
    })

    // 第一次保存：补写失败即停
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 第二次保存：网络恢复，两条按顺序补上
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 历史顺序必须是老的在前（倒序会让用户以为中间那次改动是错的）
    expect(written).toEqual(['13.4->13.5', '13.5->13.6'])
    expect(localStorage.getItem('dialysis-pending-wheelchair-logs')).toBeNull()
  })

  /**
   * D2（第三轮独立评审）：`localStorage` 存不下时队列静默丢失，
   * 而 toast 仍承诺「下次保存时会自动补记」—— 文案在撒谎。
   *
   * 真实场景：iOS 无痕模式 / 存储配额满。用户看到「下次会自动补记」就不再管了，
   * 下次保存时 toast 变成「已保存」（因为队列已空、`flushed` 返回 true），
   * 这条变更**永久缺失**，而用户以为它是齐的。
   *
   * 修法：`writePendingWheelchairLogs` 返回布尔，存不下时如实说「这条变更记录将缺失」。
   */
  it('本机存不下待补队列（隐私模式/配额满）：必须如实告知会缺失，不能承诺「下次自动补记」', async () => {
    currentPatientIdRef.value = 'patient-default'
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.4 }) })

    // 写日志失败 + localStorage.setItem 抛错（隐私模式/配额满）
    vi.mocked(repository.addPatientChangeLog).mockRejectedValue(new Error('offline'))
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    try {
      await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      const toast = toastText()
      // 关键：不能承诺「下次保存时会自动补记」——队列根本没存下
      expect(toast).not.toContain('下次保存时会自动补记')
      expect(toast).toContain('缺失')
      // 队列确实是空的（存不下）
      expect(localStorage.getItem('dialysis-pending-wheelchair-logs')).toBeNull()
    } finally {
      setItemSpy.mockRestore()
    }
  })

  /**
   * S-1（独立评审）：`appendWheelchairLog` 在 `await savePatient(...)` **之后**才读
   * `currentPatientId.value` —— 保存期间切病人，档案写对了人、变更记录却写到别人名下。
   *
   * 触发路径真实存在：设置页的病人列表行 `@click="switchPatient(...)"` 没有 disabled 保护，
   * `switchPatient` 也不检查 `savingPatient`；弱网下 `savePatient` 是秒级等待，
   * 护工等不及去点另一个病人完全现实。
   *
   * 后果：A 的历史永久缺一条真实改动，B 的历史凭空多一条从未发生的改动。
   */
  it('保存档案在途时切病人：变更记录仍归原病人，不能写到新病人名下', async () => {
    currentPatientIdRef.value = 'patient-a'
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', wheelchairWeight: 13.4 }) })

    // 让 savePatient 挂住，模拟弱网下的秒级等待
    let releaseSave!: () => void
    vi.mocked(repository.savePatient).mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseSave = () => resolve('2026-01-01T00:00:00.000000+00:00')
      }),
    )

    await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 保存还在途中 —— 用户切到 B 病人
    currentPatientIdRef.value = 'patient-b'
    await w.vm.$nextTick()
    await flushPromises()

    // 放行保存
    releaseSave()
    await flushPromises()

    // 变更记录必须归属 A（发起保存时的那位），不能是 B
    expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(1)
    const log = vi.mocked(repository.addPatientChangeLog).mock.calls[0][0]
    expect(log.patientId).toBe('patient-a')
    expect(log).toMatchObject({ oldValue: 13.4, newValue: 13.5 })
  })

  /**
   * 中级-5（第三轮独立评审）：`flushPendingWheelchairLog` 丢弃了队列写回结果。
   *
   * 场景（Safari 无痕 / 配额满）：`setItem` 抛错但 `removeItem` 正常，队列里还有**别的病人**的
   * 待补项 → 补写成功后写回 `remaining` 失败 → 成功的那条仍留在磁盘上 → 下次 flush 再写一遍。
   * 变更历史里出现两条一模一样的记录，而 toast 说「已保存」，用户无法判断哪条是真的。
   *
   * 修法：检查写回结果，失败时不能报「已保存」。
   */
  it('补写成功后队列写不回（配额满）：不能报「已保存」，否则下次会重复写同一条', async () => {
    currentPatientIdRef.value = 'patient-a'
    // 队列里同时有 A（本病人，会补写成功）和 B（别的病人，必须写回磁盘 → 触发 setItem）
    localStorage.setItem(
      'dialysis-pending-wheelchair-logs',
      JSON.stringify([
        { patientId: 'patient-a', oldValue: 13.4, newValue: 13.5, changedAt: 1_700_000_000_000 },
        { patientId: 'patient-b', oldValue: 20, newValue: 21, changedAt: 1_700_000_100_000 },
      ]),
    )
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', wheelchairWeight: 13.5 }) })

    // 补写成功；但写回队列（setItem）抛错
    vi.mocked(repository.addPatientChangeLog).mockResolvedValue(undefined as never)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    try {
      await buttonByText(w, '保存档案').trigger('click')
      await flushPromises()

      // 关键：队列没清干净，绝不能报「已保存」（否则用户以为补完了）
      expect(mocks.showToast).not.toHaveBeenCalledWith('已保存')
      expect(mocks.showToast).toHaveBeenCalledWith('已保存，但变更记录仍未能写入（下次保存时会自动补记）')
    } finally {
      setItemSpy.mockRestore()
    }
  })

  /**
   * 中级-6（第三轮独立评审）：待补项原来不存「变更发生时刻」，补写时取 `Date.now()`。
   *
   * 历史按 `changedAt` 倒序排 → 10:00 的变更补写时被盖上 11:00 的时间戳，
   * 排到 10:30 那条**之后**，历史倒着长。D1 的 `break` 只管同一次 flush 内部，
   * 管不住「补写条目 vs 之后实时写入的条目」。
   *
   * 判别力：把 `appendWheelchairLog` 的 `changedAt` 参数去掉（退回 `Date.now()`）→ 本用例红。
   */
  it('补写时用的是「变更发生时刻」，不是「补写时刻」（否则历史按补写顺序倒排）', async () => {
    currentPatientIdRef.value = 'patient-default'
    const changedAt = 1_700_000_000_000 // 10:00 发生的变更
    localStorage.setItem(
      'dialysis-pending-wheelchair-logs',
      JSON.stringify([{ patientId: 'patient-default', oldValue: 13.4, newValue: 13.5, changedAt }]),
    )
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.5 }) })
    vi.mocked(repository.addPatientChangeLog).mockResolvedValue(undefined as never)

    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    const written = vi.mocked(repository.addPatientChangeLog).mock.calls[0][0]
    expect(written).toMatchObject({ oldValue: 13.4, newValue: 13.5 })
    // 必须是变更发生时刻，不是补写时的 Date.now()
    expect(written.changedAt).toBe(changedAt)
  })

  /**
   * 中级-6 的兼容性：升级前存下的队列没有 `changedAt` 字段，
   * 读出时必须补成有效数字（否则 NaN 会把排序彻底打乱）。
   */
  it('旧队列没有 changedAt 字段：读出时补成有效时间，不产生 NaN', async () => {
    currentPatientIdRef.value = 'patient-default'
    // 故意不带 changedAt（模拟升级前的队列）
    localStorage.setItem(
      'dialysis-pending-wheelchair-logs',
      JSON.stringify([{ patientId: 'patient-default', oldValue: 13.4, newValue: 13.5 }]),
    )
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.5 }) })
    vi.mocked(repository.addPatientChangeLog).mockResolvedValue(undefined as never)

    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    const written = vi.mocked(repository.addPatientChangeLog).mock.calls[0][0]
    expect(Number.isFinite(written.changedAt)).toBe(true)
    expect(written.changedAt).toBeGreaterThan(0)
  })

  /**
   * 第四轮自查（由「flush 返回值被丢弃」这个模式扫出来的同类问题）：
   * `wheelchairChanged` 分支里 `await flushPendingWheelchairLog()` 的返回值原来也被丢弃。
   *
   * 场景：队列里有一条旧待补项补不上，但**本次**这条变更写成功了 →
   * 旧实现 toast「已保存」，用户以为历史齐了，实际还缺一条。
   * 本次成功 ≠ 历史完整。
   */
  it('旧待补项没补上但本次写成功：不能说「已保存」，要说明此前的仍缺', async () => {
    currentPatientIdRef.value = 'patient-default'
    // 预置一条补不上的旧待补项（13.5→13.6），本次要改的是 13.6→13.7
    localStorage.setItem(
      'dialysis-pending-wheelchair-logs',
      JSON.stringify([{ patientId: 'patient-default', oldValue: 13.5, newValue: 13.6, changedAt: 1 }]),
    )
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', wheelchairWeight: 13.6 }) })

    // 第 1 次调用（补旧的那条）失败，第 2 次（本次这条）成功
    let calls = 0
    vi.mocked(repository.addPatientChangeLog).mockImplementation(async () => {
      calls += 1
      if (calls === 1) throw new Error('offline')
      return undefined as never
    })

    await fieldInput(w, '轮椅及衣物重量').setValue('13.7')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 本次写成功了，但旧的那条仍缺 → 不能报「已保存」
    expect(mocks.showToast).not.toHaveBeenCalledWith('已保存')
    expect(mocks.showToast).toHaveBeenCalledWith('已保存，但此前的变更记录仍未能写入（下次保存时会自动补记）')
    // 旧待补项必须仍在队列里
    const queued = JSON.parse(localStorage.getItem('dialysis-pending-wheelchair-logs') || '[]')
    expect(queued.map((x: { oldValue: number; newValue: number }) => `${x.oldValue}->${x.newValue}`)).toEqual([
      '13.5->13.6',
    ])
  })

  /**
   * `switchPatient` 的「加载在途」守卫（第四轮自查补测）：
   * 加载在途时切病人，同样会让甲的档案落到乙的上下文 —— 与严重-1 同类。
   *
   * ⚠️ 守卫用的是独立的 `reloading` 标记，不是首屏骨架的 `loading`：
   * `loading` 只在首次加载时为 true，之后再也不置 true → 拿它做守卫就是死代码
   * （第四轮自查实测：`loading` 版本在首屏后永远不成立）。
   * 而让 `load()` 每次都置 `loading = true` 又会把整页换成骨架屏（打挂迁移用例）。
   *
   * 判别力：去掉 `if (reloading.value)` 分支 → 本用例红。
   */
  it('加载在途时调用 switchPatient：必须挡住并提示', async () => {
    currentPatientIdRef.value = 'patient-a'
    // ⚠️ 必须让 setCurrentPatientId 真的改 ref，否则第二次调用会命中
    // `if (id === currentPatientId.value) return`（同 id 早退，轻微-1 调整后的正确行为），
    // 测到的是「点自己那一行」而不是「加载在途」。
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })

    // 让下一次 load 挂住 → reloading 停在 true
    vi.mocked(repository.getPatient).mockReturnValue(new Promise(() => {}) as never)
    const vm = w.vm as unknown as { switchPatient: (id: string) => Promise<void> }
    // 先触发一次挂住的加载（不 await，让它停在 await 上）
    void vm.switchPatient('patient-b')
    await flushPromises()

    // 此时 reloading 为 true：再切到**另一个**病人必须被挡
    mocks.showToast.mockClear()
    await vm.switchPatient('patient-c')
    await flushPromises()
    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再切换')
    expect(currentPatientIdRef.value, '加载在途时不该真的切走').toBe('patient-b')
  })

  /**
   * `load()` 的失败路径（第四轮测试评审：M20 变异——去掉 `loadError.value = ...` 后全绿）。
   *
   * 弱网 / 令牌失效时首次加载失败：骨架必须收起，给出可点的「重试」。
   * 没有这条出口，用户只能杀进程（这是此前轮次在首页/详情页修过同类问题，
   * 设置页的 `catch` 是后来补的，但一直没被用例守住）。
   *
   * 判别力：删掉 catch 里的 `loadError.value = '加载失败，请检查网络后重试'` → 本用例红。
   */
  it('档案加载失败：收起骨架并给出可点的「重试」，不能停在空白页', async () => {
    vi.mocked(repository.getPatient).mockRejectedValueOnce(new Error('offline'))
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    // 错误态必须可见，且不是骨架
    expect(w.find('.load-error').exists()).toBe(true)
    expect(w.find('.load-error-text').text()).toBe('加载失败，请检查网络后重试')
    expect(w.find('.van-skeleton').exists()).toBe(false)

    // 「重试」必须真的能重新加载（点了之后走成功路径，表单正常回填）
    vi.mocked(repository.getPatient).mockResolvedValue(makePatient({ id: 'patient-default', name: '重试成功' }))
    await buttonByText(w.find('.load-error'), '重试').trigger('click')
    await flushPromises()
    expect(w.find('.load-error').exists()).toBe(false)
    expect(fieldInput(w, '姓名').element.value).toBe('重试成功')
  })

  /**
   * 「重新加载不得渲染首屏骨架」（第四轮测试评审 M25）：
   *
   * 原来唯一抓到「`load()` 误把 `loading` 置 true」的是一条与骨架语义无关的断言
   * （迁移用例里 `btn.classes()` 不含 `van-button--loading`）。用错用例兜对语义 =
   * 漏测，所以这里直接钉住「重载期间不得出现骨架屏」。
   *
   * 判别力：让 `load()` 入口置 `loading.value = true` → 本用例红。
   */
  it('重新加载（非首屏）期间不得渲染骨架屏：不能把用户正在看的表单换成占位块', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '张三' }) })
    // 首屏已经好了：没有骨架
    expect(w.find('.van-skeleton').exists()).toBe(false)

    // 让重载挂住，观察这期间页面是否被换成骨架
    let release!: (v: ReturnType<typeof makePatient>) => void
    vi.mocked(repository.getPatient).mockReturnValue(
      new Promise((resolve) => {
        release = resolve as never
      }) as never,
    )
    const vm = w.vm as unknown as { load: (force?: boolean) => Promise<void> }
    void vm.load(true)
    await flushPromises()

    // 关键：重载在途时不能有骨架屏，表单仍在
    expect(w.find('.van-skeleton').exists()).toBe(false)
    expect(fieldInput(w, '姓名').element.value).toBe('张三')

    release(makePatient({ id: 'patient-default', name: '李四' }))
    await flushPromises()
    expect(fieldInput(w, '姓名').element.value).toBe('李四')
  })

  /**
   * `load()` 的 pid 复查早退（第四轮测试评审 M06 + M04）：
   *
   * 两处 `await` 后复查「当前病人还是不是发起时那位」，不一致就 `return`。
   * 早退必须走 `finally` 把 `reloading` 复位，否则**下一次**切病人会被
   * 「正在加载病人档案」永久挡住（用户再也无法切换）。
   * 而且要确认：旧 load 返回后不能把甲的档案写进乙的页面。
   *
   * 判别力：去掉 `if (currentPatientId.value !== pid) return` → 本用例红。
   */
  it('加载期间切走：旧加载结果不能落到新病人页面，且 reloading 必须复位', async () => {
    currentPatientIdRef.value = 'patient-a'
    // ⚠️ 首屏必须正常完成：`mountSettings` 内部会 `stubSettingsData()` 覆盖 getPatient 的
    // mock，所以挂起要放在**挂载之后**、再手动触发第二次 load。
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    expect(fieldInput(w, '姓名').element.value).toBe('甲')

    let releaseLoad!: (v: ReturnType<typeof makePatient>) => void
    vi.mocked(repository.getPatient).mockReturnValue(
      new Promise((resolve) => {
        releaseLoad = resolve as never
      }) as never,
    )
    const vm = w.vm as unknown as {
      load: (force?: boolean) => Promise<void>
      switchPatient: (id: string) => Promise<void>
    }
    // 触发第二次加载（pid = patient-a）并挂住
    void vm.load(true)
    await flushPromises()

    // 挂住期间切到乙；表单仍是甲（用户没输入过，但当前病人已经是乙）
    currentPatientIdRef.value = 'patient-b'
    // 放行：返回的是**甲**的档案（带明显不同的姓名，方便断言）
    releaseLoad(makePatient({ id: 'patient-a', name: '甲的旧档案', wheelchairWeight: 13.4 }))
    await flushPromises()

    // 关键：旧加载结果必须被丢弃，页面不能被回填成甲的旧档案
    // （pid 复查在 await 之后挡住；没有它，这里会被写成「甲的旧档案」，
    //  下一次保存就是乙的 id + 甲的值 —— 严重-1 的根因）
    expect(fieldInput(w, '姓名').element.value).toBe('甲')

    // 而且 reloading 必须已复位 —— 用「再切一次没被挡住」来证明
    mocks.showToast.mockClear()
    vi.mocked(repository.getPatient).mockResolvedValue(makePatient({ id: 'patient-b', name: '乙' }))
    await vm.switchPatient('patient-a')
    await flushPromises()
    expect(mocks.showToast).not.toHaveBeenCalledWith('正在加载病人档案，请稍候再切换')
    expect(mocks.showToast).toHaveBeenCalledWith('已切换病人')
  })

  /**
   * `savePatient` 的 pid 复查（第四轮测试评审 M04：去掉 `===` 判断后全绿）。
   *
   * 严重-1 的另一半：保存已经发出、还没回来时用户切到了别处。
   * 若此时无条件回写 `patient.value` / `knownPatientUpdatedAtIso` / `formSnapshot`，
   * 页面就变成「乙的 id + 甲的版本号和表单」，下一次保存直接把甲的值写进乙。
   *
   * 这里用「放行保存后再改一次重量并保存」来间接断言：如果回写被污染，
   * `prevWheelchair` 会取到错的值，写出的日志与 `savePatient` 的 id 对不上。
   *
   * 判别力：把 `if (currentPatientId.value === p.id)` 改成 `if (true)` → 本用例红。
   */
  it('保存期间切走病人：不能把甲的版本号与表单回写到乙的页面', async () => {
    currentPatientIdRef.value = 'patient-a'
    let releaseSave!: () => void
    vi.mocked(repository.savePatient).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve('2026-01-01T00:00:00.000000+00:00')
        }),
    )
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', wheelchairWeight: 13.4 }) })
    await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 保存还没回来，切到乙
    currentPatientIdRef.value = 'patient-b'
    await w.vm.$nextTick()
    releaseSave()
    await flushPromises()

    // 已明确告知「当前页面未更新」（另一条用例断言过这句 toast）
    // 关键：`patient.value` **不能**被回写成刚保存的甲档案（13.5）——
    // 那是当前页面的状态，而当前病人已经是乙。若被回写，下一次保存时
    // 会拿甲的 id/版本号/表单值去写乙的档案（严重-1 的根因）。
    // 直接读组件内部的 patient ref（setupState）来证明，不靠间接推断。
    // setupState 里的 ref 已被 Vue 解包：直接是档案对象，不是 { value }
    const setupState = (w.vm as unknown as { $: { setupState: Record<string, unknown> } }).$.setupState
    const patientVal = setupState.patient as { wheelchairWeight?: number } | undefined
    expect(patientVal?.wheelchairWeight).not.toBe(13.5)
    // 而且这次保存不能额外写出一条「phantom」变更日志（中级-4）
    expect(repository.addPatientChangeLog).toHaveBeenCalledTimes(1)
    const log = vi.mocked(repository.addPatientChangeLog).mock.calls[0][0]
    expect(log.patientId).toBe('patient-a')
    expect(log).toMatchObject({ oldValue: 13.4, newValue: 13.5 })
  })

  /**
   * 保存档案的 in-flight 守卫（第四轮测试评审 M27）。
   *
   * ⚠️ 按钮上已经有 `:disabled="!canEditConfig || savingPatient"` 挡住后续点击，
   * 所以**点按钮连点测不到**函数内的 `if (savingPatient.value) return`（实测：删掉
   * 那个 return 后点按钮的用例照样绿）。要测第二道防线必须直接调方法 ——
   * 它在真实路径上并非多余：`resolvePatientConflict()` 的「覆盖保存」重试、
   * 以及将来任何程序化调用都不会经过按钮的 disabled。
   *
   * 连点的后果：两次 savePatient 并发，第二次用**旧的** `knownPatientUpdatedAtIso`
   * 去写 → 自己跟自己冲突（弹「另一端改了」的假冲突窗）。
   *
   * 判别力：删掉 `if (savingPatient.value) return` → 本用例红。
   */
  it('保存档案：函数级 in-flight 守卫（按钮 disabled 之外的第二道防线）', async () => {
    let releaseSave!: () => void
    vi.mocked(repository.savePatient).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve('2026-01-01T00:00:00.000000+00:00')
        }),
    )
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '张三' }) })
    await fieldInput(w, '姓名').setValue('张三丰')

    const vm = w.vm as unknown as { savePatient: () => Promise<void> }
    // 并发发起三次（不 await 第一次，模拟程序化重入）
    void vm.savePatient()
    void vm.savePatient()
    void vm.savePatient()
    await flushPromises()

    expect(repository.savePatient).toHaveBeenCalledTimes(1)

    releaseSave()
    await flushPromises()
    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    expect(mocks.showToast).toHaveBeenCalledWith('已保存')
  })

  /**
   * `savePatient` 的 else 分支（第四轮测试评审 M22：删掉这句 toast 后全绿）。
   *
   * 严重-1 的修复有两半：①挡住「保存在途时切病人」；②万一已经切走了，
   * 保存结果不能污染当前页面，并且**必须告诉用户**当前页没跟着更新。
   * ②这一半一直没有用例（全仓搜「保存期间切换了病人」= 0 处）。
   *
   * 判别力：删掉 else 分支的 `showToast('已保存（保存期间切换了病人，当前页面未更新）')` → 本用例红。
   */
  it('保存期间切走了病人：结果不回写当前页面，但必须告诉用户「当前页未更新」', async () => {
    currentPatientIdRef.value = 'patient-a'
    let releaseSave!: () => void
    vi.mocked(repository.savePatient).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve('2026-01-01T00:00:00.000000+00:00')
        }),
    )
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await fieldInput(w, '姓名').setValue('甲改')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 保存还没回来，用户切到了乙（直接改 ref 模拟「已在别处切走」）
    currentPatientIdRef.value = 'patient-b'
    await w.vm.$nextTick()

    releaseSave()
    await flushPromises()

    // 必须明确告知：存上了，但当前页不会跟着变
    expect(mocks.showToast).toHaveBeenCalledWith('已保存（保存期间切换了病人，当前页面未更新）')
  })

  /**
   * 严重-1 的漏网路径（第四轮源码评审取证坐实，见下方实测输出）：
   *
   * `switchPatient` 里 `setCurrentPatientId(乙)` 在 `await refreshCurrentRole()` **之前**执行，
   * 而 `reloading` 原来要到 `load(true)` 才置 true。这段窗口（弱网下 1~15 秒）里：
   * 当前病人 id 已是乙、表单还是甲的（姓名「甲」/生日/轮椅 13.4）、保存按钮可点。
   * 取证实测（修复前）：
   *   `>>> 点乙后 pid = patient-b ｜reloading = false ｜savingPatient = false`
   *   `>>> 第 1 次 = {"id":"patient-b","name":"甲","birthday":"1960-01-01",…,"updatedAtIso":null}`
   *   `>>> toast = ["已保存"]`
   * 即**甲的姓名生日被直接覆盖进乙的档案**，且 null 版本号绕过乐观锁，页面还报「已保存」。
   *
   * 修法：整个切换流程持有 `reloading`（在 setCurrentPatientId 之前置位），
   * 并且 `savePatient` 在 reloading 期间拒绝保存。
   *
   * 判别力：去掉 `savePatient` 的 reloading 守卫、或把置位挪到 refreshCurrentRole 之后 → 本用例红。
   */
  it('切换病人途中（角色刷新在途）点保存：必须拒绝，不能把甲的姓名写进乙的档案', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    // `setCurrentPatientId` 在本 spec 里是空 mock，这里让它真的改 ref ——
    // 否则测不出「pid 已切到乙、表单还是甲的」这个窗口
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲', birthday: '1960-01-01', wheelchairWeight: 13.4 }),
    })
    await flushPromises()

    // 切到乙之后，`load(true)` 会拿乙的档案回填表单
    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      id === 'patient-b'
        ? makePatient({ id: 'patient-b', name: '乙' })
        : makePatient({ id: 'patient-a', name: '甲' }),
    )

    // 让 refreshCurrentRole 挂住（真实实现是一次网络请求，弱网下 1~15 秒）
    let releaseRole!: () => void
    mocks.refreshCurrentRole.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRole = resolve
        }),
    )

    const rowB = w.findAll('.row').find((r) => r.text().includes('乙'))
    expect(rowB, '找不到乙那一行').toBeTruthy()
    void rowB!.trigger('click')
    await flushPromises()

    // 此刻：pid 已是乙，但表单还是甲的
    expect(currentPatientIdRef.value).toBe('patient-b')
    expect(fieldInput(w, '姓名').element.value).toBe('甲')

    // 用户在这段窗口里改了重量并点保存 —— 必须被拒绝
    await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
    mocks.showToast.mockClear()
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再保存')
    expect(repository.savePatient).not.toHaveBeenCalled() // 一次都不能写

    releaseRole()
    await flushPromises()
    // 切换完成后表单必须换成乙的档案，不能残留甲的
    expect(fieldInput(w, '姓名').element.value).toBe('乙')
  })

  /**
   * 漏洞 A（第五轮测试评审坐实）：`load()` 抢走 `switchPatient` 的 `reloading` 所有权。
   *
   * 真实可达的顺序是：**先点切换病人**（此时没有加载在途，通过守卫并持有标记），
   * 再点「删除干体重」—— `removeDw()` 里 `await load()` 会发网络请求，
   * 它返回时的 `finally` 在布尔方案下会把 `switchPatient` 持有的标记一起清掉。
   *
   * ⚠️ 反过来（先删干体重再切换）**不可达**：`switchPatient` 的 `if (reloading.value)`
   * 会直接挡住并提示「正在加载病人档案，请稍候再切换」（实测确认）。所以本用例必须按
   * 「先切换、后删干体重」的顺序构造，否则测的是被守卫挡住的路径、拿不到判别力。
   *
   * 修法：`reloading` 从布尔改成**计数器**，每个持有者只释放自己那一份。
   *
   * 判别力：把 `beginReloading()` 换回 `reloading.value = true/false` → 本用例红。
   */
  it('切换病人途中又触发干体重重载：load 不能抢走切换的 in-flight 持有权', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲', birthday: '1960-01-01', wheelchairWeight: 13.4 }),
      dryWeights: [makeDryWeight({ id: 'dw-1', patientId: 'patient-a', weight: 60 })],
    })
    await flushPromises()

    const vm = w.vm as unknown as {
      removeDw: (id: string) => Promise<void>
      switchPatient: (id: string) => Promise<void>
    }

    // ① 先切到乙：refreshCurrentRole 挂住 → switchPatient 持有 1 份
    let releaseRole!: () => void
    mocks.refreshCurrentRole.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRole = resolve
        }),
    )
    void vm.switchPatient('patient-b')
    await flushPromises()
    expect(currentPatientIdRef.value).toBe('patient-b')

    // ② 切换在途时用户又点了「删除干体重」：removeDw 内部的 load 挂住
    let releaseLoad!: () => void
    vi.mocked(repository.getPatient).mockReturnValue(
      new Promise((resolve) => {
        releaseLoad = () => resolve(makePatient({ id: 'patient-b', name: '乙' }) as never)
      }) as never,
    )
    void vm.removeDw('dw-1')
    await flushPromises()

    // ③ 放行干体重那次 load —— 布尔方案下它会把 switchPatient 的标记一起清掉
    releaseLoad()
    await flushPromises()

    // 关键：切换还没完成（refreshCurrentRole 仍挂住），reloading 必须仍为 true
    const setupState = (w.vm as unknown as { $: { setupState: Record<string, unknown> } }).$.setupState
    expect(
      setupState.reloading as boolean,
      'reloading 被干体重那次 load 提前清掉了 → 保存守卫失效',
    ).toBe(true)

    // 于是点保存必须被拒绝（否则写出「乙的 id + 甲的姓名生日」）
    mocks.showToast.mockClear()
    vi.mocked(repository.savePatient).mockClear()
    await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(repository.savePatient).not.toHaveBeenCalled()

    releaseRole()
    await flushPromises()
  })

  /**
   * 漏洞 B（第五轮测试评审坐实）：`onCreatePatient` 的窗口没有 `reloading` 保护。
   *
   * 新建成功后 `setCurrentPatientId(丙)` 已生效，但表单还是甲的内容；随后
   * `reloadMyPatients` + `refreshCurrentRole` + `load` 在弱网下要 1~15 秒。
   * 这期间点保存 → 写出「丙的 id + 甲的姓名生日」，绕过乐观锁。
   *
   * 判别力：去掉 `onCreatePatient` 里的 `beginReloading()` → 本用例红。
   */
  it('新建病人后的列表刷新在途时点保存：必须拒绝，不能把甲的姓名写进丙的档案', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲', birthday: '1960-01-01', wheelchairWeight: 13.4 }),
    })
    await flushPromises()

    // 让 createPatient 立即成功，但之后的 reloadMyPatients 挂住
    vi.mocked(createPatient).mockResolvedValue({
      ok: true,
      data: { patient: { id: 'patient-c', name: '丙' } },
    } as never)
    let releaseList!: () => void
    vi.mocked(listMyPatients).mockReturnValue(
      new Promise((resolve) => {
        releaseList = () => resolve([] as never)
      }) as never,
    )

    const vm = w.vm as unknown as {
      openNewPatient: () => void
      onCreatePatient: () => Promise<void>
      newPatientForm: { name: string; wheelchairWeight: string; rinseBackVolume: string }
    }
    vm.openNewPatient()
    await w.vm.$nextTick()
    vm.newPatientForm.name = '丙'
    vm.newPatientForm.wheelchairWeight = '12'
    vm.newPatientForm.rinseBackVolume = '300'
    void vm.onCreatePatient()
    await flushPromises()

    // 此刻：pid 已是丙，列表刷新在途，表单还是甲的
    expect(currentPatientIdRef.value).toBe('patient-c')
    expect(fieldInput(w, '姓名').element.value).toBe('甲')

    mocks.showToast.mockClear()
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再保存')
    expect(repository.savePatient).not.toHaveBeenCalled()

    releaseList()
    await flushPromises()
  })

  /**
   * 漏洞 C（第五轮测试评审坐实的新死锁）：`refreshCurrentRole()` 抛错后
   * `switchPatient` 的 `finally` 是**唯一**出口。漏了释放 → `reloading` 永久 > 0 →
   * 用户再也切不了病人（只能杀进程）。这是本次改动**引入**的新失败模式。
   *
   * 另外：`refreshCurrentRole` 抛错原来会**直接抛给模板 `@click`** ——
   * Vue 里就是一条未捕获错误，用户看不到任何提示、页面还停在半切换状态。
   * 现在由 `switchPatient` 自己兜住：病人照常切过去（id 已经改了，不回滚），
   * 提示「权限刷新失败」，并按「权限未知」保守处理（不可编辑比误以为能编辑安全）。
   *
   * 判别力：去掉 `switchPatient` 的 `finally { release() }` → 本用例红。
   */
  it('角色刷新抛错：不抛给模板、reloading 复位、用户还能再切病人（不能永久卡死）', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    const vm = w.vm as unknown as { switchPatient: (id: string) => Promise<void> }
    // 第一次切换：角色刷新抛错。不能把异常抛出去（否则模板 @click 里是未捕获错误）
    mocks.refreshCurrentRole.mockRejectedValueOnce(new Error('network down'))
    mocks.showToast.mockClear()
    await expect(vm.switchPatient('patient-b')).resolves.toBeUndefined()
    await flushPromises()
    expect(mocks.showToast).toHaveBeenCalledWith('已切换病人，但权限刷新失败，部分操作可能暂时不可用')

    const setupState = (w.vm as unknown as { $: { setupState: Record<string, unknown> } }).$.setupState
    expect(setupState.reloading, 'reloading 卡在 true → 切病人永久被挡').toBe(false)

    // 第二次切换必须能成功（不被「正在加载病人档案」挡住）
    mocks.showToast.mockClear()
    mocks.refreshCurrentRole.mockResolvedValue(undefined)
    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      makePatient({ id, name: id === 'patient-b' ? '乙' : '甲' }),
    )
    await vm.switchPatient('patient-b')
    await flushPromises()
    expect(mocks.showToast).not.toHaveBeenCalledWith('正在加载病人档案，请稍候再切换')
  })

  /**
   * 首屏骨架（第五轮测试评审 M59）：全仓 `.van-skeleton` 断言原来只有 3 处、
   * 全是 `toBe(false)`，**没有一条正向断言「首屏加载时骨架存在」**。
   * 把 `const loading = ref(true)` 改成 `ref(false)` 后 96 条全绿 —— 首屏会直接
   * 渲染空表单（姓名空白、轮椅 0），用户以为数据丢了。
   *
   * 判别力：`loading = ref(false)` → 本用例红。
   */
  it('首屏加载期间必须显示骨架屏（不能直接渲染空表单）', async () => {
    // ⚠️ 不能走 `mountSettings`：它内部 `await flushPromises()` 会让首屏请求完成，
    // 挂载返回时 loading 已经是 false，测不到骨架。这里手动挂载并让 getPatient 一直挂着。
    stubSettingsData({ patient: makePatient({ id: 'patient-default' }) })
    let releasePatient!: () => void
    vi.mocked(repository.getPatient).mockReturnValue(
      new Promise((resolve) => {
        releasePatient = () => resolve(makePatient({ id: 'patient-default' }) as never)
      }) as never,
    )
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: defineComponent({ render: () => h('div') }) },
        { path: '/login', component: defineComponent({ render: () => h('div') }) },
        { path: '/members', component: defineComponent({ render: () => h('div') }) },
      ],
    })
    await router.push('/')
    await router.isReady()
    const w = mount(SettingsView, {
      global: { plugins: [Vant, router], stubs: { teleport: true } },
    })
    await flushPromises()

    // 首屏请求还没回来：必须是骨架
    expect(w.find('.van-skeleton').exists(), '首屏没有骨架 → 用户看到空表单以为数据丢了').toBe(true)
    expect(w.find('.load-error').exists()).toBe(false)

    releasePatient()
    await flushPromises()
    expect(w.find('.van-skeleton').exists()).toBe(false)
  })

  /**
   * 版本号回写（第五轮测试评审 M17 / M33 / M22 三条变异均全绿）：
   *
   * 保存成功后必须把新版本号写回 `knownPatientUpdatedAtIso`，否则**下一次防抖保存
   * 拿旧版本去比 → 自己跟自己冲突**（AGENTS.md 明确点过的坑）。
   * 现有唯一断版本号入参的两处只断「IRS」与「null」，**没有一条断言「第二次保存
   * 要带第一次返回的新版本号」** —— 删掉 `knownPatientUpdatedAtIso = iso` 也全绿。
   *
   * 判别力：`knownPatientUpdatedAtIso = iso` → `= null`，或 `if (iso)` → `if (false)` → 本用例红。
   */
  it('保存成功后回写新版本号：第二次保存要带第一次返回的版本（否则自己跟自己冲突）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '张三' }) })
    const firstIso = '2026-01-01T00:00:00.000001+00:00'
    const secondIso = '2026-01-01T00:00:00.000002+00:00'
    vi.mocked(repository.savePatient)
      .mockResolvedValueOnce(firstIso as never)
      .mockResolvedValueOnce(secondIso as never)

    await fieldInput(w, '姓名').setValue('张三丰')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(repository.savePatient).toHaveBeenCalledTimes(1)
    // 第一次：初始档案没有 updatedAtIso → 传 null
    expect(vi.mocked(repository.savePatient).mock.calls[0][1]).toBeNull()

    // 第二次保存：必须带第一次返回的新版本号（不是 null、也不是旧值）
    await fieldInput(w, '姓名').setValue('张三丰2')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(repository.savePatient).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(repository.savePatient).mock.calls[1][1],
      '第二次保存没带新版本号 → 会自己跟自己冲突',
    ).toBe(firstIso)
  })

  /**
   * `formSnapshot` 回写（第五轮测试评审 M16 全绿）：
   *
   * 保存成功后必须更新「干净快照」，否则下一次 `load()` 会认为「用户改过表单」
   * 而不回填 → 页面停在旧数据，且下次保存重复写一条变更记录。
   *
   * 判别力：删掉 `formSnapshot = snapshotForm()` → 本用例红。
   */
  it('保存成功后更新表单快照：之后的 load 必须能正常回填（不能一直判成「用户改过」）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '张三' }) })
    vi.mocked(repository.savePatient).mockResolvedValueOnce('2026-01-01T00:00:00.000001+00:00' as never)

    await fieldInput(w, '姓名').setValue('张三丰')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 保存后档案在服务端变成了「张三丰」，触发一次普通 load（非 force）
    vi.mocked(repository.getPatient).mockResolvedValue(
      makePatient({ id: 'patient-default', name: '张三丰', updatedAtIso: '2026-01-01T00:00:00.000001+00:00' }),
    )
    const vm = w.vm as unknown as { load: (force?: boolean) => Promise<void> }
    await vm.load()
    await flushPromises()

    // 表单没被用户改过（刚保存完，快照应该已同步）→ 必须回填
    expect(fieldInput(w, '姓名').element.value).toBe('张三丰')
  })

  /**
   * 严重-4（第四轮独立评审）：冲突对话框里的「覆盖保存」不复核 pid。
   *
   * 触发路径（触发成本极低）：
   * ① 甲改轮椅重量 → 保存 → 冲突 → 弹「病人档案已被其他人修改」（用户正在读）
   * ② 这期间点乙那一行切过去 —— 此时没有保存/加载在途，守卫放行，切换正常完成
   * ③ 回来点「覆盖保存」→ 原来会拿 `currentPatientId.value`（= 乙）做无条件整行 upsert：
   *    甲刚改的重量静默丢失，**乙的档案被平白覆盖一次**，而用户以为在覆盖甲的
   *
   * 修法：`resolvePatientConflict(conflictPatientId)` 在两个分支（重新加载 / 覆盖保存）
   * 都复核 pid；`savePatient` 再加 `expectPatientId` 兜一层。
   *
   * 判别力：去掉 `resolvePatientConflict` 里的 pid 复核 → 本用例红。
   */
  it('冲突对话框停留期间切了病人：覆盖保存必须放弃，不能把甲的表单写进乙', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲', birthday: '1960-01-01', wheelchairWeight: 13.4 }),
    })
    await flushPromises()

    // 第一次保存：冲突（乐观锁）
    const { ConflictError } = await import('../../src/lib/errors')
    vi.mocked(repository.savePatient).mockRejectedValueOnce(new ConflictError('conflict'))

    // 对话框挂住：模拟用户正在读弹窗
    let releaseDialog!: () => void
    let rejectDialog!: (e: unknown) => void
    mocks.showConfirmDialog.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          releaseDialog = resolve
          rejectDialog = reject
        }),
    )

    await fieldInput(w, '轮椅及衣物重量').setValue('25')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    const callsAfterConflict = vi.mocked(repository.savePatient).mock.calls.length

    // ② 对话框还开着，用户切到乙（此时无保存/加载在途 → 守卫放行）
    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      makePatient({ id, name: id === 'patient-b' ? '乙' : '甲', birthday: '1970-02-02', wheelchairWeight: 20 }),
    )
    const vm = w.vm as unknown as { switchPatient: (id: string) => Promise<void> }
    await vm.switchPatient('patient-b')
    await flushPromises()
    expect(currentPatientIdRef.value).toBe('patient-b')
    expect(fieldInput(w, '姓名').element.value).toBe('乙')

    // ③ 用户点「覆盖保存」（reject = cancel 按钮）
    mocks.showToast.mockClear()
    rejectDialog(new Error('cancel'))
    await flushPromises()

    // 必须放弃重试，而不是对乙做一次无条件 upsert
    expect(
      vi.mocked(repository.savePatient).mock.calls.length,
      '覆盖保存写进了乙的档案（甲的修改本应放弃）',
    ).toBe(callsAfterConflict)
    expect(mocks.showToast).toHaveBeenCalledWith('你已切换到其他病人，这次修改已放弃')
    void releaseDialog
  })

  /**
   * 中级-1（第四轮独立评审）：干体重重载不该锁 UI。
   *
   * `saveDw` / `removeDw` 内部都 `await load()`，若 `load()` 持有的标记参与 UI 灰化，
   * 那么**每次正常存一条干体重**都会让整块病人列表变灰、点不动、保存被拒，
   * 最长 46 秒（`resilientFetch` 3×15s + 退避）且**没有任何加载指示** —— 用户以为 App 卡死。
   *
   * 修法：UI 灰化只看 `switchingPatient`；`reloading` 只给「拒绝保存/切换」的守卫用。
   *
   * 判别力：模板灰化条件换回 `reloading` → 本用例红。
   */
  it('干体重重载在途时病人列表不能变灰（正常操作不该冻结 UI）', async () => {
    isLoggedInRef.value = true
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-default', name: '甲' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-default', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })],
    })
    await flushPromises()

    // 让 saveDw 之后的 load 挂住
    let releaseLoad!: () => void
    vi.mocked(repository.getPatient).mockReturnValue(
      new Promise((resolve) => {
        releaseLoad = () => resolve(makePatient({ id: 'patient-default', name: '甲' }) as never)
      }) as never,
    )
    const vm = w.vm as unknown as { removeDw: (id: string) => Promise<void> }
    void vm.removeDw('dw-1')
    await flushPromises()

    // 干体重重载在途：病人行不能变灰
    const rows = w.findAll('.row').filter((r) => r.text().includes('甲'))
    expect(rows.length, '没找到病人行，选择器需更新').toBeGreaterThan(0)
    const rowStyle = rows[0].attributes('style') ?? ''
    expect(rowStyle, '干体重重载把病人列表灰化了 → 正常操作冻结 UI').not.toContain('opacity: 0.5')

    releaseLoad()
    await flushPromises()
  })

  /**
   * 中级-5（第四轮独立评审）：`onMigrate` 的 in-flight 持有权零覆盖。
   *
   * 代码已经对了（`beginReloading()` 包住刷新段），但**没有任何用例** ——
   * 下次重构删掉它不会有任何提示，而它守的正是病人身份级污染。
   * 结构照 `新建病人后的列表刷新在途时点保存` 写。
   *
   * 判别力：`onMigrate` 的 `beginReloading()` → `() => {}` → 本用例红。
   */
  it('迁移后的列表刷新在途时点保存：必须拒绝，不能把甲的表单写进新病人', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    mocks.migrateLocalToCloud.mockResolvedValue({
      ok: true,
      message: '已迁移 2 条透析记录到云端',
      patientId: 'patient-c',
    } as never)
    // ⚠️ 窗口在 `setCurrentPatientId(newId)` **之后**（`reloadMyPatients` 之前还没有新 id），
    // 所以要让 `refreshCurrentRole` 挂住，不是 `reloadMyPatients`。
    let releaseRole!: () => void
    mocks.refreshCurrentRole.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRole = resolve
        }),
    )

    const vm = w.vm as unknown as { onMigrate: () => Promise<void> }
    void vm.onMigrate()
    // onMigrate 先弹二次确认（不可逆操作），默认 mock 已 resolve
    await flushPromises()
    await flushPromises()

    // 迁移已成功：pid 已换成新病人，但表单还是甲的
    expect(currentPatientIdRef.value).toBe('patient-c')
    expect(fieldInput(w, '姓名').element.value).toBe('甲')

    mocks.showToast.mockClear()
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再保存')
    expect(repository.savePatient).not.toHaveBeenCalled()

    releaseRole()
    await flushPromises()
  })

  /**
   * 中级-2（第四轮独立评审）：`openChangeLog` 跨病人串显变更记录。
   *
   * 点「变更历史」（甲的）→ 弱网请求在途 → 切到乙 → 请求返回 →
   * 弹窗里显示的是**甲的体重变更历史**，用户会据此判断「乙的轮椅重量被改过」。
   * 与 `load()` 的 pid 复查是同一模式，原来没有复查、也没有用例。
   *
   * 判别力：去掉 `openChangeLog` 里的 `if (currentPatientId.value !== pid) return` → 本用例红。
   */
  it('变更历史请求在途时切了病人：甲的记录不能显示在乙的页面上', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲' }),
      changeLogs: [makeChangeLog({ patientId: 'patient-a', oldValue: 13.4, newValue: 13.5 })],
    })
    await flushPromises()

    // 让甲的变更记录请求挂住
    let releaseLogs!: () => void
    vi.mocked(repository.listPatientChangeLogs).mockReturnValue(
      new Promise((resolve) => {
        releaseLogs = () =>
          resolve([makeChangeLog({ patientId: 'patient-a', oldValue: 13.4, newValue: 13.5 })] as never)
      }) as never,
    )
    const vm = w.vm as unknown as {
      openChangeLog: () => Promise<void>
      switchPatient: (id: string) => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    void vm.openChangeLog()
    await flushPromises()

    // 请求在途时切到乙
    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      makePatient({ id, name: id === 'patient-b' ? '乙' : '甲' }),
    )
    await vm.switchPatient('patient-b')
    await flushPromises()

    // 放行甲的记录
    releaseLogs()
    await flushPromises()

    // 当前是乙：甲的变更记录不能被写进页面状态
    const logs = vm.$.setupState.changeLogs as Array<{ patientId: string }>
    expect(
      logs.some((l) => l.patientId === 'patient-a'),
      '甲的变更记录落到了乙的页面',
    ).toBe(false)
  })

  /**
   * 中级-1（第五轮独立评审坐实）：`openChangeLog` 的 `changeLogLoading` 必须**无条件**复位。
   *
   * 原来写的是 `if (currentPatientId.value === pid) changeLogLoading.value = false` ——
   * 于是「请求在途时切了病人」这条路径上 loading **永远停在 true**：弹窗一直转圈、
   * 没有重试、也没有失败提示，用户以为记录读不出来（实测 DOM 里「加载中」常驻、
   * 「暂无变更记录」永不出现）。
   *
   * 判别力：把 finally 改成条件复位 → 本用例红。
   */
  it('变更历史请求在途时切了病人：弹窗不能永久停在「加载中」', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    let releaseLogs!: () => void
    vi.mocked(repository.listPatientChangeLogs).mockReturnValue(
      new Promise((resolve) => {
        releaseLogs = () => resolve([] as never)
      }) as never,
    )
    const vm = w.vm as unknown as {
      openChangeLog: () => Promise<void>
      switchPatient: (id: string) => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    void vm.openChangeLog()
    await flushPromises()

    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      makePatient({ id, name: id === 'patient-b' ? '乙' : '甲' }),
    )
    await vm.switchPatient('patient-b')
    await flushPromises()

    releaseLogs()
    await flushPromises()

    expect(
      vm.$.setupState.changeLogLoading,
      'loading 卡在 true → 弹窗永久转圈，用户以为记录读不出来',
    ).toBe(false)
  })

  /**
   * 中级-2（第五轮独立评审坐实）：`saveDw` 在切换病人途中必须被挡住。
   *
   * 原来它只守 `savingDw`、不守 `reloading`，且自己不持有 reloading。
   * 切换途中点「＋ 新增」→ 填好 → 提交，`patientId` 取的是**已经切换后**的新 pid
   * → 干体重挂到新病人名下，而页面显示的还是旧病人的列表。
   * 干体重直接决定脱水量，写错病人等于改错治疗方案。
   *
   * 判别力：去掉 `saveDw` 的 `if (reloading.value)` 守卫 → 本用例红。
   */
  it('切换病人途中提交干体重：必须挡住（否则干体重挂到新病人名下）', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 })],
    })
    await flushPromises()

    // 让切换病人的 load 挂住
    vi.mocked(repository.getPatient).mockReturnValue(new Promise(() => {}) as never)
    const vm = w.vm as unknown as {
      switchPatient: (id: string) => Promise<void>
      saveDw: () => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    void vm.switchPatient('patient-b')
    await flushPromises()
    expect(currentPatientIdRef.value).toBe('patient-b')

    mocks.showToast.mockClear()
    vi.mocked(repository.saveDryWeight).mockClear()
    ;(vm.$.setupState.dwForm as Record<string, unknown>).value = '61'
    await vm.saveDw()
    await flushPromises()

    expect(
      vi.mocked(repository.saveDryWeight).mock.calls.length,
      '切换途中把干体重存了下去 → 记录挂到新病人名下（页面还显示旧病人的列表）',
    ).toBe(0)
    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再保存')
  })

  /**
   * 中级-2（第五轮独立评审坐实）：`removeDw` 在切换病人途中必须被挡住。
   *
   * 判别力：去掉 `removeDw` 的 `if (reloading.value)` 守卫 → 本用例红。
   */
  it('切换病人途中删除干体重：必须挡住', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 })],
    })
    await flushPromises()

    vi.mocked(repository.getPatient).mockReturnValue(new Promise(() => {}) as never)
    const vm = w.vm as unknown as {
      switchPatient: (id: string) => Promise<void>
      removeDw: (d: unknown) => Promise<void>
    }
    void vm.switchPatient('patient-b')
    await flushPromises()

    mocks.showToast.mockClear()
    vi.mocked(repository.deleteDryWeight).mockClear()
    await vm.removeDw(makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 }))
    await flushPromises()

    expect(
      vi.mocked(repository.deleteDryWeight).mock.calls.length,
      '切换途中把干体重删了 → load() 用的是新 pid，用户以为在删旧病人的',
    ).toBe(0)
  })

  /**
   * 中级-2（第五轮独立评审坐实）：`onImportFile` 必须防连点（整库替换）。
   *
   * 原来连 in-flight 标记都没有：用户连选两次文件 = 两次 `importAll` +
   * 两个并发 `load(true)`。
   *
   * 判别力：去掉 `if (importing.value) return` → 本用例红。
   */
  /**
   * 轻微-1（第八轮测试有效性评审）：`removeDw` 确认框**之后**那道 `reloading` 复查无守护。
   *
   * `removeDw` 有两道 `reloading` 判断：进函数时一道、确认框关闭后再一道。
   * 现有用例只覆盖了第一道（「切换病人途中删除」——进入时就已经在加载）。
   * 第二道守的是另一个窗口：**用户停在「确定删除？」框上的那几秒里切了病人**。
   * 实测：只删第二道 → 122 条全绿。
   *
   * 判别力：删掉确认框之后的 `if (reloading.value)` → 本用例红。
   */
  it('删除确认框开着期间切了病人：点确定必须放弃删除', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 })],
    })
    await flushPromises()

    // 把确认框挂住，模拟「用户正看着确认框」
    let releaseDialog!: () => void
    mocks.showConfirmDialog.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDialog = resolve
        }),
    )

    const vm = w.vm as unknown as {
      removeDw: (d: unknown) => Promise<void>
      switchPatient: (id: string) => Promise<void>
    }
    const removePromise = vm.removeDw(
      makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 }),
    )
    await flushPromises()
    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)

    // 确认框还开着 —— 这期间用户切到了乙（并让乙的加载挂住，使 reloading 为 true）
    vi.mocked(repository.getPatient).mockReturnValue(new Promise(() => {}) as never)
    void vm.switchPatient('patient-b')
    await flushPromises()

    mocks.showToast.mockClear()
    vi.mocked(repository.deleteDryWeight).mockClear()
    releaseDialog() // 用户点了「确定」
    await removePromise
    await flushPromises()

    expect(
      vi.mocked(repository.deleteDryWeight).mock.calls.length,
      '确认框期间已切到乙，点确定却删了 → 删的是甲的干体重，而随后的 load() 用的是乙的 pid',
    ).toBe(0)
  })

  it('导入备份连点：只导入一次（整库替换不能并发）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '甲' }) })
    await flushPromises()

    let releaseImport!: () => void
    vi.mocked(repository.importAll).mockReturnValue(
      new Promise<void>((resolve) => {
        releaseImport = resolve
      }) as never,
    )
    const vm = w.vm as unknown as { onImportFile: (e: Event) => Promise<void> }

    const file = new File(['{"patients":[]}'], 'backup.json', { type: 'application/json' })
    const makeEvent = () =>
      ({
        target: { files: [file], value: 'backup.json' },
      }) as unknown as Event

    void vm.onImportFile(makeEvent())
    await flushPromises()
    void vm.onImportFile(makeEvent()) // 连选第二次
    await flushPromises()

    expect(
      vi.mocked(repository.importAll).mock.calls.length,
      '连点导入了两次 → 两个并发 load(true)，数据可能被清两次',
    ).toBe(1)

    releaseImport()
    await flushPromises()
  })

  /**
   * 轻微-1（第五轮独立评审）：`onMigrate` 的 `else await ensureCloudPatient()` 分支零覆盖。
   *
   * 这是「老版本/异常情况下迁移接口没返回 patientId」的兜底：退回按列表校准。
   * 删掉它（变异 `else void 0`）后 115 条全绿 —— 没有任何用例走进这个分支。
   *
   * 判别力：把 `else await ensureCloudPatient()` 换成 `else void 0` → 本用例红。
   */
  it('迁移接口没返回 patientId 且列表无新增：退回按列表校准（不能什么都不做）', async () => {
    currentPatientIdRef.value = 'patient-default'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    // 迁移前后列表**完全相同**（没有新增病人）
    const sameList = [{ patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' }]
    vi.mocked(listMyPatients).mockResolvedValue(sameList as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '甲' }) })
    await flushPromises()

    // 迁移成功但**没有 patientId**
    mocks.migrateLocalToCloud.mockResolvedValue({
      ok: true,
      message: '已迁移 2 条透析记录到云端',
    } as never)
    mocks.ensureCloudPatient.mockClear()
    const vm = w.vm as unknown as { onMigrate: () => Promise<void> }
    await vm.onMigrate()
    await flushPromises()

    expect(
      mocks.ensureCloudPatient.mock.calls.length,
      '迁移没返回 patientId、列表也没新增时什么都没做 → 当前病人仍是默认 id，后续保存全落空',
    ).toBeGreaterThan(0)
  })

  /**
   * 中级-3（第四轮独立评审）：`removeDw` 没有 in-flight 守卫。
   *
   * 弱网下连点删除 → 两个 `deleteDryWeight` + 两个并发 `load()`：
   * 第二次走 NotFound，两个 load 各持一份 reloading、各自用不同 pid 跑完。
   *
   * ⚠️ 第六轮实测：这条只能杀死「两道守卫同时删」（第一次点击已越过前置守卫并把
   * `savingDw` 置 true，删掉前置后还有后置挡）。三道守卫的独立窗口见下面 D12/D14。
   *
   * 判别力：两道守卫同时删 → 本用例红。
   */
  it('删除干体重连点：只删一次（并发 load 会让切/存行为不可预测）', async () => {
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-default', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })],
    })
    await flushPromises()

    // 确认框立即通过；deleteDryWeight 挂住，制造「在途」
    let releaseDelete!: () => void
    vi.mocked(repository.deleteDryWeight).mockReturnValue(
      new Promise<void>((resolve) => {
        releaseDelete = resolve
      }) as never,
    )
    const dw = makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })
    const vm = w.vm as unknown as { removeDw: (d: unknown) => Promise<void> }

    void vm.removeDw(dw)
    await flushPromises()
    void vm.removeDw(dw) // 连点第二次
    await flushPromises()

    expect(
      vi.mocked(repository.deleteDryWeight).mock.calls.length,
      '连点删除了两次 → 第二次 NotFound + 两个并发 load',
    ).toBe(1)

    releaseDelete()
    await flushPromises()
  })

  /**
   * 中级-1（第八轮测试有效性评审）：`saveDw` 新增的 `release()` **零守护**。
   *
   * 本轮把 `saveDw` 从「只当 `reloading` 的读者」改成「自己持有」（`beginReloading()` +
   * `finally { release() }`），但**没有一条用例断言保存结束后 `reloading` 会归零**。
   * 实测：删掉 `saveDw` 里的 `release()` → 122 条全绿。
   *
   * 后果比「多一个守卫」严重得多：`reloadingCount` 泄漏后 `reloading` 永久为 true，
   * 之后**所有**切病人 / 保存 / 删除 / 导入都被静默挡住，用户点什么都只弹一句
   * 「正在加载病人档案，请稍候再操作」，且**永远不会恢复**（只能杀进程）。
   *
   * 判别力：删掉 `saveDw` 的 `finally` 里的 `release()` → 本用例红。
   */
  it('保存干体重成功后 reloading 必须归零（否则之后所有写操作被永久挡住）', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = false
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 })],
    })
    await flushPromises()

    const vm = w.vm as unknown as {
      saveDw: () => Promise<void>
      switchPatient: (id: string) => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    ;(vm.$.setupState.dwForm as Record<string, unknown>).value = '61'
    await vm.saveDw()
    await flushPromises()

    expect(
      vm.$.setupState.reloading,
      'saveDw 的 release() 没执行 → reloadingCount 泄漏 → reloading 永久为 true，' +
        '之后切病人 / 保存 / 删除 / 导入全部被静默挡住且永不恢复',
    ).toBe(false)

    // 行为级：reloading 若泄漏，切病人会被「正在加载病人档案」挡住
    mocks.showToast.mockClear()
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      makePatient({ id, name: id === 'patient-b' ? '乙' : '甲' }),
    )
    await vm.switchPatient('patient-b')
    await flushPromises()
    expect(
      currentPatientIdRef.value,
      '保存干体重后切不动病人 → reloading 被 saveDw 泄漏了（用户会以为 App 卡死）',
    ).toBe('patient-b')
  })

  /**
   * 中级-2（第五轮独立评审）·导入入口的 `reloading` 守卫。
   *
   * 导入末尾的 `load(true)` 用的是**当时**的 pid。切换病人途中导入 → 整库被替换后
   * 已经切到乙，回填的就是乙的档案（与 `saveDw` / `removeDw` 同一条理由）。
   *
   * 判别力：删掉 `onImportFile` 里的 `if (reloading.value)` 守卫 → 本用例红。
   */
  it('切换病人途中导入备份：必须挡住（否则整库替换后回填错病人）', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    // 让切换病人的 load 挂住
    vi.mocked(repository.getPatient).mockReturnValue(new Promise(() => {}) as never)
    const vm = w.vm as unknown as {
      switchPatient: (id: string) => Promise<void>
      onImportFile: (e: Event) => Promise<void>
    }
    void vm.switchPatient('patient-b')
    await flushPromises()

    mocks.showToast.mockClear()
    vi.mocked(repository.importAll).mockClear()
    // ⚠️ 导入只在单机模式可用（云端模式下会先走「请先退出登录」分支直接 return）——
    // 不把它改回 false，本用例会走那个分支，删掉 reloading 守卫也照样绿（实测假绿）。
    isLoggedInRef.value = false
    const file = new File(['{"patients":[]}'], 'backup.json', { type: 'application/json' })
    await vm.onImportFile({ target: { files: [file], value: 'backup.json' } } as unknown as Event)
    await flushPromises()

    expect(
      vi.mocked(repository.importAll).mock.calls.length,
      '切换途中导入了 → 整库被替换，随后 load(true) 用新 pid 回填错病人的档案',
    ).toBe(0)
    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再操作')
  })

  /**
   * 轻微-1（第六轮独立评审）：`removeDw` 确认框**之后**的 `savingDw` 复查要用例锁定。
   *
   * 窗口：用户停在「确定删除？」框上时，另一个入口（干体重新增弹窗）刚好在存数据。
   * 此时点「确定」必须放弃删除 —— 否则两个干体重写操作并发，随后两个 load() 各用不同
   * pid 跑完，列表与当前病人的对应关系被打乱。
   *
   * 判别力：删掉确认框之后的 `if (savingDw.value) return` → 本用例红。
   */
  it('删除确认框开着期间另一个干体重写操作开始：点确定必须放弃删除', async () => {
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-default', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })],
    })
    await flushPromises()

    // 让确认框挂住，期间把 savingDw 占住（模拟另一个入口正在存干体重）
    let releaseDialog!: () => void
    mocks.showConfirmDialog.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDialog = resolve
        }),
    )
    vi.mocked(repository.deleteDryWeight).mockClear()
    const dw = makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })
    const vm = w.vm as unknown as {
      removeDw: (d: unknown) => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    void vm.removeDw(dw)
    await flushPromises()

    // 确认框开着时，另一个写操作占住 savingDw
    vm.$.setupState.savingDw = true
    releaseDialog()
    await flushPromises()

    expect(
      vi.mocked(repository.deleteDryWeight).mock.calls.length,
      '另一个干体重写操作在途时仍然删了 → 两个并发写 + 两个并发 load',
    ).toBe(0)
  })

  /**
   * D12（第六轮测试评审）：确认框开着时连点，不能弹**两个**确认框。
   *
   * 实测真实缺陷：`savingDw` 原来在对话框**关闭之后**才置 true，所以「用户正在读
   * 『确定删除？』」的那几秒守卫是空的 → 连点两次弹两个框，用户点完第一个确定、
   * 第二个框还挂着。
   *
   * 判别力：把 `deletingDw.value = true` 移到 `showConfirmDialog` 之后 → 本用例红。
   */
  it('删除确认框开着时连点：不能弹出两个确认框', async () => {
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-default', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })],
    })
    await flushPromises()

    // 让确认框一直开着
    mocks.showConfirmDialog.mockImplementation(() => new Promise<void>(() => {}))
    const dw = makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })
    const vm = w.vm as unknown as { removeDw: (d: unknown) => Promise<void> }

    void vm.removeDw(dw)
    await flushPromises()
    void vm.removeDw(dw) // 用户连点
    await flushPromises()

    expect(
      mocks.showConfirmDialog.mock.calls.length,
      '确认框开着时连点弹了多个框 → 用户点完第一个确定，第二个框还挂着',
    ).toBe(1)
  })

  /**
   * D14（第六轮测试评审）：删除失败后 `savingDw` / `deletingDw` 必须复位。
   *
   * 漏了复位 → 之后「新增干体重」永久失效（点了没反应），用户只能杀进程。
   *
   * 判别力：删掉 `removeDw` 的 `finally { deletingDw.value = false }` → 本用例红。
   */
  it('删除干体重失败后守卫必须复位（否则之后新增干体重永久失效）', async () => {
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-default', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })],
    })
    await flushPromises()

    vi.mocked(repository.deleteDryWeight).mockRejectedValueOnce(new Error('offline') as never)
    const dw = makeDryWeight({ id: 'dw-1', patientId: 'patient-default', weight: 60 })
    const vm = w.vm as unknown as {
      removeDw: (d: unknown) => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    await vm.removeDw(dw)
    await flushPromises()

    expect(
      vm.$.setupState.savingDw,
      '删除失败后 savingDw 卡在 true → 之后新增干体重永久失效',
    ).toBe(false)
    expect(vm.$.setupState.deletingDw, '删除失败后 deletingDw 卡在 true').toBe(false)
  })


  /**
   * 严重-4 的另一半（第六轮测试评审 C9）：冲突对话框的「**重新加载**」分支也必须复核 pid。
   *
   * 上面那条只点了「覆盖保存」（走 catch 分支）。「重新加载」（try 分支的 `await load(true)`）
   * 这一支**零覆盖** —— 用户点「重新加载」时若已切到乙，会把乙的档案灌进页面，
   * 用户以为在重新加载甲的冲突。实测：删掉 try 分支的 pid 复核 → 全量 1786 条全绿。
   *
   * 判别力：删掉 `resolvePatientConflict` try 分支的 pid 复核 → 本用例红。
   */
  it('冲突对话框停留期间切了病人：点「重新加载」也必须放弃，不能把乙的档案灌进来', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    const { ConflictError } = await import('../../src/lib/errors')
    vi.mocked(repository.savePatient).mockRejectedValueOnce(new ConflictError('conflict'))

    let releaseDialog!: () => void
    mocks.showConfirmDialog.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDialog = resolve
        }),
    )

    await fieldInput(w, '轮椅及衣物重量').setValue('25')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)

    // 对话框还开着，切到乙
    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      makePatient({ id, name: id === 'patient-b' ? '乙' : '甲' }),
    )
    const vm = w.vm as unknown as { switchPatient: (id: string) => Promise<void> }
    await vm.switchPatient('patient-b')
    await flushPromises()
    expect(currentPatientIdRef.value).toBe('patient-b')

    // 记录切完之后 getPatient 的调用次数
    const callsBeforeReload = vi.mocked(repository.getPatient).mock.calls.length

    // 点「重新加载」（resolve = confirm 按钮）
    mocks.showToast.mockClear()
    releaseDialog()
    await flushPromises()

    // 必须放弃重新加载：不能再多发一次 getPatient
    expect(
      vi.mocked(repository.getPatient).mock.calls.length,
      '对话框期间已切到乙，点「重新加载」却又加载了一次 → 甲的冲突被乙的数据顶掉',
    ).toBe(callsBeforeReload)
    expect(mocks.showToast).toHaveBeenCalledWith('你已切换到其他病人，这次修改已放弃')
  })

  /**
   * 第六轮测试评审 A4d：`load()` **自己**持有的 `reloading` 零覆盖。
   *
   * 这是「加载在途时保存被挡」这条防线的唯一来源。删掉 `load()` 里的
   * `beginReloading()` → 全量 1786 条全绿 —— 因为现有用例覆盖的都是**外层**
   * （`switchPatient` / `savePatient` 自己持有），没有一条断言「`load()` 单独调用期间
   * `reloading` 为 true」。
   *
   * 判别力：把 `load()` 里的 `const release = beginReloading()` 换成 `() => {}` → 本用例红。
   */
  it('load() 在途时必须持有 reloading（否则加载期间的保存会被放行）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '甲' }) })
    await flushPromises()

    let releaseLoad!: () => void
    vi.mocked(repository.getPatient).mockReturnValue(
      new Promise((resolve) => {
        releaseLoad = () => resolve(makePatient({ id: 'patient-default', name: '甲' }) as never)
      }) as never,
    )
    const vm = w.vm as unknown as {
      load: (force?: boolean) => Promise<void>
      savePatient: () => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    void vm.load(true)
    await flushPromises()

    expect(
      vm.$.setupState.reloading,
      'load() 没有持有 reloading → 加载在途时保存会被放行',
    ).toBe(true)

    // 行为级断言：此期间保存必须被拒
    mocks.showToast.mockClear()
    vi.mocked(repository.savePatient).mockClear()
    await vm.savePatient()
    await flushPromises()
    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再保存')
    expect(repository.savePatient).not.toHaveBeenCalled()

    releaseLoad()
    await flushPromises()
    expect(vm.$.setupState.reloading, 'load() 结束后必须释放').toBe(false)
  })

  /**
   * 第六轮测试评审 A5b / A5c：新建 / 迁移成功后 `reloading` 必须归零。
   *
   * 现有用例只测了「刷新在途时点保存被拒」，**没测「刷新结束后守卫已释放」**。
   * `reloadingCount` 泄漏后 `reloading` 永久为 true → 之后**任何**切病人 / 保存都被静默挡住，
   * 用户点保存没反应。这两条路径低频但必然发生。
   *
   * 判别力：删掉 `onCreatePatient` 的 `finally { release() }` → A5b 红；`onMigrate` 同理。
   */
  it('新建病人成功后 reloading 必须归零（否则之后切病人被永久挡住）', async () => {
    currentPatientIdRef.value = 'patient-default'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '甲' }) })
    await flushPromises()

    // ⚠️ 必须构造 `{ ok, data: { patient } }`：`onCreatePatient` 读的是 `res.data?.patient`，
    // 给成 `{ ok, patient }` 会走「创建失败」分支提前 return，`reloading` 永远是 false
    // → 用例恒真（第六轮实测：这种写法下删掉 finally 的 release() 也全绿）。
    vi.mocked(createPatient).mockResolvedValue({
      ok: true,
      data: { patient: makePatient({ id: 'patient-new', name: '丙' }) },
    } as never)
    const vm = w.vm as unknown as {
      onCreatePatient: () => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    // 姓名必填，否则也提前 return
    ;(vm.$.setupState.newPatientForm as Record<string, unknown>).name = '丙'
    await vm.onCreatePatient()
    await flushPromises()

    expect(
      vm.$.setupState.reloading,
      '新建后 reloading 卡在 true → 之后切病人/保存全被挡住',
    ).toBe(false)
  })

  it('迁移成功后 reloading 必须归零（否则之后切病人被永久挡住）', async () => {
    currentPatientIdRef.value = 'patient-default'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default', name: '甲' }) })
    await flushPromises()

    mocks.migrateLocalToCloud.mockResolvedValue({
      ok: true,
      message: '已迁移 2 条透析记录到云端',
      patientId: 'patient-c',
    } as never)
    const vm = w.vm as unknown as {
      onMigrate: () => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    await vm.onMigrate()
    await flushPromises()

    expect(
      vm.$.setupState.reloading,
      '迁移后 reloading 卡在 true → 之后切病人/保存全被挡住',
    ).toBe(false)
  })

  /**
   * 第六轮测试评审 B7a / B7b：`switchingPatient` 的置位 / 复位零覆盖。
   *
   * 上面那条「干体重重载不能变灰」只断言 `reloading` **不该**灰化，它**不关心
   * `switchingPatient` 到底有没有被置位**。删掉置位 → 切换期间列表不变灰，
   * 用户以为没点上继续连点；删掉复位 → 列表永久变灰、再也点不动。
   *
   * 判别力：删掉 `switchingPatient.value = true` → 本用例红；删掉 `= false` 同理。
   */
  /**
   * 轻微-5（第八轮测试有效性评审）：模板是否**真的**据 `switchingPatient` 置灰，零覆盖。
   *
   * 现有用例只断言了 `setupState.switchingPatient` 这个 ref 的置位 / 复位，
   * 没有断言模板把它用上了。实测：把「＋ 新增」按钮的
   * `:disabled="!canEditConfig || switchingPatient"` 改回 `:disabled="!canEditConfig"`，
   * 或者把删除图标的颜色写死成红 —— 123 条全绿。
   *
   * 判别力：删掉模板里的 `|| switchingPatient` → 本用例红。
   */
  it('切换病人途中「＋ 新增」必须置灰（否则点了会把干体重挂到新病人名下）', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 })],
    })
    await flushPromises()

    const addBtn = (): HTMLButtonElement | undefined =>
      [...w.findAll('button')]
        .find((b) => b.text().includes('新增'))
        ?.element as HTMLButtonElement | undefined

    expect(addBtn()?.disabled, '静止时「＋ 新增」不该置灰').toBe(false)

    // 让切换病人的 load 挂住 → switchingPatient 为 true
    vi.mocked(repository.getPatient).mockReturnValue(new Promise(() => {}) as never)
    const vm = w.vm as unknown as { switchPatient: (id: string) => Promise<void> }
    void vm.switchPatient('patient-b')
    await flushPromises()

    expect(
      addBtn()?.disabled,
      '切换病人途中「＋ 新增」没有置灰 → 用户能点开并提交，干体重会挂到新病人名下',
    ).toBe(true)
  })

  /**
   * 轻微-3（第八轮测试有效性评审）：`openDw` 的 `reloading` 守卫零覆盖。
   *
   * 判别力：删掉 `openDw` 里的 `if (reloading.value)` → 本用例红。
   */
  it('切换病人途中点「＋ 新增」干体重：必须挡住并提示', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({
      patient: makePatient({ id: 'patient-a', name: '甲' }),
      dryWeights: [makeDryWeight({ id: 'dw-a', patientId: 'patient-a', weight: 60 })],
    })
    await flushPromises()

    vi.mocked(repository.getPatient).mockReturnValue(new Promise(() => {}) as never)
    const vm = w.vm as unknown as {
      switchPatient: (id: string) => Promise<void>
      openDw: () => void
      $: { setupState: Record<string, unknown> }
    }
    void vm.switchPatient('patient-b')
    await flushPromises()

    mocks.showToast.mockClear()
    vm.openDw()
    await flushPromises()

    expect(
      vm.$.setupState.showDwForm,
      '切换途中弹出了干体重表单 → 用户填完提交就挂到新病人名下',
    ).toBe(false)
    expect(mocks.showToast).toHaveBeenCalledWith('正在加载病人档案，请稍候再操作')
  })

  /**
   * 轻微-4（第八轮测试有效性评审）：`openChangeLog` 里两处
   * `showChangeLog.value = false`（切走时关弹窗）零覆盖。
   *
   * 注释写得很清楚「只 return 的话，弹窗还开着、里面是甲的记录」，
   * 但现有两条用例只断言了 `changeLogs` 不含甲（数据半边），没断言弹窗被关掉。
   *
   * 判别力：删掉成功分支的 `showChangeLog.value = false` → 本用例红。
   */
  it('变更历史返回时已切走：弹窗必须关掉（否则里面还是甲的数据）', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    let releaseLogs!: (v: unknown[]) => void
    vi.mocked(repository.listPatientChangeLogs).mockReturnValue(
      new Promise((resolve) => {
        releaseLogs = resolve as never
      }) as never,
    )
    const vm = w.vm as unknown as {
      openChangeLog: () => Promise<void>
      switchPatient: (id: string) => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    const p = vm.openChangeLog()
    await flushPromises()
    expect(vm.$.setupState.showChangeLog).toBe(true)

    vi.mocked(repository.getPatient).mockImplementation(async (id: string) =>
      makePatient({ id, name: id === 'patient-b' ? '乙' : '甲' }),
    )
    await vm.switchPatient('patient-b')
    await flushPromises()

    releaseLogs([makeChangeLog({ id: 'cl-a', patientId: 'patient-a' })])
    await p
    await flushPromises()

    expect(
      vm.$.setupState.showChangeLog,
      '已切到乙，甲的变更历史弹窗却还开着 → 用户会以为那是乙的记录',
    ).toBe(false)
  })

  it('切换病人期间 switchingPatient 置位、结束后复位（列表该灰时灰、该亮时亮）', async () => {
    currentPatientIdRef.value = 'patient-a'
    mocks.setCurrentPatientId.mockImplementation((id: string) => {
      currentPatientIdRef.value = id
    })
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    let releaseRole!: () => void
    mocks.refreshCurrentRole.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRole = resolve
        }),
    )
    const vm = w.vm as unknown as {
      switchPatient: (id: string) => Promise<void>
      $: { setupState: Record<string, unknown> }
    }
    void vm.switchPatient('patient-b')
    await flushPromises()

    expect(
      vm.$.setupState.switchingPatient,
      '切换在途时列表没变灰 → 用户以为没点上，继续连点',
    ).toBe(true)

    releaseRole()
    await flushPromises()

    expect(
      vm.$.setupState.switchingPatient,
      '切换结束后列表一直是灰的 → 再也点不动',
    ).toBe(false)
  })

  /**
   * 第六轮测试评审 F19：「保存在途时点**自己那一行**」的文案误导。
   *
   * 同 id 早退（`if (id === currentPatientId.value) return`）必须在守卫**之前**。
   * 变异后（挪回守卫之后），用户保存在途时误触自己那一行会弹出
   * 「正在保存档案，请稍候再切换病人」—— 用户根本没想切换。
   *
   * 判别力：把同 id 早退挪到 `savingPatient` 守卫之后 → 本用例红。
   */
  it('保存在途时点自己那一行：不该提示「正在保存档案」（用户没想切换）', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', name: '甲' }) })
    await flushPromises()

    // 让保存在途
    vi.mocked(repository.savePatient).mockReturnValue(new Promise(() => {}) as never)
    const vm = w.vm as unknown as {
      savePatient: () => Promise<void>
      switchPatient: (id: string) => Promise<void>
    }
    void vm.savePatient()
    await flushPromises()

    mocks.showToast.mockClear()
    await vm.switchPatient('patient-a') // 点自己那一行
    await flushPromises()

    expect(
      mocks.showToast.mock.calls.map((c) => String(c[0])).includes('正在保存档案，请稍候再切换病人'),
      '点的是当前病人那一行（不是切换），却提示「正在保存档案，请稍候再切换病人」→ 文案误导',
    ).toBe(false)
    expect(mocks.setCurrentPatientId).not.toHaveBeenCalled()
  })

  /**
   * 严重-1（第三轮独立评审）：保存在途时点**真实的病人行**切病人，
   * 甲的档案值会被回写进页面状态，再点保存 / 覆盖保存就把甲的姓名生日写进乙的服务器档案。
   *
   * 上面那条 S-1 用例直接改 `currentPatientIdRef`，**绕过了 `switchPatient`**，
   * 所以只覆盖「日志归属」，覆盖不到「档案被污染」这个入口。
   *
   * 这条用例点真实的行，断言：
   * ① 保存在途时点另一行 → 被挡住并说明原因，当前病人不变；
   * ② 保存返回后仍是甲，唯一一次 savePatient 是甲的 id + 甲的姓名（不会串成乙的 id）。
   *
   * 判别力：把 `switchPatient` 里的 `savingPatient` 守卫去掉 → 本用例红。
   */
  it('保存在途时点另一个病人行：必须挡住切换，不能让甲的档案值配乙的 id 保存', async () => {
    currentPatientIdRef.value = 'patient-a'
    isLoggedInRef.value = true // 病人列表只在登录态加载
    vi.mocked(listMyPatients).mockResolvedValue([
      { patient: makePatient({ id: 'patient-a', name: '甲' }), role: 'owner' },
      { patient: makePatient({ id: 'patient-b', name: '乙' }), role: 'owner' },
    ] as never)
    const w = await mountSettings({ patient: makePatient({ id: 'patient-a', wheelchairWeight: 13.4, name: '甲' }) })
    await flushPromises()

    // 让 savePatient 挂住（弱网下的秒级等待）
    let releaseSave!: () => void
    vi.mocked(repository.savePatient).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve('2026-01-01T00:00:00.000000+00:00')
        }),
    )

    await fieldInput(w, '轮椅及衣物重量').setValue('13.5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    // 保存还在途中 → 点「乙」那一行（真实的行点击，不是改 ref）
    mocks.showToast.mockClear()
    const rowB = w.findAll('.row').find((r) => r.text().includes('乙'))
    expect(rowB, '找不到乙那一行').toBeTruthy()
    await rowB!.trigger('click')
    await flushPromises()

    // ① 被挡住：仍停在甲，并明确告诉用户为什么
    expect(currentPatientIdRef.value).toBe('patient-a')
    expect(mocks.showToast).toHaveBeenCalledWith('正在保存档案，请稍候再切换病人')

    // ② 放行保存后仍是甲；唯一一次 savePatient 是甲的 id + 甲的姓名（没有串成乙的 id）
    releaseSave()
    await flushPromises()
    expect(currentPatientIdRef.value).toBe('patient-a')
    const saveCalls = vi.mocked(repository.savePatient).mock.calls
    expect(saveCalls.length).toBe(1)
    expect(saveCalls[0][0]).toMatchObject({ id: 'patient-a', name: '甲', wheelchairWeight: 13.5 })
  })

  /**
   * 第十二轮（用户反馈）：卡片顺序按「高频在前、低频在后」排列 ——
   * 数据管理（导出/导入/迁移，低频）要在我的病人（切换病人，高频）之后，
   * 账号（改姓名/退出登录）保持在最后。
   *
   * 为什么钉住：模板里 5 张卡片是硬编码顺序，没有数组驱动，
   * 任何人「顺手」加一张卡片都可能把顺序弄乱，而这种回归不会报错、只会让用户多点两次。
   */
  it('设置页卡片顺序：病人档案 → 干体重历史 → 我的病人 → 数据管理 → 账号', async () => {
    // 「我的病人」「账号」都带 v-if="isLoggedIn"，不登录根本不渲染
    isLoggedInRef.value = true
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    const titles = w
      .findAll('.card')
      .map((c) => {
        const t = c.find('.card-title')
        return t.exists() ? t.text().trim() : ''
      })
      .filter((t) => t !== '')

    expect(titles).toEqual([
      '病人档案',
      '干体重历史',
      '我的病人',
      '数据管理',
      '账号',
    ])

    // 单独钉住用户明确要求的这两条（前面 toEqual 已覆盖，这里是可读的意图声明）
    expect(titles.indexOf('我的病人')).toBeLessThan(titles.indexOf('数据管理'))
    expect(titles[titles.length - 1]).toBe('账号')
  })
})
