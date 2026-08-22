<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { listMembers, inviteMember, setMemberRole, removeMember, type MemberInfo } from '../lib/cloudAdmin'
import { currentPatientId } from '../stores/patient'

const router = useRouter()
const members = ref<MemberInfo[]>([])
const showInvite = ref(false)
const invitePhone = ref('')
const inviteRole = ref('caregiver')

const ROLE_LABELS: Record<string, string> = {
  owner: '主人',
  caregiver: '家属/护工',
  doctor: '医生',
  viewer: '只读',
}

onMounted(load)

async function load() {
  members.value = await listMembers(currentPatientId.value)
}

async function onInvite() {
  if (!/^1[3-9]\d{9}$/.test(invitePhone.value)) {
    showToast('请输入正确的手机号')
    return
  }
  const res = await inviteMember(currentPatientId.value, invitePhone.value, inviteRole.value)
  if (res.ok) {
    showToast('邀请成功')
    showInvite.value = false
    invitePhone.value = ''
    await load()
  } else {
    showToast(res.error ?? '邀请失败')
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
  roleTarget.value = m
  roleSheetShow.value = true
}

async function onRoleSelect(action: { name: string; value: string }) {
  roleSheetShow.value = false
  const m = roleTarget.value
  if (!m || !action.value || action.value === m.role) return
  const res = await setMemberRole(currentPatientId.value, m.userId, action.value)
  if (res.ok) {
    showToast('角色已更新')
    await load()
  } else {
    showToast(res.error ?? '更新失败')
  }
}

async function onRemove(m: MemberInfo) {
  try {
    await showConfirmDialog({ title: '移除成员', message: `移除 ${m.name || m.phone || '该成员'}？` })
  } catch {
    return
  }
  const res = await removeMember(currentPatientId.value, m.userId)
  if (res.ok) {
    showToast('已移除')
    await load()
  } else {
    showToast(res.error ?? '移除失败')
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="成员管理" left-text="返回" left-arrow @click-left="router.back()" />

    <div class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">成员列表</div>
        <van-button size="small" type="primary" plain @click="showInvite = true">＋ 邀请</van-button>
      </div>
      <div v-if="!members.length" class="muted" style="padding: 12px 0">暂无成员</div>
      <div v-for="m in members" :key="m.userId" class="row" style="padding: 10px 0; border-top: 1px solid #f2f3f5">
        <div>
          <div class="num">{{ m.name || m.phone || '未命名' }}</div>
          <div class="muted">{{ m.phone || '' }}</div>
        </div>
        <div class="row" style="gap: 10px">
          <van-tag :type="m.role === 'owner' ? 'success' : 'primary'">{{ ROLE_LABELS[m.role] ?? m.role }}</van-tag>
          <template v-if="m.role !== 'owner'">
            <van-icon name="edit" color="#1989fa" style="cursor: pointer" @click="onChangeRole(m)" />
            <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="onRemove(m)" />
          </template>
        </div>
      </div>
      <div class="muted" style="margin-top: 8px">提示：仅「主人」可管理成员与邀请；对方需先用手机号注册登录一次。</div>
    </div>

    <van-action-sheet v-model:show="roleSheetShow" :actions="roleActions" cancel-text="取消" @select="onRoleSelect" />

    <van-popup v-model:show="showInvite" round position="bottom">
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
          <van-button block @click="showInvite = false">取消</van-button>
          <van-button block type="primary" @click="onInvite">邀请</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>
