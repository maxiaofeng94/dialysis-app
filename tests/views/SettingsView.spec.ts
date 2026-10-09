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
import { makePatient, makeDryWeight } from '../helpers/factories'

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
    expect(fieldInput(w, '轮椅重量').element.value).toBe('20')
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
    expect(fieldInput(w, '轮椅重量').element.value).toBe('')
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
    await fieldInput(w, '轮椅重量').setValue('22.5')

    // 新增干体重会走 load()，此时表单已被用户改过 → 不能回填
    await buttonByText(cardByTitle(w, '干体重历史'), '新增').trigger('click')
    await flushPromises()
    const popup = popupByText(w, '新增干体重')
    await fieldInput(popup, '干体重').setValue('58')
    await buttonByText(popup, '保存').trigger('click')
    await flushPromises()

    expect(repository.listDryWeights).toHaveBeenCalledTimes(2) // load 确实跑过
    expect(fieldInput(w, '姓名').element.value).toBe('张三丰')
    expect(fieldInput(w, '轮椅重量').element.value).toBe('22.5')
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
    await fieldInput(w, '轮椅重量').setValue('22.5')
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
    expect(mocks.showToast).toHaveBeenCalledWith('已保存')
  })

  it('保存：姓名为空落成「未命名」，轮椅缺失落成 0、回水缺失落成 300', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await fieldInput(w, '姓名').setValue('   ')
    await fieldInput(w, '轮椅重量').setValue('')
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

    await fieldInput(w, '轮椅重量').setValue('abc')
    await fieldInput(w, '回水量').setValue('一百')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    const saved = vi.mocked(repository.savePatient).mock.calls[0][0]
    expect(saved.wheelchairWeight).toBe(0)
    expect(saved.rinseBackVolume).toBe(300)
  })

  it('轮椅重量为负数 → 拦截并提示，不写库（回归：曾经 -5 会原样入库，首页「实际体重」跟着偏大）', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await fieldInput(w, '轮椅重量').setValue('-5')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()

    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(toastText()).toContain('轮椅重量应在 0~100 之间')
  })

  it('回水量 / 轮椅重量超出上限也被拦下，不写库', async () => {
    const w = await mountSettings({ patient: makePatient({ id: 'patient-default' }) })

    await fieldInput(w, '回水量').setValue('99999')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(toastText()).toContain('回水量应在 0~2000 之间')

    await fieldInput(w, '回水量').setValue('300')
    await fieldInput(w, '轮椅重量').setValue('150')
    await buttonByText(w, '保存档案').trigger('click')
    await flushPromises()
    expect(repository.savePatient).not.toHaveBeenCalled()
    expect(toastText()).toContain('轮椅重量应在 0~100 之间')
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

    await fieldInput(w, '轮椅重量').setValue('99')
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
