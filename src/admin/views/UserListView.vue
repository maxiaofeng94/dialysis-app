<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, messageOf } from '../lib/api'
import { fmtDateTime, roleLabel, roleTagType, sinceText } from '../lib/format'
import type { AdminUserRow } from '../lib/types'

const router = useRouter()
const loading = ref(true)
const error = ref('')
const rows = ref<AdminUserRow[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(20)
const search = ref('')
const sort = ref<'createdAt' | 'lastSignIn'>('createdAt')
const order = ref<'asc' | 'desc'>('desc')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.users({ search: search.value.trim(), page: page.value, size: size.value, sort: sort.value, order: order.value })
    rows.value = res.rows
    total.value = res.total
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function onSearch() {
  page.value = 1
  void load()
}

function onReset() {
  search.value = ''
  sort.value = 'createdAt'
  order.value = 'desc'
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
        placeholder="搜索手机号或姓名"
        clearable
        style="width: 220px"
        @keyup.enter="onSearch"
        @clear="onSearch"
      />
      <el-select v-model="sort" style="width: 150px" @change="onSearch">
        <el-option label="按注册时间" value="createdAt" />
        <el-option label="按最后登录" value="lastSignIn" />
      </el-select>
      <el-select v-model="order" style="width: 110px" @change="onSearch">
        <el-option label="倒序" value="desc" />
        <el-option label="正序" value="asc" />
      </el-select>
      <el-button type="primary" @click="onSearch">查询</el-button>
      <el-button @click="onReset">重置</el-button>
      <div class="spacer" />
      <span class="muted">共 {{ total }} 个用户</span>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe style="width: 100%">
      <el-table-column label="手机号" width="130">
        <template #default="{ row }">
          <span class="mono">{{ row.phone || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="姓名" width="120">
        <template #default="{ row }">{{ row.name || '未设置' }}</template>
      </el-table-column>
      <el-table-column label="注册时间" width="160">
        <template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="最后登录" width="140">
        <template #default="{ row }">
          <span :class="{ muted: !row.lastSignInAt }">{{ sinceText(row.lastSignInAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="名下病人" min-width="220">
        <template #default="{ row }">
          <span v-if="!row.roles.length" class="muted">无</span>
          <template v-else>
            <el-tag
              v-for="r in row.roles"
              :key="r.patientId"
              :type="roleTagType(r.role)"
              size="small"
              style="margin: 2px 4px 2px 0"
            >
              {{ r.patientName }} · {{ roleLabel(r.role) }}
            </el-tag>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="150">
        <template #default="{ row }">
          <el-tag v-if="row.banned" type="danger" size="small">已禁用</el-tag>
          <el-tag v-else type="success" size="small">正常</el-tag>
          <el-tag v-if="row.isAdmin" type="warning" size="small" style="margin-left: 4px">管理员</el-tag>
          <el-tag v-if="row.profileMissing" type="info" size="small" style="margin-left: 4px">缺资料</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="router.push(`/users/${row.id}`)">详情</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <div class="muted" style="padding: 20px">没有符合条件的用户</div>
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
