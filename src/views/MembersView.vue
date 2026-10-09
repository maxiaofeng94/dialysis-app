<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { listMembers, inviteMember, setMemberRole, removeMember, type MemberInfo } from '../lib/cloudAdmin'
import { currentPatientId, currentRole, refreshCurrentRole } from '../stores/patient'
import { cacheVersion } from '../lib/cloudCache'
import { useAuth } from '../stores/auth'

const router = useRouter()
const { isLoggedIn } = useAuth()
const members = ref<MemberInfo[]>([])
const showInvite = ref(false)
const invitePhone = ref('')
const inviteRole = ref('caregiver')
const inviteBusy = ref(false)

const ROLE_LABELS: Record<string, string> = {
  owner: '创建者',
  caregiver: '家属/护工',
  doctor: '医生',
  viewer: '只读',
}

/**
 * 我是不是这个病人的创建者（owner）。
 * 服务端只允许 owner 邀请/改角色/移除成员，caregiver 点这些入口只会「看着成功其实没生效」。
 * 角色未知（本地模式、还没拉回来）时不限制，避免把真正的 owner 锁在门外。
 */
const canManage = computed(() => currentRole.value === null || currentRole.value === 'owner')

/** 首次加载（本机还没有缓存）时的骨架占位 */
const loading = ref(true)

onMounted(async () => {
  await load()
  if (isLoggedIn.value) await refreshCurrentRole()
})

// 缓存后台刷新完成后自动重读
watch(cacheVersion, () => {
  void load()
})

// 被踢下线 / 令牌失效：repository 会切回本地仓储，页面只会显示「暂无成员」，必须明确提示并回登录页
watch(isLoggedIn, (val, old) => {
  if (old && !val) {
    showToast('登录状态已失效，请重新登录')
    void router.replace('/login')
  }
})

async function load() {
  try {
    members.value = await listMembers(currentPatientId.value)
  } catch (err) {
    console.error(err)
    showToast('成员列表加载失败，请检查网络后重试')
  } finally {
    loading.value = false // 任何情况下都要收掉骨架，否则页面永久白等
  }
}

/** 关闭邀请弹窗（取消/成功后都走这里，避免手机号残留到下一次邀请） */
function closeInvite() {
  showInvite.value = false
  invitePhone.value = ''
  inviteRole.value = 'caregiver'
}

async function onInvite() {
  if (!canManage.value) {
    showToast('仅创建者可邀请成员')
    return
  }
  if (!/^1[3-9]\d{9}$/.test(invitePhone.value)) {
    showToast('请输入正确的手机号')
    return
  }
  if (inviteBusy.value) return // 防连点：重复提交会重复发邀请
  inviteBusy.value = true
  try {
    const res = await inviteMember(currentPatientId.value, invitePhone.value, inviteRole.value)
    if (res.ok) {
      showToast('邀请成功')
      closeInvite()
      await load()
    } else {
      showToast(res.error ?? '邀请失败')
    }
  } catch (err) {
    console.error(err)
    showToast('邀请失败，请检查网络后重试')
  } finally {
    inviteBusy.value = false
  }
}

const roleSheetShow = ref(false)
const roleTarget = ref<MemberInfo | null>(null)
const roleActions = [
  { name: '家属/护工', value: 'caregiver' },
  { name: '医生（只读）', value: 'doctor' },
  { name: '只读', value: 'viewer' },
]

function onChangeRole(m: MemberInfo) {
  if (!canManage.value) {
    showToast('仅创建者可修改成员角色')
    return
  }
  roleTarget.value = m
  roleSheetShow.value = true
}

async function onRoleSelect(action: { name: string; value: string }) {
  roleSheetShow.value = false
  const m = roleTarget.value
  if (!m || !action.value || action.value === m.role) return
  if (!canManage.value) {
    showToast('仅创建者可修改成员角色')
    return
  }
  try {
    const res = await setMemberRole(currentPatientId.value, m.userId, action.value)
    if (res.ok) {
      showToast('角色已更新')
      await load()
    } else {
      showToast(res.error ?? '更新失败')
    }
  } catch (err) {
    console.error(err)
    showToast('更新失败，请检查网络后重试')
  }
}

async function onRemove(m: MemberInfo) {
  if (!canManage.value) {
    showToast('仅创建者可移除成员')
    return
  }
  try {
    await showConfirmDialog({ title: '移除成员', message: `移除 ${m.name || m.phone || '该成员'}？` })
  } catch {
    return
  }
  try {
    const res = await removeMember(currentPatientId.value, m.userId)
    if (res.ok) {
      showToast('已移除')
      await load()
    } else {
      showToast(res.error ?? '移除失败')
    }
  } catch (err) {
    console.error(err)
    showToast('移除失败，请检查网络后重试')
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="成员管理" left-text="返回" left-arrow @click-left="router.back()" />

    <!-- 首次加载（本机还没有缓存）时显示骨架，避免白屏干等 -->
    <div v-if="loading" class="card" style="margin-top: 12px">
      <van-skeleton title :row="4" />
    </div>

    <template v-if="!loading">
    <div class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">成员列表</div>
        <van-button v-if="canManage" size="small" type="primary" plain @click="showInvite = true">＋ 邀请</van-button>
      </div>
      <div v-if="!members.length" class="muted" style="padding: 12px 0">暂无成员</div>
      <div v-for="m in members" :key="m.userId" class="row" style="padding: 10px 0; border-top: 1px solid #f2f3f5">
        <div>
          <div class="num">{{ m.name || m.phone || '未命名' }}</div>
          <div class="muted">{{ m.phone || '' }}</div>
        </div>
        <div class="row" style="gap: 10px">
          <van-tag :type="m.role === 'owner' ? 'success' : 'primary'">{{ ROLE_LABELS[m.role] ?? m.role }}</van-tag>
          <template v-if="m.role !== 'owner' && canManage">
            <van-icon name="edit" color="#1989fa" style="cursor: pointer" @click="onChangeRole(m)" />
            <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="onRemove(m)" />
          </template>
        </div>
      </div>
      <div v-if="canManage" class="muted" style="margin-top: 8px">提示：仅「创建者」可管理成员与邀请；对方需先用手机号注册登录一次。</div>
      <div v-else class="muted" style="margin-top: 8px">
        仅创建者可管理成员与邀请，你当前是「{{ ROLE_LABELS[currentRole ?? ''] ?? currentRole }}」，只能查看。
      </div>
    </div>

    <van-action-sheet v-model:show="roleSheetShow" :actions="roleActions" cancel-text="取消" @select="onRoleSelect" />

    <van-popup v-model:show="showInvite" round position="bottom" @closed="closeInvite">
      <div style="padding: 20px">
        <div class="card-title">邀请成员</div>
        <van-field v-model="invitePhone" label="手机号" type="tel" maxlength="11" placeholder="对方需已注册" />
        <div style="padding: 12px 16px">
          <div class="muted" style="margin-bottom: 8px">角色</div>
          <van-radio-group v-model="inviteRole" direction="horizontal">
            <van-radio name="caregiver">家属/护工</van-radio>
            <van-radio name="doctor">医生</van-radio>
            <van-radio name="viewer">只读</van-radio>
          </van-radio-group>
        </div>
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block :disabled="inviteBusy" @click="closeInvite">取消</van-button>
          <van-button block type="primary" :loading="inviteBusy" :disabled="inviteBusy" @click="onInvite">邀请</van-button>
        </div>
      </div>
    </van-popup>
    </template>
  </div>
</template>
