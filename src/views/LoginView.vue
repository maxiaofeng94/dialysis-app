<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useAuth } from '../stores/auth'

const router = useRouter()
const { initialized, isLoggedIn, register, login } = useAuth()

const mode = ref<'login' | 'register'>('login')
const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const submitting = ref(false)

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
  if (mode.value === 'register') {
    const reg = await register(phone.value, password.value, turnstileToken.value || undefined)
    if (!reg.ok) {
      showToast(reg.message)
      submitting.value = false
      resetTurnstile()
      return
    }
  }
  const res = await login(phone.value, password.value)
  submitting.value = false
  showToast(res.message)
  if (res.ok) router.replace('/')
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">透</div>
      <div class="login-title">透析记录</div>
      <div class="login-sub">{{ mode === 'login' ? '手机号 + 密码登录' : '注册新账号' }}</div>

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
