/**
 * MembersView（成员管理页）组件测试
 *
 * 覆盖：成员列表渲染（角色中文、姓名/手机号兜底）、owner 与其他成员的操作入口差异、
 * 非 owner（家属/护工、医生…）时入口按角色收口、邀请成员（手机号校验 / 角色选择 / 失败处理 /
 * 取消清空 / 防连点）、修改角色、移除成员、被踢下线时的提示与跳转。
 *
 * 说明：该页是云端专属功能，所有云端调用都在 lib/cloudAdmin 里，本文件整体 mock 掉；
 * Vant 的 popup / action-sheet 默认 teleport 到 body，用 `stubs: { teleport: true }` 渲染回组件树内。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import MembersView from '../../src/views/MembersView.vue'
import type { MemberInfo } from '../../src/lib/cloudAdmin'
import { listMembers, inviteMember, setMemberRole, removeMember } from '../../src/lib/cloudAdmin'
import { cacheVersion } from '../../src/lib/cloudCache'
import * as patientModule from '../../src/stores/patient'
import * as authModule from '../../src/stores/auth'

const mocks = vi.hoisted(() => ({
  currentPatientId: { value: 'patient-default' },
  showToast: vi.fn(),
  showConfirmDialog: vi.fn(async () => undefined),
  refreshCurrentRole: vi.fn(async () => undefined),
}))

vi.mock('../../src/lib/cloudAdmin', () => ({
  listMembers: vi.fn(),
  inviteMember: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
}))

vi.mock('../../src/stores/patient', async () => {
  const { ref } = await import('vue')
  const currentRole = ref<string | null>('owner')
  return {
    currentPatientId: mocks.currentPatientId,
    currentRole,
    refreshCurrentRole: mocks.refreshCurrentRole,
    __currentRole: currentRole,
  }
})

vi.mock('../../src/stores/auth', async () => {
  const { ref } = await import('vue')
  const isLoggedIn = ref(true)
  return { useAuth: () => ({ isLoggedIn }), __isLoggedIn: isLoggedIn }
})

vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showToast: mocks.showToast, showConfirmDialog: mocks.showConfirmDialog }
})

/** 当前账号对当前病人的角色（'owner' / 'caregiver' / 'doctor' / 'viewer' / null=未知） */
const currentRoleRef = (patientModule as unknown as { __currentRole: { value: string | null } }).__currentRole
/** 登录态（M6：由 true 变 false = 被踢下线/令牌失效） */
const isLoggedInRef = (authModule as unknown as { __isLoggedIn: { value: boolean } }).__isLoggedIn

const owner: MemberInfo = { userId: 'u1', name: '张三', phone: '13800000000', role: 'owner' }
const caregiver: MemberInfo = { userId: 'u2', name: '李四', phone: '13900000000', role: 'caregiver' }
const viewer: MemberInfo = { userId: 'u3', name: null, phone: null, role: 'viewer' }

let wrapper: VueWrapper | null = null
let router: Router

async function mountMembers(members: MemberInfo[] = [owner, caregiver, viewer]): Promise<VueWrapper> {
  vi.mocked(listMembers).mockResolvedValue(members)
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: defineComponent({ render: () => h('div') }) },
      { path: '/login', component: defineComponent({ render: () => h('div') }) },
      { path: '/members', component: MembersView },
    ],
  })
  await router.push('/members')
  await router.isReady()
  wrapper = mount(MembersView, {
    global: { plugins: [Vant, router], stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

function buttonByText(scope: VueWrapper | DOMWrapper<Node>, text: string): DOMWrapper<HTMLButtonElement> {
  const btn = scope.findAll('button').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`未找到文案包含「${text}」的按钮`)
  return btn as DOMWrapper<HTMLButtonElement>
}

/** 是否存在某个按钮（用于断言「入口被隐藏」） */
function hasButton(scope: VueWrapper | DOMWrapper<Node>, text: string): boolean {
  return scope.findAll('button').some((b) => b.text().includes(text))
}

/** 成员行：只有记录行带 border-top 内联样式 */
function rowByName(w: VueWrapper, name: string): DOMWrapper<Node> {
  const row = w
    .findAll('div')
    .filter((d) => (d.attributes('style') ?? '').includes('border-top'))
    .find((d) => d.text().includes(name))
  if (!row) throw new Error(`未找到成员行：${name}`)
  return row as DOMWrapper<Node>
}

function popupByText(w: VueWrapper, text: string): DOMWrapper<Node> {
  const popup = w.findAll('.van-popup').find((p) => p.text().includes(text))
  if (!popup) throw new Error(`未找到包含「${text}」的弹窗`)
  return popup as DOMWrapper<Node>
}

function fieldInput(scope: VueWrapper | DOMWrapper<Node>, label: string): DOMWrapper<HTMLInputElement> {
  const field = scope.findAll('.van-field').find((f) => f.text().includes(label))
  if (!field) throw new Error(`未找到 label 为「${label}」的 van-field`)
  return field.find('input') as DOMWrapper<HTMLInputElement>
}

async function openInvite(w: VueWrapper): Promise<DOMWrapper<Node>> {
  await buttonByText(w, '邀请').trigger('click')
  await flushPromises()
  return popupByText(w, '邀请成员')
}

beforeEach(() => {
  mocks.currentPatientId.value = 'patient-default'
  mocks.showToast.mockReset()
  mocks.showConfirmDialog.mockReset().mockResolvedValue(undefined)
  mocks.refreshCurrentRole.mockReset().mockResolvedValue(undefined)
  currentRoleRef.value = 'owner' // 默认是创建者视角，非 owner 的用例单独覆盖
  isLoggedInRef.value = true
  vi.mocked(listMembers).mockReset().mockResolvedValue([])
  vi.mocked(inviteMember).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(setMemberRole).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(removeMember).mockReset().mockResolvedValue({ ok: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('MembersView · 加载与列表渲染', () => {
  it('加载中显示骨架，数据到位后消失', async () => {
    vi.mocked(listMembers).mockResolvedValue([owner])
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: defineComponent({ render: () => h('div') }) },
        { path: '/members', component: MembersView },
      ],
    })
    await router.push('/members')
    await router.isReady()
    const w = mount(MembersView, { global: { plugins: [Vant, router], stubs: { teleport: true } } })
    wrapper = w

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(true)
    await flushPromises()
    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
  })

  it('按当前病人拉取成员列表', async () => {
    await mountMembers()
    expect(listMembers).toHaveBeenCalledWith('patient-default')
  })

  it('渲染姓名、手机号与角色中文名', async () => {
    const w = await mountMembers()

    expect(rowByName(w, '张三').text()).toContain('13800000000')
    expect(rowByName(w, '张三').find('.van-tag').text()).toBe('创建者')
    expect(rowByName(w, '李四').find('.van-tag').text()).toBe('家属/护工')
    expect(rowByName(w, '未命名').find('.van-tag').text()).toBe('只读')
  })

  it('姓名与手机号都为空时显示「未命名」兜底', async () => {
    const w = await mountMembers()

    const row = rowByName(w, '未命名')
    expect(row.find('.num').text()).toBe('未命名')
  })

  it('未知角色原样显示，不显示空白', async () => {
    const w = await mountMembers([{ userId: 'u9', name: '王五', phone: '13700000000', role: 'admin' }])
    expect(rowByName(w, '王五').find('.van-tag').text()).toBe('admin')
  })

  it('没有成员时显示空提示', async () => {
    const w = await mountMembers([])
    expect(w.text()).toContain('暂无成员')
  })
})

describe('MembersView · 操作入口的显隐', () => {
  it('创建者行没有编辑/移除图标，其他成员行都有（我是 owner）', async () => {
    const w = await mountMembers()

    expect(rowByName(w, '张三').find('.van-icon-edit').exists()).toBe(false)
    expect(rowByName(w, '张三').find('.van-icon-delete-o').exists()).toBe(false)

    expect(rowByName(w, '李四').find('.van-icon-edit').exists()).toBe(true)
    expect(rowByName(w, '李四').find('.van-icon-delete-o').exists()).toBe(true)
    expect(rowByName(w, '未命名').find('.van-icon-edit').exists()).toBe(true)

    // 整页只有两个非创建者行带图标
    expect(w.findAll('.van-icon-edit')).toHaveLength(2)
    expect(w.findAll('.van-icon-delete-o')).toHaveLength(2)
  })

  it('我不是 owner（caregiver）时隐藏改角色/移除入口，并说明原因（M5）', async () => {
    currentRoleRef.value = 'caregiver'
    const w = await mountMembers()

    // 列表照常可见，但一个管理入口都不该出现（服务端只允许 owner 操作）
    expect(rowByName(w, '李四').find('.van-icon-edit').exists()).toBe(false)
    expect(rowByName(w, '李四').find('.van-icon-delete-o').exists()).toBe(false)
    expect(w.findAll('.van-icon-edit')).toHaveLength(0)
    expect(w.findAll('.van-icon-delete-o')).toHaveLength(0)
    expect(hasButton(w, '邀请')).toBe(false)
    expect(w.text()).toContain('仅创建者可管理成员与邀请')
    expect(w.text()).toContain('家属/护工')
  })

  it('角色未知（null）时不收口，避免把真正的 owner 锁在门外', async () => {
    currentRoleRef.value = null
    const w = await mountMembers()

    expect(hasButton(w, '邀请')).toBe(true)
    expect(w.findAll('.van-icon-edit')).toHaveLength(2)
  })

  it('挂载后刷新一次角色（M5 的收口依赖它）', async () => {
    await mountMembers()

    expect(mocks.refreshCurrentRole).toHaveBeenCalledTimes(1)
  })
})

describe('MembersView · 申请入口的写操作守卫', () => {
  it('非 owner 时即使直接点行内图标也不会发起修改/移除（双保险）', async () => {
    const w = await mountMembers()
    currentRoleRef.value = 'viewer'

    // 图标已隐藏；这里模拟「界面没来得及刷新」时点到旧入口
    const editIcon = w.findAll('.van-icon-edit')[0]
    if (editIcon) await editIcon.trigger('click')
    await flushPromises()

    expect(setMemberRole).not.toHaveBeenCalled()
    expect(removeMember).not.toHaveBeenCalled()
  })
})

describe('MembersView · 邀请成员', () => {
  it('默认角色「家属/护工」：提交时带上 patientId / phone / role', async () => {
    const w = await mountMembers()
    const popup = await openInvite(w)

    await fieldInput(popup, '手机号').setValue('13700000000')
    await buttonByText(popup, '邀请').trigger('click')
    await flushPromises()

    expect(inviteMember).toHaveBeenCalledWith('patient-default', '13700000000', 'caregiver')
    expect(mocks.showToast).toHaveBeenCalledWith('邀请成功')
    expect(listMembers).toHaveBeenCalledTimes(2) // 成功后重读列表
  })

  it('选择「医生」角色后按新角色提交', async () => {
    const w = await mountMembers()
    const popup = await openInvite(w)

    const doctorRadio = popup.findAll('.van-radio').find((r) => r.text() === '医生')
    expect(doctorRadio).toBeTruthy()
    await doctorRadio!.trigger('click')

    await fieldInput(popup, '手机号').setValue('13700000000')
    await buttonByText(popup, '邀请').trigger('click')
    await flushPromises()

    expect(inviteMember).toHaveBeenCalledWith('patient-default', '13700000000', 'doctor')
  })

  it('手机号非法时不调接口，只弹提示', async () => {
    const w = await mountMembers()
    const popup = await openInvite(w)

    await fieldInput(popup, '手机号').setValue('12345')
    await buttonByText(popup, '邀请').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('请输入正确的手机号')
    expect(inviteMember).not.toHaveBeenCalled()
    expect(listMembers).toHaveBeenCalledTimes(1) // 没有重读
  })

  it('邀请失败时提示服务端错误，弹窗不关、列表不重读', async () => {
    vi.mocked(inviteMember).mockResolvedValue({ ok: false, error: '该手机号未注册' })
    const w = await mountMembers()
    const popup = await openInvite(w)

    await fieldInput(popup, '手机号').setValue('13700000000')
    await buttonByText(popup, '邀请').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('该手机号未注册')
    expect(listMembers).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('邀请成员')
  })

  it('取消邀请后清空手机号，重新打开是干净的表单（L2）', async () => {
    const w = await mountMembers()
    const popup = await openInvite(w)

    await fieldInput(popup, '手机号').setValue('13700000000')
    await buttonByText(popup, '取消').trigger('click')
    await flushPromises()

    await buttonByText(w, '邀请').trigger('click')
    await flushPromises()
    const reopened = popupByText(w, '邀请成员')
    expect(fieldInput(reopened, '手机号').element.value).toBe('')
  })

  it('提交时按钮 loading，连点只调用一次 inviteMember（L2）', async () => {
    let release!: (v: { ok: boolean }) => void
    vi.mocked(inviteMember).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const w = await mountMembers()
    const popup = await openInvite(w)
    await fieldInput(popup, '手机号').setValue('13700000000')

    // loading 时按钮文案会被 Vant 换成转圈，按「弹窗里最后一个按钮」定位
    const buttons = popup.findAll('button')
    const inviteBtn = buttons[buttons.length - 1]
    await inviteBtn.trigger('click')
    await inviteBtn.trigger('click')
    expect(inviteMember).toHaveBeenCalledTimes(1)
    expect(inviteBtn.classes()).toContain('van-button--loading')

    release({ ok: true })
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('邀请成功')
    expect(inviteBtn.classes()).not.toContain('van-button--loading')
  })

  it('邀请接口抛异常时给出提示，按钮复位（不永久转圈）', async () => {
    vi.mocked(inviteMember).mockRejectedValueOnce(new Error('Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountMembers()
    const popup = await openInvite(w)

    await fieldInput(popup, '手机号').setValue('13700000000')
    await buttonByText(popup, '邀请').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('邀请失败，请检查网络后重试')
    expect(buttonByText(popup, '邀请').classes()).not.toContain('van-button--loading')
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('MembersView · 移除成员', () => {
  it('确认后调用 removeMember 并重读列表', async () => {
    const w = await mountMembers()

    await rowByName(w, '李四').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1)
    expect(removeMember).toHaveBeenCalledWith('patient-default', 'u2')
    expect(mocks.showToast).toHaveBeenCalledWith('已移除')
    expect(listMembers).toHaveBeenCalledTimes(2)
  })

  it('取消确认时不调接口', async () => {
    const w = await mountMembers()
    mocks.showConfirmDialog.mockRejectedValueOnce(new Error('cancel'))

    await rowByName(w, '李四').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(removeMember).not.toHaveBeenCalled()
  })

  it('移除失败时提示服务端错误', async () => {
    vi.mocked(removeMember).mockResolvedValue({ ok: false, error: '仅创建者可管理成员' })
    const w = await mountMembers()

    await rowByName(w, '李四').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('仅创建者可管理成员')
    expect(listMembers).toHaveBeenCalledTimes(1)
  })
})

describe('MembersView · 修改角色', () => {
  it('选中新角色后调用 setMemberRole 并重读列表', async () => {
    const w = await mountMembers()

    await rowByName(w, '未命名').find('.van-icon-edit').trigger('click')
    await flushPromises()

    const item = w.findAll('.van-action-sheet__item').find((i) => i.text().includes('医生（只读）'))
    expect(item).toBeTruthy()
    await item!.trigger('click')
    await flushPromises()

    expect(setMemberRole).toHaveBeenCalledWith('patient-default', 'u3', 'doctor')
    expect(mocks.showToast).toHaveBeenCalledWith('角色已更新')
    expect(listMembers).toHaveBeenCalledTimes(2)
  })

  it('选中的角色与当前角色相同则不调接口', async () => {
    const w = await mountMembers()

    await rowByName(w, '未命名').find('.van-icon-edit').trigger('click')
    await flushPromises()

    const item = w.findAll('.van-action-sheet__item').find((i) => i.text().trim() === '只读')
    await item!.trigger('click')
    await flushPromises()

    expect(setMemberRole).not.toHaveBeenCalled()
    expect(listMembers).toHaveBeenCalledTimes(1)
  })

  it('修改失败时提示服务端错误', async () => {
    vi.mocked(setMemberRole).mockResolvedValue({ ok: false, error: '无权限' })
    const w = await mountMembers()

    await rowByName(w, '未命名').find('.van-icon-edit').trigger('click')
    await flushPromises()
    const item = w.findAll('.van-action-sheet__item').find((i) => i.text().includes('家属/护工'))
    await item!.trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('无权限')
  })
})

describe('MembersView · 缓存刷新', () => {
  it('cacheVersion 变化会重读成员列表', async () => {
    await mountMembers()
    expect(listMembers).toHaveBeenCalledTimes(1)

    vi.mocked(listMembers).mockClear()
    cacheVersion.value += 1
    await flushPromises()

    expect(listMembers).toHaveBeenCalledTimes(1)
    expect(listMembers).toHaveBeenCalledWith('patient-default')
  })
})

describe('MembersView · 加载失败与被踢下线', () => {
  it('成员列表加载失败时给提示并收掉骨架（不永久白等）', async () => {
    vi.mocked(listMembers).mockRejectedValueOnce(new Error('Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const w = await mountMembers()

    expect(w.findComponent({ name: 'VanSkeleton' }).exists()).toBe(false)
    expect(mocks.showToast).toHaveBeenCalledWith('成员列表加载失败，请检查网络后重试')
    expect(errSpy).toHaveBeenCalled()
  })

  it('被踢下线（isLoggedIn 由 true 变 false）时提示并引导回登录页（M6）', async () => {
    await mountMembers()

    isLoggedInRef.value = false
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('登录状态已失效，请重新登录')
    expect(router.currentRoute.value.path).toBe('/login')
  })
})

describe('MembersView · 修改角色与移除的失败兜底', () => {
  it('移除成员接口抛异常时给出提示', async () => {
    vi.mocked(removeMember).mockRejectedValueOnce(new Error('删除成员失败：可能没有修改权限'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountMembers()

    await rowByName(w, '李四').find('.van-icon-delete-o').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('移除失败，请检查网络后重试')
    expect(errSpy).toHaveBeenCalled()
  })

  it('修改角色接口抛异常时给出提示', async () => {
    vi.mocked(setMemberRole).mockRejectedValueOnce(new Error('Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountMembers()

    await rowByName(w, '未命名').find('.van-icon-edit').trigger('click')
    await flushPromises()
    const item = w.findAll('.van-action-sheet__item').find((i) => i.text().includes('医生（只读）'))
    await item!.trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('更新失败，请检查网络后重试')
    expect(errSpy).toHaveBeenCalled()
  })
})
