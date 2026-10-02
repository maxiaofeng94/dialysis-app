<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { logout, me } from '../lib/auth'
import { lastWarning } from '../lib/api'

const route = useRoute()
const router = useRouter()

// 审计日志写入失败等异常由接口层透出，这里统一提示（不影响操作本身已完成）
watch(lastWarning, (msg) => {
  if (!msg) return
  ElMessage.warning(msg)
  lastWarning.value = null
})

/** 空闲自动登出：30 分钟无操作即退出（后端 JWT 本身 1 小时过期） */
const IDLE_MS = 30 * 60 * 1000
const IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'] as const
let idleTimer: number | undefined

const activeMenu = computed(() => {
  const p = route.path
  if (p.startsWith('/users')) return '/users'
  if (p.startsWith('/patients')) return '/patients'
  if (p.startsWith('/audit')) return '/audit'
  if (p.startsWith('/me')) return '/me'
  return '/'
})

const title = computed(() => (route.meta.title as string | undefined) ?? '后台管理')
const whoText = computed(() => me.value?.name || me.value?.phone || '管理员')

function armIdleTimer() {
  if (idleTimer) window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(async () => {
    await logout('长时间未操作，已自动退出')
    ElMessage.warning('长时间未操作，已自动退出')
    void router.replace('/login')
  }, IDLE_MS)
}

onMounted(() => {
  for (const ev of IDLE_EVENTS) window.addEventListener(ev, armIdleTimer, { passive: true })
  armIdleTimer()
})

onUnmounted(() => {
  for (const ev of IDLE_EVENTS) window.removeEventListener(ev, armIdleTimer)
  if (idleTimer) window.clearTimeout(idleTimer)
})

async function onLogout() {
  await logout()
  void router.replace('/login')
}
</script>

<template>
  <el-container class="admin-shell">
    <el-aside width="200px" class="admin-aside">
      <div class="admin-brand">透析记录 · 后台</div>
      <el-menu :default-active="activeMenu" router>
        <el-menu-item index="/">概览</el-menu-item>
        <el-menu-item index="/users">用户管理</el-menu-item>
        <el-menu-item index="/patients">病人管理</el-menu-item>
        <el-menu-item index="/audit">操作日志</el-menu-item>
        <el-menu-item index="/me">我的账号</el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="admin-header">
        <div class="admin-title">{{ title }}</div>
        <div class="admin-who">
          <span>{{ whoText }}</span>
          <el-tag size="small" type="success">管理员</el-tag>
          <el-button link type="primary" @click="onLogout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="admin-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>
