<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
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

/**
 * 请求序号：连点下一页/快速改搜索词时，先发的请求可能后到。
 * 只有「最后一次发出的请求」才允许写 rows/total，否则表格会和分页器/搜索词对不上。
 */
let reqSeq = 0

async function load() {
  const seq = ++reqSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.users({ search: search.value.trim(), page: page.value, size: size.value, sort: sort.value, order: order.value })
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

// ---- 代建账号（帮不会注册的人建号；建完就能被加进病人成员） ----
const createShow = ref(false)
const createPhone = ref('')
const createPassword = ref('')
const createName = ref('')
const createError = ref('')
const creating = ref(false)

function openCreate() {
  createPhone.value = ''
  createPassword.value = ''
  createName.value = ''
  createError.value = ''
  createShow.value = true
}

async function doCreateUser() {
  createError.value = ''
  if (!/^1[3-9]\d{9}$/.test(createPhone.value.trim())) {
    createError.value = '请输入正确的手机号'
    return
  }
  if (createPassword.value.length < 6) {
    createError.value = '密码至少 6 位'
    return
  }
  if (createName.value.trim().length > 30) {
    createError.value = '姓名最长 30 个字'
    return
  }
  creating.value = true
  try {
    await api.createUser(createPhone.value.trim(), createPassword.value, createName.value.trim())
    ElMessage.success('账号已创建，请把手机号与密码线下告知本人')
    createShow.value = false
    page.value = 1 // 新账号在默认排序下排在第一页，回到第 1 页才看得到
    await load()
  } catch (err) {
    // 服务端会校验手机号格式 / 密码长度 / 是否已注册，错误就地显示在弹窗里
    createError.value = messageOf(err)
  } finally {
    creating.value = false
  }
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
      <el-button type="primary" plain @click="openCreate">代建账号</el-button>
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

    <!-- 代建账号 -->
    <el-dialog v-model="createShow" title="代建账号" width="440px">
      <el-alert
        v-if="createError"
        type="error"
        :closable="false"
        :title="createError"
        style="margin-bottom: 12px"
      />
      <el-form label-width="70px" @submit.prevent>
        <el-form-item label="手机号">
          <el-input v-model="createPhone" maxlength="11" placeholder="11 位手机号（对方登录用）" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="createPassword" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="createName" maxlength="30" placeholder="可留空，之后可改" />
        </el-form-item>
      </el-form>
      <div class="muted" style="font-size: 12px; line-height: 1.8">
        适合帮不会注册的人建号：建好后对方用手机号 + 密码登录 App，你就能把他加进病人成员。<br />
        新密码请线下告知本人，后台没有找回密码入口。
      </div>
      <template #footer>
        <el-button @click="createShow = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="doCreateUser">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>
