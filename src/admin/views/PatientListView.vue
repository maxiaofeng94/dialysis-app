<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, messageOf } from '../lib/api'
import { fmtDate, roleLabel, roleTagType, sinceText } from '../lib/format'
import type { PatientRow } from '../lib/types'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const rows = ref<PatientRow[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(20)
const search = ref('')

/** 请求序号：连点下一页/快速改搜索词时先发的请求可能后到，只认最后一次的结果 */
let reqSeq = 0

async function load() {
  const seq = ++reqSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.patients({ search: search.value.trim(), page: page.value, size: size.value })
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

function onSearch() {
  page.value = 1
  void load()
}

function onPageChange(p: number) {
  page.value = p
  void load()
}
</script>

<template>
  <div>
    <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

    <div class="page-toolbar">
      <el-input
        v-model="search"
        placeholder="搜索病人姓名"
        clearable
        style="width: 220px"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-button type="primary" @click="onSearch">查询</el-button>
      <div class="spacer" />
      <span class="muted">共 {{ total }} 个病人</span>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe style="width: 100%">
      <el-table-column label="姓名" width="130">
        <template #default="{ row }">
          <el-link type="primary" underline="never" @click="router.push(`/patients/${row.id}`)">
            {{ row.name }}
          </el-link>
        </template>
      </el-table-column>
      <el-table-column label="创建者" min-width="140">
        <template #default="{ row }">
          <span v-if="!row.owners.length" class="muted" style="color: #f56c6c">无创建者</span>
          <span v-else>{{ row.owners.join('、') }}</span>
        </template>
      </el-table-column>
      <el-table-column label="成员" width="200">
        <template #default="{ row }">
          <el-tag
            v-for="m in row.members"
            :key="m.userId"
            :type="roleTagType(m.role)"
            size="small"
            style="margin: 2px 4px 2px 0"
          >
            {{ m.name || m.phone || '未命名' }} · {{ roleLabel(m.role) }}
          </el-tag>
          <span v-if="!row.members.length" class="muted">无</span>
        </template>
      </el-table-column>
      <el-table-column label="记录数" width="90" align="center">
        <template #default="{ row }">{{ row.sessionCount }}</template>
      </el-table-column>
      <el-table-column label="最近记录" width="130">
        <template #default="{ row }">
          <span :class="{ muted: !row.lastSessionDate }">{{ sinceText(row.lastSessionDate) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="首次记录" width="120">
        <template #default="{ row }">{{ fmtDate(row.firstSessionDate) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="router.push(`/patients/${row.id}`)">详情</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div class="muted" style="padding: 20px">没有符合条件的病人</div>
      </template>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      v-model:page-size="size"
      :total="total"
      :page-sizes="[20, 50, 100]"
      layout="total, sizes, prev, pager, next"
      style="margin-top: 12px; justify-content: flex-end"
      @current-change="onPageChange"
      @size-change="onSearch"
    />
  </div>
</template>
