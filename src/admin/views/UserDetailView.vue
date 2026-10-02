<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, messageOf } from '../lib/api'
import { fmtDateTime, roleLabel, roleTagType, ROLE_OPTIONS_WITH_OWNER, sinceText } from '../lib/format'
import { me } from '../lib/auth'
import type { UserDetail } from '../lib/types'

const route = useRoute()
const router = useRouter()
const userId = computed(() => String(route.params.id ?? ''))

const loading = ref(true)
const busy = ref(false)
const error = ref('')
const detail = ref<UserDetail | null>(null)

const user = computed(() => detail.value?.user ?? null)
const isSelf = computed(() => me.value?.userId === userId.value)

async function load() {
  loading.value = true
  error.value = ''
  try {
    detail.value = await api.user(userId.value)
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 统一的「执行 → 提示 → 刷新」包装 */
async function run(task: () => Promise<unknown>, successText: string) {
  busy.value = true
  try {
    await task()
    ElMessage.success(successText)
    await load()
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}

// ---- 修改姓名 ----
const renameShow = ref(false)
const renameValue = ref('')

function openRename() {
  renameValue.value = user.value?.name ?? ''
  renameShow.value = true
}

async function doRename() {
  const name = renameValue.value.trim()
  if (!name) {
    ElMessage.warning('姓名不能为空')
    return
  }
  await run(async () => {
    await api.renameUser(userId.value, name)
    renameShow.value = false
  }, '姓名已更新')
}

// ---- 重置密码 ----
const pwdShow = ref(false)
const pwdInput = ref('')
const pwdResult = ref('')

function openResetPassword() {
  pwdInput.value = ''
  pwdResult.value = ''
  pwdShow.value = true
}

async function doResetPassword() {
  busy.value = true
  try {
    const res = await api.resetPassword(userId.value, pwdInput.value.trim() || undefined)
    pwdResult.value = res.password
    ElMessage.success('密码已重置')
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}

async function copyPassword() {
  try {
    await navigator.clipboard.writeText(pwdResult.value)
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败，请手动选中复制')
  }
}

// ---- 禁用 / 解禁 ----
async function toggleBan() {
  const u = user.value
  if (!u) return
  const next = !u.banned
  try {
    await ElMessageBox.confirm(
      next
        ? '禁用后该账号将无法登录（已签发的登录凭证最长 1 小时后失效）。确定禁用？'
        : '确定恢复该账号的登录？',
      next ? '禁用账号' : '解禁账号',
      { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await run(() => api.setBanned(userId.value, next), next ? '已禁用该账号' : '已解禁该账号')
}

// ---- 授予 / 撤销管理员 ----
async function toggleAdmin() {
  const u = user.value
  if (!u) return
  const next = !u.isAdmin
  try {
    await ElMessageBox.confirm(
      next
        ? '授予后该账号可以进入后台，管理所有用户与病人配置。确定授予？'
        : '撤销后该账号将无法进入后台。确定撤销？',
      next ? '授予管理员' : '撤销管理员',
      { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await run(async () => {
    if (next) await api.grantAdmin(userId.value)
    else await api.revokeAdmin(userId.value)
  }, next ? '已授予管理员' : '已撤销管理员')
}

// ---- 删除用户 ----
const delShow = ref(false)
const delMode = ref<'detach' | 'purge'>('detach')
const delConfirm = ref('')

function openDelete() {
  delMode.value = 'detach'
  delConfirm.value = ''
  delShow.value = true
}

async function doDelete() {
  busy.value = true
  try {
    const res = await api.deleteUser(userId.value, delMode.value, delConfirm.value.trim())
    delShow.value = false
    ElMessage.success(
      res.deletedPatients?.length ? `用户已删除，同时删除了病人：${res.deletedPatients.join('、')}` : '用户已删除',
    )
    void router.replace('/users')
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}

// ---- 名下病人的成员操作 ----
async function changeRole(patientId: string, uid: string, role: string) {
  await run(() => api.setMemberRole(patientId, uid, role), '角色已更新')
}

async function removeMembership(patientId: string, uid: string, label: string) {
  try {
    await ElMessageBox.confirm(`确定把「${label}」从该病人的成员中移除？`, '移除成员', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await run(() => api.removeMember(patientId, uid), '已移除成员')
}

async function makeOwner(patientId: string, uid: string) {
  try {
    await ElMessageBox.confirm(
      '将把该用户设为该病人的创建者；若原创建者只有一个，会降为「家属/护工」。确定？',
      '转移创建者',
      { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await run(() => api.transferOwner(patientId, uid), '已转移创建者')
}
</script>

<template>
  <div v-loading="loading">
    <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

    <div class="page-toolbar">
      <el-button link type="primary" @click="router.push('/users')">← 返回用户列表</el-button>
      <div class="spacer" />
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-card v-if="user" class="page-card" shadow="never">
      <template #header>
        <div style="display: flex; align-items: center; gap: 8px">
          <span>账号信息</span>
          <el-tag v-if="user.banned" type="danger" size="small">已禁用</el-tag>
          <el-tag v-else type="success" size="small">正常</el-tag>
          <el-tag v-if="user.isAdmin" type="warning" size="small">管理员</el-tag>
          <el-tag v-if="user.profileMissing" type="info" size="small">缺资料行</el-tag>
          <el-tag v-if="isSelf" type="primary" size="small">这是你自己</el-tag>
        </div>
      </template>

      <el-descriptions :column="3" border>
        <el-descriptions-item label="手机号">
          <span class="mono">{{ user.phone || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="姓名">{{ user.name || '未设置' }}</el-descriptions-item>
        <el-descriptions-item label="注册时间">{{ fmtDateTime(user.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="最后登录">
          {{ sinceText(user.lastSignInAt) }}
          <span class="muted" style="font-size: 12px">（{{ fmtDateTime(user.lastSignInAt) }}）</span>
        </el-descriptions-item>
        <el-descriptions-item label="病人数">{{ detail?.patients.length ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="用户 ID">
          <span class="mono" style="font-size: 12px">{{ user.id }}</span>
        </el-descriptions-item>
      </el-descriptions>

      <div class="actions-cell" style="margin-top: 16px">
        <el-button :disabled="busy" @click="openRename">修改姓名</el-button>
        <el-button :disabled="busy" @click="openResetPassword">重置密码</el-button>
        <el-button v-if="!isSelf" :disabled="busy" :type="user.banned ? 'success' : 'warning'" plain @click="toggleBan">
          {{ user.banned ? '解禁账号' : '禁用账号' }}
        </el-button>
        <el-button
          v-if="!isSelf"
          :disabled="busy"
          :type="user.isAdmin ? 'info' : 'primary'"
          plain
          @click="toggleAdmin"
        >
          {{ user.isAdmin ? '撤销管理员' : '授予管理员' }}
        </el-button>
        <el-button v-if="!isSelf" :disabled="busy" type="danger" plain @click="openDelete">删除用户</el-button>
      </div>
      <div v-if="isSelf" class="muted" style="margin-top: 8px; font-size: 12px">
        为了保护你自己，禁用、撤销管理员、删除等操作不能对自己执行。
      </div>
    </el-card>

    <el-card class="page-card" shadow="never">
      <template #header>名下病人</template>
      <el-table :data="detail?.patients ?? []" border stripe style="width: 100%">
        <el-table-column label="病人" min-width="130">
          <template #default="{ row }">
            <el-link type="primary" :underline="false" @click="router.push(`/patients/${row.patientId}`)">
              {{ row.patientName }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="160">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="加入时间" width="160">
          <template #default="{ row }">{{ fmtDateTime(row.joinedAt) }}</template>
        </el-table-column>
        <el-table-column label="记录数" width="90" align="center">
          <template #default="{ row }">{{ row.sessionCount }}</template>
        </el-table-column>
        <el-table-column label="最近记录" width="120">
          <template #default="{ row }">
            <span :class="{ muted: !row.lastSessionDate }">{{ sinceText(row.lastSessionDate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="改角色" width="150">
          <template #default="{ row }">
            <el-select
              :model-value="row.role"
              size="small"
              style="width: 130px"
              :disabled="busy"
              @change="changeRole(row.patientId, row.userId, String($event))"
            >
              <el-option v-for="o in ROLE_OPTIONS_WITH_OWNER" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.role !== 'owner'"
              link
              type="primary"
              :disabled="busy"
              @click="makeOwner(row.patientId, row.userId)"
            >
              设为创建者
            </el-button>
            <el-button link type="danger" :disabled="busy" @click="removeMembership(row.patientId, row.userId, row.patientName)">
              移除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="muted" style="padding: 16px">该用户还不是任何病人的成员</div>
        </template>
      </el-table>
      <div class="muted" style="margin-top: 8px; font-size: 12px">
        提示：删除该用户不会自动删除他创建的病人；若他是某病人唯一的创建者，删除前需要先转移创建者。
      </div>
    </el-card>

    <!-- 修改姓名 -->
    <el-dialog v-model="renameShow" title="修改姓名" width="420px">
      <el-input v-model="renameValue" maxlength="30" show-word-limit placeholder="姓名（记录人会显示这个名字）" />
      <template #footer>
        <el-button @click="renameShow = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="doRename">保存</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="pwdShow" title="重置密码" width="460px">
      <template v-if="!pwdResult">
        <el-input v-model="pwdInput" placeholder="留空则自动生成随机密码（至少 6 位）" show-password />
        <div class="muted" style="margin-top: 8px; font-size: 12px">
          重置后请把新密码线下告知本人；对方在 App 上用手机号 + 新密码登录。
        </div>
      </template>
      <template v-else>
        <el-alert type="success" :closable="false" title="密码已重置，请立即复制并告知本人（只显示这一次）" />
        <div class="mono" style="font-size: 20px; margin: 14px 0; text-align: center; letter-spacing: 1px">
          {{ pwdResult }}
        </div>
      </template>
      <template #footer>
        <el-button @click="pwdShow = false">关闭</el-button>
        <el-button v-if="!pwdResult" type="primary" :loading="busy" @click="doResetPassword">重置</el-button>
        <el-button v-else type="primary" @click="copyPassword">复制密码</el-button>
      </template>
    </el-dialog>

    <!-- 删除用户 -->
    <el-dialog v-model="delShow" title="删除用户" width="520px">
      <el-alert
        type="error"
        :closable="false"
        title="删除后该账号无法登录，且不可恢复"
        description="该用户作为成员的关系会被一并删除；他创建的病人不会自动删除（可选「连同病人数据一并删除」）。"
        style="margin-bottom: 14px"
      />
      <el-radio-group v-model="delMode" style="display: flex; flex-direction: column; gap: 8px">
        <el-radio value="detach">仅删除账号，保留病人数据（病人若失去创建者会变成无人可见）</el-radio>
        <el-radio value="purge">连同他创建的病人及其全部记录一并删除</el-radio>
      </el-radio-group>
      <div style="margin-top: 14px">
        <div class="muted" style="margin-bottom: 6px">
          请输入该用户的完整手机号以确认：<span class="mono">{{ user?.phone || '（无手机号，无法删除）' }}</span>
        </div>
        <el-input v-model="delConfirm" placeholder="完整手机号" :disabled="!user?.phone" />
      </div>
      <template #footer>
        <el-button @click="delShow = false">取消</el-button>
        <el-button type="danger" :loading="busy" :disabled="!user?.phone" @click="doDelete">确认删除</el-button>
      </template>
    </el-dialog>
  </div>
</template>
