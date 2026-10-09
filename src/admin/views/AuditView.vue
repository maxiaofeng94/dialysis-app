<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, messageOf } from '../lib/api'
import { actionLabel, actionTagType, fmtDateTime } from '../lib/format'
import type { AuditRow } from '../lib/types'

const loading = ref(true)
const error = ref('')
const rows = ref<AuditRow[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(30)

/** 请求序号：连点翻页时先发的请求可能后到，只认最后一次的结果 */
let reqSeq = 0

async function load() {
  const seq = ++reqSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.audit({ page: page.value, size: size.value })
    if (seq !== reqSeq) return // 已被更新的请求取代，丢弃这次结果
    rows.value = res.rows
    total.value = res.total
  } catch (err) {
    if (seq !== reqSeq) return
    error.value = messageOf(err)
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

onMounted(load)

function onPageChange(p: number) {
  page.value = p
  void load()
}

/** 把 detail 里的键值对拍平成可读文本 */
function detailText(detail: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (v === null || v === undefined || v === '') continue
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  return parts.join('，') || '—'
}
</script>

<template>
  <div>
    <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

    <div class="page-toolbar">
      <span class="muted">所有后台管理动作都会记录在这里，最多保留全部历史</span>
      <div class="spacer" />
      <span class="muted">共 {{ total }} 条</span>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe style="width: 100%">
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作人" width="180">
        <template #default="{ row }">
          {{ row.adminName || row.adminPhone || (row.adminId ? row.adminId.slice(0, 8) : '—') }}
        </template>
      </el-table-column>
      <el-table-column label="动作" width="150">
        <template #default="{ row }">
          <el-tag :type="actionTagType(row.action)" size="small">{{ actionLabel(row.action) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="对象" width="140">
        <template #default="{ row }">
          <span class="mono muted">{{ row.targetType || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="变更摘要" min-width="280">
        <template #default="{ row }">
          <span class="mono" style="font-size: 12px">{{ detailText(row.detail) }}</span>
        </template>
      </el-table-column>
      <template #empty>
        <div class="muted" style="padding: 20px">暂无操作记录</div>
      </template>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="size"
      :total="total"
      layout="total, prev, pager, next"
      style="margin-top: 12px; justify-content: flex-end"
      @current-change="onPageChange"
    />
  </div>
</template>
