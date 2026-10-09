<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, messageOf } from '../lib/api'
import type { OverviewStats } from '../lib/types'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const stats = ref<OverviewStats | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    stats.value = await api.overview()
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)

const cards = computed(() => {
  const s = stats.value
  if (!s) return []
  return [
    { label: '注册用户', value: s.userCount },
    { label: '病人', value: s.patientCount },
    { label: '透析记录总数', value: s.sessionCount },
    { label: '管理员', value: s.adminCount },
    { label: '近 7 天新增用户', value: s.newUsers7d },
    { label: '近 7 天新增记录', value: s.newSessions7d },
    { label: '近 7 天有记录的病人', value: s.activePatients7d },
  ]
})

const warnings = computed(() => {
  const s = stats.value
  if (!s) return [] as { text: string; to: string }[]
  const list: { text: string; to: string }[] = []
  if (s.patientsWithoutMember) {
    list.push({ text: `${s.patientsWithoutMember} 个病人没有任何成员，谁也看不到`, to: '/patients' })
  }
  if (s.usersWithoutPatient) {
    list.push({ text: `${s.usersWithoutPatient} 个用户还没有绑定病人`, to: '/users' })
  }
  if (s.missingProfile) {
    list.push({ text: `${s.missingProfile} 个账号缺少资料行（历史数据），用户列表里标记为「缺资料」`, to: '/users' })
  }
  return list
})
</script>

<template>
  <div>
    <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

    <div class="page-toolbar">
      <span class="muted">数据实时统计，点击右上角可刷新</span>
      <div class="spacer" />
      <el-button :loading="loading" @click="load">刷新</el-button>
      <el-button type="primary" @click="router.push('/users')">用户管理</el-button>
    </div>

    <div v-loading="loading" class="stat-grid">
      <div v-for="c in cards" :key="c.label" class="stat-card">
        <div class="stat-label">{{ c.label }}</div>
        <div class="stat-value">{{ c.value }}</div>
      </div>
    </div>

    <el-card v-if="warnings.length" class="page-card" style="margin-top: 16px" shadow="never">
      <template #header>需要关注</template>
      <div v-for="w in warnings" :key="w.text" style="padding: 4px 0">
        <span style="color: #e6a23c; margin-right: 6px">⚠</span>
        <el-link type="warning" underline="never" @click="router.push(w.to)">{{ w.text }}</el-link>
      </div>
    </el-card>

    <el-card class="page-card" style="margin-top: 16px" shadow="never">
      <template #header>说明</template>
      <div class="muted" style="line-height: 1.9">
        · 后台只管理「账号、成员关系、病人基础配置」，<b>看不到任何透析记录明细</b>（血压、血糖、脱水量等），这是数据库层面的限制。<br />
        · 这里只显示记录条数与最近记录日期，用于判断账号是否在用。<br />
        · 所有管理动作都会写入「操作日志」，可随时追溯。
      </div>
    </el-card>
  </div>
</template>
