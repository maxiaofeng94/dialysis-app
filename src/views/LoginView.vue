<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useAuth } from '../stores/auth'

const router = useRouter()
const { initialized, isLoggedIn, sendCode, verifyAndLogin } = useAuth()

const phone = ref('')
const code = ref('')
const sending = ref(false)
const loggingIn = ref(false)
const countdown = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  if (initialized.value && isLoggedIn.value) router.replace('/')
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

function startCountdown() {
  countdown.value = 60
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0 && timer) clearInterval(timer)
  }, 1000)
}

async function onSendCode() {
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    showToast('请输入正确的手机号')
    return
  }
  sending.value = true
  const res = await sendCode(phone.value)
  sending.value = false
  showToast(res.message)
  if (res.ok) startCountdown()
}

async function onLogin() {
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    showToast('请输入正确的手机号')
    return
  }
  if (!/^\d{6}$/.test(code.value)) {
    showToast('请输入 6 位验证码')
    return
  }
  loggingIn.value = true
  const res = await verifyAndLogin(phone.value, code.value)
  loggingIn.value = false
  showToast(res.message)
  if (res.ok) router.replace('/')
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">透</div>
      <div class="login-title">透析记录</div>
      <div class="login-sub">手机号验证码登录</div>

      <van-field v-model="phone" type="tel" maxlength="11" label="手机号" placeholder="请输入手机号" />
      <div class="code-row">
        <van-field v-model="code" type="digit" maxlength="6" label="验证码" placeholder="6位验证码" />
        <van-button
          size="small"
          type="primary"
          :disabled="countdown > 0 || sending"
          :loading="sending"
          @click="onSendCode"
        >
          {{ countdown > 0 ? `${countdown}s` : '获取验证码' }}
        </van-button>
      </div>

      <van-button type="primary" block :loading="loggingIn" style="margin-top: 20px" @click="onLogin">
        登录 / 注册
      </van-button>
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
.code-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.code-row :deep(.van-field) {
  flex: 1;
}
.code-row :deep(.van-button) {
  flex-shrink: 0;
  margin-right: 16px;
}
</style>
