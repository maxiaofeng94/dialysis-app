<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { consumeSignOutReason, login } from '../lib/auth'
import { isConfigured } from '../lib/supabase'

const router = useRouter()
const route = useRoute()

const phone = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

onMounted(() => {
  const reason = consumeSignOutReason()
  if (reason) error.value = reason
})

async function onSubmit() {
  error.value = ''
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    error.value = '请输入正确的手机号'
    return
  }
  if (password.value.length < 6) {
    error.value = '密码至少 6 位'
    return
  }
  loading.value = true
  const res = await login(phone.value, password.value)
  loading.value = false
  if (!res.ok) {
    error.value = res.message
    return
  }
  ElMessage.success('登录成功')
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  void router.replace(redirect)
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>透析记录 · 后台管理</h1>
      <div class="login-sub">请使用管理员手机号登录（与 App 同一套账号）</div>

      <el-alert
        v-if="!isConfigured"
        type="warning"
        :closable="false"
        show-icon
        title="未配置 Supabase 连接"
        description="缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY，请检查 .env 文件。"
        style="margin-bottom: 12px"
      />

      <el-form label-position="top" @submit.prevent="onSubmit">
        <el-form-item label="手机号">
          <el-input
            v-model="phone"
            maxlength="11"
            placeholder="11 位手机号"
            autocomplete="username"
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            type="password"
            show-password
            placeholder="登录密码"
            autocomplete="current-password"
            @keyup.enter="onSubmit"
          />
        </el-form-item>
      </el-form>

      <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

      <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="onSubmit">
        登录
      </el-button>

      <div class="muted" style="margin-top: 14px; font-size: 12px; line-height: 1.7">
        仅管理员可进入。若提示「没有后台权限」，请让现有管理员在「用户管理 → 用户详情」中授予管理员身份。<br />
        手机端 App 与后台共用账号，忘记密码可由其他管理员重置。
      </div>
    </div>
  </div>
</template>
