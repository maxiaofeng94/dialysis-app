<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useAuth } from '../stores/auth'
import { isCloudConfigured, preflightCloud } from '../lib/supabase'

const router = useRouter()
const { initialized, isLoggedIn, register, login } = useAuth()

/** 本地单机版（没配 .env）：没有云端账号体系，登录页只做提示用 */
const cloudConfigured = isCloudConfigured

const mode = ref<'login' | 'register'>('login')
const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const submitting = ref(false)

/**
 * 网络预检状态。
 *
 * 移动数据（尤其信号只有一两格时）到云端服务器的第一次连接要现做 DNS + TLS 握手，
 * 失败率明显高于 Wi-Fi —— 用户看到的就是「用流量登录总报网络异常」。
 * 所以一进登录页就先探一次（顺带把连接预热好）：
 * - 通：用户点登录时直接复用这条连接；
 * - 不通：在他输完手机号之前就把原因说清楚，并给「重新检测」，
 *   而不是等他填完、点下去、再等满 15 秒 × 3 次重试。
 */
const netState = ref<'checking' | 'ok' | 'fail'>('checking')
/** 重试进行中的提示（登录最多要跑 3 次、每次 15 秒超时，没反馈用户会以为卡死） */
const retryTip = ref('')

async function checkNetwork(): Promise<void> {
  if (!cloudConfigured) return
  netState.value = 'checking'
  netState.value = (await preflightCloud()) ? 'ok' : 'fail'
}

/**
 * Supabase 返回的是英文原文（Invalid login credentials / Failed to fetch …），
 * 40~60 岁的家属看不懂。这里在 App 侧自己维护一份中文映射（不 import 后台管理端模块）。
 */
function friendlyAuthError(message: string): string {
  const raw = (message ?? '').trim()
  if (!raw) return '操作失败，请稍后再试'
  const m = raw.toLowerCase()
  if (m.includes('invalid login credentials') || m.includes('invalid_grant')) return '手机号或密码不正确'
  if (
    m.includes('failed to fetch') ||
    m.includes('networkerror') ||
    m.includes('network request failed') ||
    m.includes('load failed') ||
    m.includes('etimedout') ||
    m.includes('timeout')
  ) {
    return '网络连接失败，请检查网络后重试'
  }
  if (m.includes('email not confirmed')) return '账号尚未验证，请先完成验证'
  if (m.includes('user already registered') || m.includes('already been registered') || m.includes('already registered')) {
    return '该手机号已注册，请直接登录'
  }
  if (m.includes('rate limit') || m.includes('too many')) return '尝试过于频繁，请稍后再试'
  if (m.includes('signups not allowed') || m.includes('signup is disabled')) return '当前暂不开放注册'
  if (m.includes('password should be at least')) return '密码至少 6 位'
  return raw
}

/** 提交时抛出的异常（断网、本地模式未配置云端导致 supabase 为 null 的 TypeError…）转成用户提示 */
function errorToMessage(err: unknown): string {
  if (!cloudConfigured) return '当前是本地单机模式（未配置云端），无需登录即可直接使用'
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (err instanceof TypeError || /fetch|network|load failed/i.test(raw)) {
    return '网络连接失败，请检查网络后重试'
  }
  return friendlyAuthError(raw)
}

// ---------- 人机验证（Cloudflare Turnstile，可选） ----------
// 配置了 VITE_TURNSTILE_SITE_KEY 才启用；未配置时整块不渲染、不加载外部脚本，
// 与加固前的行为完全一致（服务端此时只靠限流兜底）。
const turnstileSiteKey = ((import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '').trim()
const turnstileEnabled = Boolean(turnstileSiteKey)
const turnstileToken = ref('')
const turnstileBox = ref<HTMLElement | null>(null)
let turnstileWidgetId: string | null = null

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

function loadTurnstileScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { turnstile?: unknown }
    if (w.turnstile) return resolve()
    const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile]')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('turnstile script error')))
      return
    }
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT
    script.async = true
    script.defer = true
    script.dataset.turnstile = '1'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('turnstile script error'))
    document.head.appendChild(script)
  })
}

async function renderTurnstile() {
  if (!turnstileEnabled || mode.value !== 'register') return
  try {
    await loadTurnstileScript()
    await nextTick()
    const ts = (window as unknown as { turnstile?: any }).turnstile
    if (!ts || !turnstileBox.value || turnstileWidgetId) return
    turnstileWidgetId = ts.render(turnstileBox.value, {
      sitekey: turnstileSiteKey,
      callback: (token: string) => {
        turnstileToken.value = token
      },
      'expired-callback': () => {
        turnstileToken.value = ''
      },
      'error-callback': () => {
        turnstileToken.value = ''
      },
    })
  } catch {
    // 脚本拉不到时不阻塞提交：服务端仍有限流兜底，失败会给出明确提示
    turnstileToken.value = ''
  }
}

/** 验证 token 一次性：每次提交失败都要作废重来 */
function resetTurnstile() {
  turnstileToken.value = ''
  const ts = (window as unknown as { turnstile?: any }).turnstile
  if (ts && turnstileWidgetId) {
    try {
      ts.reset(turnstileWidgetId)
    } catch {
      // ignore
    }
  }
}

onMounted(() => {
  if (initialized.value && isLoggedIn.value) router.replace('/')
  void renderTurnstile()
  // 先探一次网络：连不上就早点提示，能连上就当预热了这条连接
  void checkNetwork()
})

function toggleMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  password.value = ''
  confirmPassword.value = ''
  resetTurnstile()
  void renderTurnstile()
}

function validate(): string | null {
  if (!/^1[3-9]\d{9}$/.test(phone.value)) return '请输入正确的手机号'
  if (password.value.length < 6) return '密码至少 6 位'
  return null
}

async function onSubmit() {
  const err = validate()
  if (err) {
    showToast(err)
    return
  }
  if (mode.value === 'register') {
    if (password.value !== confirmPassword.value) {
      showToast('两次输入的密码不一致')
      return
    }
    if (turnstileEnabled && !turnstileToken.value) {
      showToast('请先完成人机验证')
      return
    }
  }

  submitting.value = true
  retryTip.value = ''
  // 无论正常返回、失败还是抛异常（断网 / 未配置云端），finally 一定复位按钮，
  // 否则页面会永久转圈，用户只能杀进程。
  try {
    if (mode.value === 'register') {
      const reg = await register(phone.value, password.value, turnstileToken.value || undefined)
      if (!reg.ok) {
        showToast(friendlyAuthError(reg.message))
        resetTurnstile()
        return
      }
    }
    const res = await login(phone.value, password.value, (attempt, total) => {
      retryTip.value = `网络较慢，正在重试（第 ${attempt}/${total} 次）…`
    })
    showToast(res.ok ? res.message : friendlyAuthError(res.message))
    if (res.ok) {
      await router.replace('/')
    } else {
      // 登录失败后重新探一次：让用户马上看到「是网络的事」还是「账号密码的事」
      void checkNetwork()
    }
  } catch (e) {
    console.error(e)
    showToast(errorToMessage(e))
    resetTurnstile()
  } finally {
    submitting.value = false
    retryTip.value = ''
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">透</div>
      <div class="login-title">透析记录</div>
      <div class="login-sub">{{ mode === 'login' ? '手机号 + 密码登录' : '注册新账号' }}</div>

      <!-- 本地单机版没有云端账号体系：先把话说清楚，别让用户在这里反复试密码 -->
      <div v-if="!cloudConfigured" class="login-hint">
        当前是本地单机模式（未配置云端），无需登录，返回即可直接使用
      </div>

      <!-- 网络预检（移动数据下最容易遇到）：连不上就先说清楚，别让用户填完再等 45 秒 -->
      <div v-else-if="netState === 'fail'" class="login-warn">
        <div class="login-warn-text">当前网络连不上服务器，请检查手机移动数据 / Wi-Fi 后重试</div>
        <button class="login-warn-retry" type="button" @click="checkNetwork">重新检测</button>
      </div>

      <van-field v-model="phone" type="tel" maxlength="11" label="手机号" placeholder="请输入手机号" />
      <van-field v-model="password" type="password" label="密码" placeholder="至少 6 位" />
      <van-field
        v-if="mode === 'register'"
        v-model="confirmPassword"
        type="password"
        label="确认密码"
        placeholder="再次输入密码"
      />

      <div v-if="turnstileEnabled && mode === 'register'" ref="turnstileBox" class="turnstile-box"></div>

      <van-button type="primary" block :loading="submitting" style="margin-top: 20px" @click="onSubmit">
        {{ mode === 'login' ? '登录' : '注册并登录' }}
      </van-button>

      <div v-if="retryTip" class="login-retry-tip">{{ retryTip }}</div>

      <div class="toggle" @click="toggleMode">
        {{ mode === 'login' ? '没有账号？去注册' : '已有账号？去登录' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #e8f7ef, #f2f3f5 40%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 360px;
  background: #fff;
  border-radius: 16px;
  padding: 28px 20px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
}
.login-logo {
  width: 56px;
  height: 56px;
  margin: 0 auto;
  border-radius: 14px;
  background: linear-gradient(135deg, #07c160, #05a84f);
  color: #fff;
  font-size: 28px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-title {
  text-align: center;
  font-size: 18px;
  font-weight: 700;
  margin-top: 10px;
}
.login-sub {
  text-align: center;
  color: #969799;
  font-size: 13px;
  margin: 4px 0 20px;
}
.login-hint {
  margin: -8px 0 16px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fff7e6;
  color: #ed6a0c;
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}
/* 网络预检失败的提示条：移动数据下连不上服务器时，先于「登录失败」出现 */
.login-warn {
  margin: -8px 0 16px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fff1f0;
  color: #ee0a24;
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}
.login-warn-text {
  margin-bottom: 8px;
}
.login-warn-retry {
  border: 1px solid #ee0a24;
  background: transparent;
  color: #ee0a24;
  font-size: 12px;
  padding: 4px 14px;
  border-radius: 999px;
}
/* 重试进行中的提示：登录最多要跑 3 次、每次 15 秒超时，必须让用户看到「还在努力」 */
.login-retry-tip {
  margin-top: 10px;
  text-align: center;
  color: #ed6a0c;
  font-size: 12px;
}
.toggle {
  text-align: center;
  color: #07c160;
  font-size: 14px;
  margin-top: 16px;
  cursor: pointer;
}
.turnstile-box {
  display: flex;
  justify-content: center;
  margin-top: 16px;
  min-height: 65px;
}
</style>
