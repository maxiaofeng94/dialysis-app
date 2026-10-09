/**
 * LoginView（登录/注册页）组件测试
 *
 * 覆盖：手机号与密码校验、登录成功跳转、登录失败提示、注册流程（含两次密码一致性）、
 * 登录/注册模式切换、人机验证未配置时不加载外部脚本、
 * 提交抛异常时不卡死（按钮复位 + 中文提示）、Supabase 英文错误的中文映射、本地单机模式提示。
 *
 * 说明：登录/注册的实现在 stores/auth（另一个测试文件负责），这里只把 useAuth 换成桩，
 * 验证「页面把校验与调用串对了没有」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import LoginView from '../../src/views/LoginView.vue'

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  register: vi.fn(),
  login: vi.fn(),
  initialized: { value: true },
  isLoggedIn: { value: false },
  // 是否配置了云端（isCloudConfigured）：用它切换「多人版 / 本地单机版」两条分支
  supabase: { isCloudConfigured: false },
}))

vi.mock('../../src/stores/auth', () => ({
  useAuth: () => ({
    initialized: mocks.initialized,
    isLoggedIn: mocks.isLoggedIn,
    register: mocks.register,
    login: mocks.login,
  }),
}))

vi.mock('../../src/lib/supabase', () => ({
  get isCloudConfigured() {
    return mocks.supabase.isCloudConfigured
  },
}))

vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showToast: mocks.showToast }
})

let wrapper: VueWrapper | null = null
let router: Router

async function mountLogin(path = '/login'): Promise<VueWrapper> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: defineComponent({ render: () => h('div', { class: 'home' }) }) },
      { path: '/login', component: LoginView },
    ],
  })
  await router.push(path)
  await router.isReady()
  wrapper = mount(LoginView, { global: { plugins: [Vant, router] } })
  await flushPromises()
  return wrapper
}

function fieldInput(scope: VueWrapper | DOMWrapper<Node>, label: string): DOMWrapper<HTMLInputElement> {
  const field = scope.findAll('.van-field').find((f) => f.text().includes(label))
  if (!field) throw new Error(`未找到 label 为「${label}」的 van-field`)
  return field.find('input') as DOMWrapper<HTMLInputElement>
}

/** 按钮文案精确匹配（否则「注册并登录」会被「登录」命中） */
function buttonByText(scope: VueWrapper, text: string): DOMWrapper<HTMLButtonElement> {
  const btn = scope.findAll('button').find((b) => b.text().trim() === text)
  if (!btn) throw new Error(`未找到文案为「${text}」的按钮`)
  return btn as DOMWrapper<HTMLButtonElement>
}

/** 填好手机号与密码后提交 */
async function submit(w: VueWrapper, phone = '13800000000', password = '123456'): Promise<void> {
  await fieldInput(w, '手机号').setValue(phone)
  await fieldInput(w, '密码').setValue(password)
  await buttonByText(w, '登录').trigger('click')
  await flushPromises()
}

/** 切到「注册」模式 */
async function toRegister(w: VueWrapper): Promise<void> {
  await w.find('.toggle').trigger('click')
  await flushPromises()
}

/** 注册模式下一键填表并提交 */
async function submitRegister(w: VueWrapper, phone = '13800000000', password = '123456'): Promise<void> {
  await fieldInput(w, '手机号').setValue(phone)
  await fieldInput(w, '密码').setValue(password)
  await fieldInput(w, '确认密码').setValue(password)
  await buttonByText(w, '注册并登录').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  mocks.showToast.mockReset()
  mocks.register.mockReset().mockResolvedValue({ ok: true, message: '注册成功' })
  mocks.login.mockReset().mockResolvedValue({ ok: true, message: '登录成功' })
  mocks.initialized.value = true
  mocks.isLoggedIn.value = false
  mocks.supabase.isCloudConfigured = false
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('LoginView · 表单校验', () => {
  it('手机号不合法时不提交、不调登录、只弹提示', async () => {
    const w = await mountLogin()

    await submit(w, '12345678901') // 不是 1[3-9] 开头

    expect(mocks.showToast).toHaveBeenCalledWith('请输入正确的手机号')
    expect(mocks.login).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('密码不足 6 位时不提交', async () => {
    const w = await mountLogin()

    await submit(w, '13800000000', '12345')

    expect(mocks.showToast).toHaveBeenCalledWith('密码至少 6 位')
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('手机号为空时也不提交', async () => {
    const w = await mountLogin()

    await submit(w, '', '123456')

    expect(mocks.showToast).toHaveBeenCalledWith('请输入正确的手机号')
    expect(mocks.login).not.toHaveBeenCalled()
  })
})

describe('LoginView · 登录', () => {
  it('登录成功：提示成功并跳转到首页', async () => {
    const w = await mountLogin()

    await submit(w)

    expect(mocks.login).toHaveBeenCalledWith('13800000000', '123456')
    expect(mocks.showToast).toHaveBeenCalledWith('登录成功')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('登录失败：显示服务端错误信息且留在登录页', async () => {
    mocks.login.mockResolvedValue({ ok: false, message: '密码错误' })
    const w = await mountLogin()

    await submit(w)

    expect(mocks.showToast).toHaveBeenCalledWith('密码错误')
    expect(router.currentRoute.value.path).toBe('/login')
    // 提交状态被复位（按钮不再转圈，可以重试）
    expect(buttonByText(w, '登录').classes()).not.toContain('van-button--loading')
  })

  it('已经登录过（initialized 且 isLoggedIn）时直接跳首页', async () => {
    mocks.isLoggedIn.value = true
    await mountLogin()

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('尚未初始化（initialized=false）时不跳转', async () => {
    mocks.isLoggedIn.value = true
    mocks.initialized.value = false
    await mountLogin()

    expect(router.currentRoute.value.path).toBe('/login')
  })
})

describe('LoginView · 登录/注册切换', () => {
  it('切换后文案与字段变化，并清空已输入的密码', async () => {
    const w = await mountLogin()
    expect(w.text()).toContain('手机号 + 密码登录')
    expect(w.findAll('.van-field')).toHaveLength(2)

    await fieldInput(w, '密码').setValue('oldpass')
    await w.find('.toggle').trigger('click')

    expect(w.text()).toContain('注册新账号')
    expect(w.text()).toContain('已有账号？去登录')
    expect(w.text()).toContain('注册并登录')
    expect(w.findAll('.van-field')).toHaveLength(3) // 多出「确认密码」
    expect(fieldInput(w, '密码').element.value).toBe('') // 切换时清空
    expect(fieldInput(w, '确认密码').element.value).toBe('')

    await w.find('.toggle').trigger('click')
    expect(w.text()).toContain('手机号 + 密码登录')
    expect(w.findAll('.van-field')).toHaveLength(2)
  })
})

describe('LoginView · 注册', () => {
  async function switchToRegister(w: VueWrapper): Promise<void> {
    await w.find('.toggle').trigger('click')
    await flushPromises()
  }

  it('注册成功后自动登录并跳转首页', async () => {
    const w = await mountLogin()
    await switchToRegister(w)

    await fieldInput(w, '手机号').setValue('13800000000')
    await fieldInput(w, '密码').setValue('123456')
    await fieldInput(w, '确认密码').setValue('123456')
    await buttonByText(w, '注册并登录').trigger('click')
    await flushPromises()

    expect(mocks.register).toHaveBeenCalledWith('13800000000', '123456', undefined)
    expect(mocks.login).toHaveBeenCalledWith('13800000000', '123456')
    // 注册成功后界面提示的是「登录」这一步的结果文案（register 的成功文案不会展示）
    expect(mocks.showToast).toHaveBeenCalledWith('登录成功')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('两次密码不一致时不调注册接口', async () => {
    const w = await mountLogin()
    await switchToRegister(w)

    await fieldInput(w, '手机号').setValue('13800000000')
    await fieldInput(w, '密码').setValue('123456')
    await fieldInput(w, '确认密码').setValue('654321')
    await buttonByText(w, '注册并登录').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('两次输入的密码不一致')
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('注册失败时提示错误、不继续登录、提交状态复位', async () => {
    mocks.register.mockResolvedValue({ ok: false, message: '该手机号已注册' })
    const w = await mountLogin()
    await switchToRegister(w)

    await fieldInput(w, '手机号').setValue('13800000000')
    await fieldInput(w, '密码').setValue('123456')
    await fieldInput(w, '确认密码').setValue('123456')
    await buttonByText(w, '注册并登录').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('该手机号已注册')
    expect(mocks.login).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/login')
    expect(buttonByText(w, '注册并登录').classes()).not.toContain('van-button--loading')
  })

  it('注册模式同样先做手机号/密码校验', async () => {
    const w = await mountLogin()
    await switchToRegister(w)

    await fieldInput(w, '手机号').setValue('12345')
    await fieldInput(w, '密码').setValue('123456')
    await fieldInput(w, '确认密码').setValue('123456')
    await buttonByText(w, '注册并登录').trigger('click')
    await flushPromises()

    expect(mocks.showToast).toHaveBeenCalledWith('请输入正确的手机号')
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('未配置 Turnstile（VITE_TURNSTILE_SITE_KEY 为空）时不渲染验证区、不加载外部脚本', async () => {
    expect(import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').toBe('') // 测试环境不该带这个变量
    const w = await mountLogin()
    await switchToRegister(w)

    expect(w.find('.turnstile-box').exists()).toBe(false)
    expect(document.head.querySelector('script[data-turnstile]')).toBeNull()
    // 不因缺人机验证而挡住注册
    expect(w.text()).toContain('注册并登录')
  })
})

describe('LoginView · 提交抛异常不卡死（H3）', () => {
  it('登录抛异常（断网）：按钮复位、给出网络提示、留在登录页', async () => {
    mocks.supabase.isCloudConfigured = true
    mocks.login.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountLogin()

    await submit(w)

    expect(mocks.showToast).toHaveBeenCalledWith('网络连接失败，请检查网络后重试')
    expect(buttonByText(w, '登录').classes()).not.toContain('van-button--loading') // 不再永久转圈
    expect(router.currentRoute.value.path).toBe('/login')
    expect(errSpy).toHaveBeenCalled()
  })

  it('注册抛异常：提示网络失败、不继续登录、按钮恢复可用', async () => {
    mocks.supabase.isCloudConfigured = true
    mocks.register.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountLogin()
    await toRegister(w)

    await submitRegister(w)

    expect(mocks.showToast).toHaveBeenCalledWith('网络连接失败，请检查网络后重试')
    expect(mocks.login).not.toHaveBeenCalled()
    expect(buttonByText(w, '注册并登录').classes()).not.toContain('van-button--loading')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(errSpy).toHaveBeenCalled()
  })

  it('本地单机模式手动进登录页：明确说明无需登录，提交也不会卡死（H3）', async () => {
    // 未配置云端时 stores/auth 里的 supabase! 是 null，调用会抛 TypeError
    mocks.login.mockRejectedValueOnce(new TypeError("Cannot read properties of null (reading 'auth')"))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = await mountLogin()

    expect(w.text()).toContain('当前是本地单机模式')

    await submit(w)

    expect(mocks.showToast).toHaveBeenCalledWith('当前是本地单机模式（未配置云端），无需登录即可直接使用')
    expect(buttonByText(w, '登录').classes()).not.toContain('van-button--loading')
    expect(errSpy).toHaveBeenCalled()
  })

  it('云端模式下不显示「本地单机模式」提示', async () => {
    mocks.supabase.isCloudConfigured = true
    const w = await mountLogin()

    expect(w.text()).not.toContain('当前是本地单机模式')
  })
})

describe('LoginView · 错误文案中文化（L1）', () => {
  it('Invalid login credentials → 手机号或密码不正确', async () => {
    mocks.login.mockResolvedValue({ ok: false, message: 'Invalid login credentials' })
    const w = await mountLogin()

    await submit(w)

    expect(mocks.showToast).toHaveBeenCalledWith('手机号或密码不正确')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('Failed to fetch → 网络连接失败，请检查网络后重试', async () => {
    mocks.login.mockResolvedValue({ ok: false, message: 'Failed to fetch' })
    const w = await mountLogin()

    await submit(w)

    expect(mocks.showToast).toHaveBeenCalledWith('网络连接失败，请检查网络后重试')
  })

  it('Rate limit 类错误 → 尝试过于频繁，请稍后再试', async () => {
    mocks.login.mockResolvedValue({ ok: false, message: 'Email rate limit exceeded' })
    const w = await mountLogin()

    await submit(w)

    expect(mocks.showToast).toHaveBeenCalledWith('尝试过于频繁，请稍后再试')
  })

  it('注册失败文案同样中文化：User already registered → 该手机号已注册', async () => {
    mocks.register.mockResolvedValue({ ok: false, message: 'User already registered' })
    const w = await mountLogin()
    await toRegister(w)

    await submitRegister(w)

    expect(mocks.showToast).toHaveBeenCalledWith('该手机号已注册，请直接登录')
    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('已经是中文的提示原样透传（不画蛇添足）', async () => {
    mocks.login.mockResolvedValue({ ok: false, message: '密码错误' })
    const w = await mountLogin()

    await submit(w)

    expect(mocks.showToast).toHaveBeenCalledWith('密码错误')
  })
})
