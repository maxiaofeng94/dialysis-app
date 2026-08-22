<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { showToast, showConfirmDialog, showDialog } from 'vant'
import { useRouter } from 'vue-router'
import { useAuth } from '../stores/auth'
import { repository } from '../repo'
import { DEFAULT_RINSE_BACK_ML } from '../constants'
import { currentPatientId } from '../stores/patient'
import { listMyPatients, createPatient } from '../lib/cloudAdmin'
import { migrateLocalToCloud } from '../lib/migrate'
import { todayStr, parseNum, fmt, formatDateCN, calcAge } from '../utils/format'
import { getEffectiveDryWeight } from '../utils/calc'
import { uuid } from '../utils/id'
import type { Patient, DryWeight } from '../types'

const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const router = useRouter()
const { isLoggedIn, logout } = useAuth()

async function onLogout() {
  await logout()
  router.replace('/login')
}

const form = reactive({
  name: '',
  birthday: '',
  wheelchairWeight: '',
  rinseBackVolume: '',
})

const dwForm = reactive({ value: '', effectiveDate: '', note: '' })
const showDwForm = ref(false)
const fileInput = ref<HTMLInputElement>()

const myPatients = ref<{ patient: Patient; role: string }[]>([])
const showNewPatient = ref(false)
const newPatientForm = reactive({ name: '', wheelchairWeight: '', rinseBackVolume: '' })

onMounted(async () => {
  await load()
  if (isLoggedIn.value) {
    myPatients.value = await listMyPatients()
  }
})

async function switchPatient(id: string) {
  currentPatientId.value = id
  showToast('已切换病人')
  await load()
}

function openNewPatient() {
  newPatientForm.name = ''
  newPatientForm.wheelchairWeight = ''
  newPatientForm.rinseBackVolume = ''
  showNewPatient.value = true
}

async function onCreatePatient() {
  if (!newPatientForm.name.trim()) {
    showToast('请填写姓名')
    return
  }
  const res = await createPatient(
    newPatientForm.name.trim(),
    parseNum(newPatientForm.wheelchairWeight) ?? 0,
    parseNum(newPatientForm.rinseBackVolume) ?? DEFAULT_RINSE_BACK_ML,
  )
  if (res.ok && res.data?.patient) {
    showNewPatient.value = false
    currentPatientId.value = res.data.patient.id
    myPatients.value = await listMyPatients()
    await load()
    showToast('已创建')
  } else {
    showToast(res.data?.error ?? '创建失败')
  }
}

async function onMigrate() {
  try {
    await showConfirmDialog({ title: '迁移数据', message: '将本机本地数据上传到云端（会在云端新建病人）？' })
  } catch {
    return
  }
  const res = await migrateLocalToCloud()
  showToast(res.message)
  if (res.ok) {
    myPatients.value = await listMyPatients()
    await load()
  }
}

function goMembers() {
  router.push('/members')
}

async function load() {
  const p = await repository.getPatient(currentPatientId.value)
  patient.value = p ?? null
  form.name = p?.name ?? ''
  form.birthday = p?.birthday ?? ''
  form.wheelchairWeight = p ? String(p.wheelchairWeight) : ''
  form.rinseBackVolume = p ? String(p.rinseBackVolume) : ''
  dryWeights.value = await repository.listDryWeights(currentPatientId.value)
}

const currentDry = computed(() => getEffectiveDryWeight(dryWeights.value, todayStr()))

function calcAgeStr(birthday: string): string {
  const a = calcAge(birthday)
  return a == null ? '—' : `${a} 岁`
}

function roleLabel(role: string): string {
  const map: Record<string, string> = { owner: '主人', caregiver: '家属/护工', doctor: '医生', viewer: '只读' }
  return map[role] ?? role
}

async function savePatient() {
  const now = Date.now()
  const p: Patient = {
    id: currentPatientId.value,
    name: form.name.trim() || '未命名',
    birthday: form.birthday,
    wheelchairWeight: parseNum(form.wheelchairWeight) ?? 0,
    rinseBackVolume: parseNum(form.rinseBackVolume) ?? DEFAULT_RINSE_BACK_ML,
    createdAt: patient.value?.createdAt ?? now,
    updatedAt: now,
  }
  await repository.savePatient(p)
  patient.value = p
  showToast('已保存')
}

function openDw() {
  dwForm.value = ''
  dwForm.effectiveDate = todayStr()
  dwForm.note = ''
  showDwForm.value = true
}

async function saveDw() {
  const v = parseNum(dwForm.value)
  if (v == null) {
    showToast('请填写干体重')
    return
  }
  const d: DryWeight = {
    id: uuid(),
    patientId: currentPatientId.value,
    value: v,
    effectiveDate: dwForm.effectiveDate || todayStr(),
    note: dwForm.note.trim() || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await repository.saveDryWeight(d)
  showDwForm.value = false
  await load()
  showToast('已添加')
}

async function removeDw(d: DryWeight) {
  try {
    await showConfirmDialog({ title: '删除', message: `删除干体重 ${fmt(d.value)}kg（${d.effectiveDate}）？` })
  } catch {
    return
  }
  await repository.deleteDryWeight(d.id)
  await load()
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function exportData() {
  const json = await repository.exportAll()
  const blob = new Blob([json], { type: 'application/json' })
  downloadBlob(blob, `透析记录备份-${todayStr()}.json`)
  showToast('已导出')
}

function importData() {
  fileInput.value?.click()
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  try {
    await repository.importAll(text)
    showToast('导入成功')
    await load()
  } catch (err) {
    console.error(err)
    showToast('导入失败：文件格式不正确')
  }
  input.value = ''
}

function showHelp() {
  showDialog({
    title: '使用说明',
    message:
      '1. 先在「设置」建立病人档案（姓名、生日、轮椅重量、回水量），并添加当前干体重。\n' +
      '2. 在「记录」页用「快速创建」填入上机前体重（含轮椅）快速建记录。\n' +
      '3. 进入记录详情填写下机后体重、血压、血糖、不良反应。\n' +
      '4. 完成后点「标记完成」，在报告页导出图片/PDF 发给医生。\n' +
      '5. 轮椅重量、回水量会快照到每次记录；干体重按日期取当时有效值。',
  })
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="设置" :border="false" />

    <div class="card">
      <div class="card-title">病人档案</div>
      <van-field v-model="form.name" label="姓名" placeholder="请输入姓名" />
      <van-field v-model="form.birthday" label="生日" placeholder="用于计算年龄" type="date" />
      <van-field v-model="form.wheelchairWeight" label="轮椅重量" placeholder="kg" type="number" />
      <van-field v-model="form.rinseBackVolume" label="回水量" placeholder="ml" type="number" />
      <div v-if="patient?.birthday" class="muted" style="margin: 4px 16px">
        当前年龄约 {{ calcAgeStr(patient.birthday) }}
      </div>
      <van-button type="primary" block style="margin-top: 10px" @click="savePatient">保存档案</van-button>
    </div>

    <div class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">干体重历史</div>
        <van-button size="small" type="primary" plain @click="openDw">＋ 新增</van-button>
      </div>
      <div class="muted" style="margin: 6px 0 4px">
        当前有效干体重 <span class="num">{{ fmt(currentDry) }}</span> kg
      </div>
      <div v-if="!dryWeights.length" class="muted" style="padding: 12px 0">暂无干体重记录，请先添加</div>
      <div v-for="d in dryWeights" :key="d.id" class="row" style="padding: 8px 0; border-top: 1px solid #f2f3f5">
        <div>
          <div class="num">{{ formatDateCN(d.effectiveDate) }}</div>
          <div class="muted">{{ d.note || '' }}</div>
        </div>
        <div class="row" style="gap: 12px">
          <span class="num">{{ fmt(d.value) }} kg</span>
          <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="removeDw(d)" />
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">数据管理</div>
      <van-button block plain type="primary" @click="exportData">导出全部数据（JSON 备份）</van-button>
      <van-button block plain style="margin-top: 10px" @click="importData">导入数据恢复</van-button>
      <van-button block plain style="margin-top: 10px" @click="showHelp">使用说明</van-button>
      <van-button v-if="isLoggedIn" block plain style="margin-top: 10px" @click="onMigrate">上传本地数据到云端</van-button>
      <input ref="fileInput" type="file" accept=".json,application/json" style="display: none" @change="onImportFile" />
    </div>

    <div v-if="isLoggedIn" class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">我的病人</div>
        <van-button size="small" type="primary" plain @click="openNewPatient">＋ 新建</van-button>
      </div>
      <div v-if="!myPatients.length" class="muted" style="padding: 10px 0">暂无病人，点「＋ 新建」创建</div>
      <div
        v-for="item in myPatients"
        :key="item.patient.id"
        class="row"
        style="padding: 10px 0; border-top: 1px solid #f2f3f5; cursor: pointer"
        @click="switchPatient(item.patient.id)"
      >
        <div>
          <div class="num">{{ item.patient.name }}</div>
          <div class="muted">{{ roleLabel(item.role) }}</div>
        </div>
        <van-icon v-if="currentPatientId === item.patient.id" name="success" color="#07c160" />
      </div>
      <van-button block plain style="margin-top: 10px" @click="goMembers">成员管理</van-button>
    </div>

    <div v-if="isLoggedIn" class="card">
      <div class="card-title">账号</div>
      <van-button block plain type="danger" @click="onLogout">退出登录</van-button>
    </div>

    <van-popup v-model:show="showDwForm" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">新增干体重</div>
        <van-field v-model="dwForm.value" label="干体重" placeholder="kg" type="number" />
        <van-field v-model="dwForm.effectiveDate" label="生效日期" type="date" />
        <van-field v-model="dwForm.note" label="备注" placeholder="如：医生调整（可选）" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block @click="showDwForm = false">取消</van-button>
          <van-button block type="primary" @click="saveDw">保存</van-button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="showNewPatient" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">新建病人</div>
        <van-field v-model="newPatientForm.name" label="姓名" placeholder="请输入姓名" />
        <van-field v-model="newPatientForm.wheelchairWeight" label="轮椅重量" placeholder="kg" type="number" />
        <van-field v-model="newPatientForm.rinseBackVolume" label="回水量" placeholder="ml" type="number" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block @click="showNewPatient = false">取消</van-button>
          <van-button block type="primary" @click="onCreatePatient">创建</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>
