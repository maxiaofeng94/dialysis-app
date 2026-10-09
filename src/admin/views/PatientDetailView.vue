<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, messageOf } from '../lib/api'
import {
  fmtDate,
  fmtDateTime,
  maskName,
  roleLabel,
  roleTagType,
  ROLE_OPTIONS,
  sinceText,
} from '../lib/format'
import type { PatientDetail } from '../lib/types'

const route = useRoute()
const router = useRouter()
const patientId = computed(() => String(route.params.id ?? ''))

const loading = ref(true)
const busy = ref(false)
const error = ref('')
const detail = ref<PatientDetail | null>(null)

const form = reactive({
  name: '',
  birthday: '',
  wheelchairWeight: 0,
  rinseBackVolume: 300,
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    detail.value = await api.patient(patientId.value)
    const p = detail.value.patient
    form.name = p.name
    form.birthday = p.birthday || ''
    form.wheelchairWeight = p.wheelchairWeight
    form.rinseBackVolume = p.rinseBackVolume
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function savePatient() {
  if (!form.name.trim()) {
    ElMessage.warning('病人姓名不能为空')
    return
  }
  busy.value = true
  try {
    await api.updatePatient(patientId.value, {
      name: form.name.trim(),
      birthday: form.birthday || '',
      wheelchairWeight: Number(form.wheelchairWeight) || 0,
      rinseBackVolume: Number(form.rinseBackVolume) || 0,
    })
    ElMessage.success('病人配置已保存')
    await load()
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}

// ---- 添加成员 ----
const addShow = ref(false)
const addPhone = ref('')
const addRole = ref('caregiver')

function openAdd() {
  addPhone.value = ''
  addRole.value = 'caregiver'
  addShow.value = true
}

async function doAddMember() {
  if (!/^1[3-9]\d{9}$/.test(addPhone.value)) {
    ElMessage.warning('请输入正确的手机号')
    return
  }
  busy.value = true
  try {
    await api.addMember(patientId.value, addPhone.value, addRole.value)
    ElMessage.success('已添加成员')
    addShow.value = false
    await load()
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}

// ---- 成员操作 ----
async function changeRole(userId: string, role: string) {
  // 下拉里不含「创建者」：转移创建者只能走「设为创建者」（有确认，服务端会降级原创建者），
  // 否则一个病人会出现两个 owner，「唯一创建者」的保护全部失效。
  if (role === 'owner') return
  busy.value = true
  try {
    await api.setMemberRole(patientId.value, userId, role)
    ElMessage.success('角色已更新')
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    // 失败时下拉还停在没生效的新值上，用服务端真值回填
    await load()
    busy.value = false
  }
}

async function removeMember(userId: string, label: string) {
  try {
    await ElMessageBox.confirm(`确定把「${label}」从该病人的成员中移除？`, '移除成员', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      autofocus: false,
    })
  } catch {
    return
  }
  busy.value = true
  try {
    await api.removeMember(patientId.value, userId)
    ElMessage.success('已移除成员')
    await load()
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}

async function makeOwner(userId: string, label: string) {
  try {
    await ElMessageBox.confirm(
      `将把「${label}」设为该病人的创建者；若原创建者只有一个，会降为「家属/护工」。确定？`,
      '转移创建者',
      { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消', autofocus: false },
    )
  } catch {
    return
  }
  busy.value = true
  try {
    await api.transferOwner(patientId.value, userId)
    ElMessage.success('已转移创建者')
    await load()
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}

// ---- 删除病人 ----
const delShow = ref(false)
const delConfirm = ref('')

function openDelete() {
  delConfirm.value = ''
  delShow.value = true
}

async function doDeletePatient() {
  busy.value = true
  try {
    const res = await api.deletePatient(patientId.value, delConfirm.value.trim())
    ElMessage.success(`病人已删除（连同 ${res.removedSessions} 条记录）`)
    void router.replace('/patients')
  } catch (err) {
    ElMessage.error(messageOf(err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-loading="loading">
    <el-alert v-if="error" type="error" :closable="false" :title="error" style="margin-bottom: 12px" />

    <div class="page-toolbar">
      <el-button link type="primary" @click="router.push('/patients')">← 返回病人列表</el-button>
      <div class="spacer" />
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-card v-if="detail" class="page-card" shadow="never">
      <template #header>基础配置</template>
      <el-form label-width="110px" style="max-width: 520px">
        <el-form-item label="病人姓名">
          <el-input v-model="form.name" maxlength="30" />
        </el-form-item>
        <el-form-item label="出生日期">
          <el-date-picker v-model="form.birthday" type="date" value-format="YYYY-MM-DD" placeholder="可不填" style="width: 100%" />
        </el-form-item>
        <el-form-item label="轮椅重量(g)">
          <el-input-number v-model="form.wheelchairWeight" :min="0" :max="100000" :step="500" style="width: 100%" />
        </el-form-item>
        <el-form-item label="回水量(ml)">
          <el-input-number v-model="form.rinseBackVolume" :min="0" :max="5000" :step="50" style="width: 100%" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="busy" @click="savePatient">保存配置</el-button>
        </el-form-item>
      </el-form>
      <div class="muted" style="font-size: 12px; line-height: 1.8">
        创建时间：{{ fmtDateTime(detail.patient.createdAt) }}　最近修改：{{ fmtDateTime(detail.patient.updatedAt) }}<br />
        干体重等临床参数不在此维护（后台不开放病历数据）。
      </div>
    </el-card>

    <el-card v-if="detail" class="page-card" shadow="never">
      <template #header>
        <div style="display: flex; align-items: center">
          <span>成员（{{ detail.members.length }}）</span>
          <div class="spacer" />
          <el-button type="primary" size="small" @click="openAdd">＋ 添加成员</el-button>
        </div>
      </template>
      <el-table :data="detail.members" border stripe style="width: 100%">
        <el-table-column label="姓名" width="150">
          <template #default="{ row }">{{ row.name || '未设置' }}</template>
        </el-table-column>
        <el-table-column label="手机号" width="140">
          <template #default="{ row }">
            <span class="mono">{{ row.phone || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="130">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" size="small">{{ roleLabel(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="加入时间" width="170">
          <template #default="{ row }">{{ fmtDateTime(row.joinedAt) }}</template>
        </el-table-column>
        <el-table-column label="改角色" width="150">
          <template #default="{ row }">
            <!-- 下拉里没有「创建者」：否则一点就静默多出一个 owner。
                 创建者行不给下拉（Element Plus 对没有匹配选项的值会直接显示 'owner'），
                 转移创建者走带确认的「设为创建者」。 -->
            <el-select
              v-if="row.role !== 'owner'"
              :model-value="row.role"
              size="small"
              style="width: 130px"
              :disabled="busy"
              @change="changeRole(row.userId, String($event))"
            >
              <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
            <span v-else class="muted" style="font-size: 12px">创建者（用「设为创建者」转移）</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.role !== 'owner'"
              link
              type="primary"
              :disabled="busy"
              @click="makeOwner(row.userId, row.name || row.phone || '该成员')"
            >
              设为创建者
            </el-button>
            <el-button
              link
              type="danger"
              :disabled="busy"
              @click="removeMember(row.userId, row.name || row.phone || '该成员')"
            >
              移除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="muted" style="padding: 16px">该病人还没有任何成员（无人能看到它）</div>
        </template>
      </el-table>
      <div class="muted" style="margin-top: 8px; font-size: 12px">
        提示：成员必须先用手机号注册过（或用用户管理里的「代建账号」创建），才能被添加。
      </div>
    </el-card>

    <el-card v-if="detail" class="page-card" shadow="never">
      <template #header>记录概览（不含病历明细）</template>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">记录条数</span><span>{{ detail.stats.sessionCount }}</span></div>
        <div class="detail-item"><span class="detail-label">首次记录</span><span>{{ fmtDate(detail.stats.firstSessionDate) }}</span></div>
        <div class="detail-item"><span class="detail-label">最近记录</span><span>{{ sinceText(detail.stats.lastSessionDate) }}</span></div>
      </div>
    </el-card>

    <el-card v-if="detail" class="page-card" shadow="never">
      <template #header>危险操作</template>
      <el-button type="danger" plain @click="openDelete">删除该病人及其全部数据</el-button>
      <div class="muted" style="margin-top: 8px; font-size: 12px">
        删除会级联清除该病人的透析记录、血压、血糖、血流量、不良反应、干体重与成员关系，不可恢复。
      </div>
    </el-card>

    <!-- 添加成员 -->
    <el-dialog v-model="addShow" title="添加成员" width="460px">
      <el-form label-width="80px">
        <el-form-item label="手机号">
          <el-input v-model="addPhone" maxlength="11" placeholder="对方注册时使用的手机号" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="addRole" style="width: 100%">
            <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="muted" style="font-size: 12px">
        「创建者」角色请用成员列表里的「设为创建者」按钮转移，避免一个病人出现多个创建者。
      </div>
      <template #footer>
        <el-button @click="addShow = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="doAddMember">添加</el-button>
      </template>
    </el-dialog>

    <!-- 删除病人 -->
    <el-dialog v-model="delShow" title="删除病人" width="480px" :close-on-click-modal="false" :close-on-press-escape="false">
      <el-alert
        type="error"
        :closable="false"
        title="该操作不可恢复"
        description="将删除该病人及其全部透析记录、血压、血糖、血流量、不良反应、干体重与成员关系。"
        style="margin-bottom: 14px"
      />
      <div class="muted" style="margin-bottom: 6px">
        请输入病人姓名以确认（此处打码显示）：{{ maskName(detail?.patient.name) }}
      </div>
      <el-input v-model="delConfirm" placeholder="完整姓名" />
      <template #footer>
        <el-button @click="delShow = false">取消</el-button>
        <el-button type="danger" :loading="busy" @click="doDeletePatient">确认删除</el-button>
      </template>
    </el-dialog>
  </div>
</template>
