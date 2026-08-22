<script setup lang="ts">
import { ref, onMounted } from 'vue'
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

onMounted(() => {
  if (initialized.value && isLoggedIn.value) router.replace('/')
})

function toggleMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  password.value = ''
  confirmPassword.value = ''
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
  submitting.value = true
  if (mode.value === 'register') {
    if (password.value !== confirmPassword.value) {
      showToast('两次输入的密码不一致')
      submitting.value = false
      return
    }
    const reg = await register(phone.value, password.value)
    if (!reg.ok) {
      showToast(reg.message)
      submitting.value = false
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
</style>
