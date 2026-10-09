<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { showToast, showConfirmDialog, showDialog } from 'vant'
import { useRouter } from 'vue-router'
import { useAuth } from '../stores/auth'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { repository } from '../repo'
import { cacheDelete } from '../lib/cloudCache'
import { DEFAULT_RINSE_BACK_ML } from '../constants'
import {
  currentPatientId,
  setCurrentPatientId,
  currentRole,
  refreshCurrentRole,
  ensureCloudPatient,
} from '../stores/patient'
import { listMyPatients, createPatient, getMyProfile, updateMyName } from '../lib/cloudAdmin'
import { migrateLocalToCloud } from '../lib/migrate'
import { todayStr, parseNum, fmt, formatDateCN, calcAge } from '../utils/format'
import { getEffectiveDryWeight } from '../utils/calc'
import { uuid } from '../utils/id'
import type { Patient, DryWeight } from '../types'

const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const router = useRouter()
const { user, isLoggedIn, logout } = useAuth()

/** 各操作的进行中状态：按钮 loading/disabled 用，防止连点造成重复写入（新建/迁移各建一个病人） */
const savingPatient = ref(false)
const savingDw = ref(false)
const savingName = ref(false)
const creatingPatient = ref(false)
const migrating = ref(false)
const exporting = ref(false)

/**
 * 能不能改「病人配置」（档案 / 干体重）：
 * 数据库里 patients_update 与 dw_insert/update/delete 都是 owner-only，
 * caregiver / doctor / viewer 点下去只会「假成功」（RLS 静默 0 行），
 * 更糟的是假值会被写进本机缓存，随后被「快速创建」快照进新记录（轮椅重量/回水量永久偏差）。
 * 角色未知（本地单机模式、还没拉到）时不限制 —— 与服务端「拦得住」的事实一致。
 */
const canEditConfig = computed(() => currentRole.value === null || currentRole.value === 'owner')

/** 错误对象 → 用户看得懂的文案（保留仓储/服务端抛出的真实原因，不要一律说成「格式不正确」） */
function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : (err as { message?: unknown } | null)?.message
  return typeof msg === 'string' && msg.trim() ? msg.trim() : '请检查网络后重试'
}

// 被踢下线 / 令牌失效：repository 会切回本地仓储，页面变得「查无数据」，必须明确提示并引导回登录页
// （主动点「退出登录」时不算失效，用 loggingOut 跳过这段提示）
let loggingOut = false
watch(isLoggedIn, (val, old) => {
  if (old && !val && !loggingOut) {
    showToast('登录状态已失效，请重新登录')
    void router.replace('/login')
  }
})

async function onLogout() {
  try {
    await showConfirmDialog({
      title: '退出登录',
      message: '退出后将清除本机缓存的云端数据，需要重新登录才能查看记录。确认退出？',
    })
  } catch {
    return // 用户取消
  }
  loggingOut = true
  await logout()
  router.replace('/login')
}

async function saveMyName() {
  if (savingName.value) return // 防连点
  savingName.value = true
  try {
    const res = await updateMyName(myName.value.trim())
    showToast(res.ok ? '已保存' : res.error ?? '保存失败')
  } catch (err) {
    console.error(err)
    showToast(`保存失败：${errorText(err)}`)
  } finally {
    savingName.value = false
  }
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
const myName = ref('')
const myPhone = ref('')
const showNewPatient = ref(false)
const newPatientForm = reactive({ name: '', wheelchairWeight: '', rinseBackVolume: '' })

/** 首次加载（本机还没有缓存）时的骨架占位 */
const loading = ref(true)

onMounted(async () => {
  await load()
  if (isLoggedIn.value) {
    myPatients.value = await listMyPatients()
    // 角色决定「病人配置」能不能改（非 owner 的写入会被数据库静默拒绝）
    await refreshCurrentRole()
    const profile = await getMyProfile()
    myName.value = profile?.name ?? ''
    myPhone.value = profile?.phone ?? ''
  }
})

/**
 * 重新拉取「我的病人」列表（M2）：
 * cloudAdmin.listMyPatients 命中本机缓存就直接返回旧列表 —— 新建/迁移出来的病人不会出现、
 * ✓ 也不会高亮。这里先按 uid 删掉缓存 key 再请求（等价于强制刷新），不需要给数据层加 force 参数。
 */
async function reloadMyPatients(): Promise<void> {
  const uid = user.value?.id
  if (uid) await cacheDelete(`myPatients:${uid}`)
  myPatients.value = await listMyPatients()
}

/** 兜底：迁移接口没给新病人 id 时，从刷新后的列表里取「新出现的那个」 */
function pickAddedPatientId(beforeIds: Set<string>): string | null {
  return myPatients.value.find((item) => !beforeIds.has(item.patient.id))?.patient.id ?? null
}

async function switchPatient(id: string) {
  setCurrentPatientId(id)
  await refreshCurrentRole()
  showToast('已切换病人')
  await load(true) // 换病人：无条件用新档案回填表单
}

function openNewPatient() {
  newPatientForm.name = ''
  newPatientForm.wheelchairWeight = ''
  newPatientForm.rinseBackVolume = ''
  showNewPatient.value = true
}

async function onCreatePatient() {
  if (creatingPatient.value) return // 连点保护：每次点击都会真的建一个病人
  if (!newPatientForm.name.trim()) {
    showToast('请填写姓名')
    return
  }
  const wheelchairWeight = parseNum(newPatientForm.wheelchairWeight) ?? 0
  const rinseBackVolume = parseNum(newPatientForm.rinseBackVolume) ?? DEFAULT_RINSE_BACK_ML
  const bad =
    rangeError('轮椅重量', wheelchairWeight, 0, WHEELCHAIR_MAX) ??
    rangeError('回水量', rinseBackVolume, 0, RINSE_BACK_MAX)
  if (bad) {
    showToast(bad)
    return
  }
  creatingPatient.value = true
  try {
    const res = await createPatient(newPatientForm.name.trim(), wheelchairWeight, rinseBackVolume)
    if (!res.ok || !res.data?.patient) {
      showToast(res.data?.error ?? '创建失败')
      return
    }
    // 到这里病人已经在云端建出来了：后面任何一步失败都不能提示「创建失败」，
    // 否则用户会再点一次，造出 App 内删不掉的重复病人。
    setCurrentPatientId(res.data.patient.id)
    showNewPatient.value = false
    try {
      await reloadMyPatients() // 强制重拉：否则命中旧缓存，新病人不在列表里（M2）
      await refreshCurrentRole()
      await load(true)
      showToast('已创建')
    } catch (err) {
      console.error(err)
      showToast('病人已创建，但列表刷新失败，请检查网络后重试')
    }
  } catch (err) {
    console.error(err)
    showToast(`创建失败：${errorText(err)}`)
  } finally {
    creatingPatient.value = false
  }
}

async function onMigrate() {
  if (migrating.value) return // 连点/重复提交保护：migrate 每次都会在云端新建一个病人
  migrating.value = true
  try {
    try {
      await showConfirmDialog({
        title: '迁移数据',
        message:
          '将把本机全部数据上传到云端，并在云端新建一个病人。此操作不可撤销，重复执行会生成重复病人，确认继续？',
      })
    } catch {
      return // 用户取消
    }
    const beforeIds = new Set(myPatients.value.map((item) => item.patient.id))
    const res = await migrateLocalToCloud()
    if (!res.ok) {
      showToast(res.message || '迁移失败')
      return
    }
    // 迁移已经成功（云端已新建病人）：后续刷新失败也不能说「迁移失败」，
    // 否则用户会再跑一次，云端就多一个重复病人。
    const name = patient.value?.name ?? '新病人'
    // migrateLocalToCloud 的 message 形如「已迁移 N 条透析记录到云端」
    showToast(`已在云端新建病人「${name}」，${res.message}`)
    try {
      await reloadMyPatients()
      // 优先用迁移接口返回的新病人 id；老版本/异常情况下退回「列表里新出现的那个」
      const newId = res.patientId ?? pickAddedPatientId(beforeIds)
      if (newId) setCurrentPatientId(newId)
      else await ensureCloudPatient() // 列表没变化时退回按列表校准
      await refreshCurrentRole()
      await load(true)
    } catch (err) {
      console.error(err)
      showToast('迁移已完成，但列表刷新失败，请检查网络后重试')
    }
  } catch (err) {
    console.error(err)
    showToast(`迁移失败：${errorText(err)}`)
  } finally {
    migrating.value = false
  }
}

function goMembers() {
  router.push('/members')
}

/**
 * 表单「干净」快照（M3）：保存干体重、删除干体重等操作都会触发 load()，
 * 若无条件回填，用户正在填的档案会被后台数据覆盖掉。记录一份初始快照做比对，
 * 只在「表单没被改过」时才回填；force = 用户主动换病人/整份导入后无条件回填。
 */
let formSnapshot: string | null = null

function snapshotForm(): string {
  return JSON.stringify([form.name, form.birthday, form.wheelchairWeight, form.rinseBackVolume])
}

function fillForm(p: Patient | null) {
  form.name = p?.name ?? ''
  form.birthday = p?.birthday ?? ''
  form.wheelchairWeight = p ? String(p.wheelchairWeight) : ''
  form.rinseBackVolume = p ? String(p.rinseBackVolume) : ''
  formSnapshot = snapshotForm()
}

async function load(force = false) {
  const pid = currentPatientId.value
  const [p, dw] = await Promise.all([repository.getPatient(pid), repository.listDryWeights(pid)])
  patient.value = p ?? null
  if (force || formSnapshot === null || snapshotForm() === formSnapshot) {
    fillForm(p ?? null)
  }
  dryWeights.value = dw
  loading.value = false
}

const currentDry = computed(() => getEffectiveDryWeight(dryWeights.value, todayStr()))

function calcAgeStr(birthday: string): string {
  const a = calcAge(birthday)
  return a == null ? '—' : `${a} 岁`
}

function roleLabel(role: string): string {
  const map: Record<string, string> = { owner: '创建者', caregiver: '家属/护工', doctor: '医生', viewer: '只读' }
  return map[role] ?? role
}

/**
 * 量程阈值：与 HomeView / SessionView 的 checkRange 同一口径。
 * 只判「是不是数字」是不够的 —— 轮椅重量填 -5 会原样入库，首页算出的「实际体重」跟着偏大；
 * 回水量填 99999 会让机器脱水量离谱。
 * （三处常量目前各存一份，后续可抽到 src/utils/validate.ts 共用。）
 */
const WEIGHT_MIN = 20
const WEIGHT_MAX = 200
const WHEELCHAIR_MAX = 100
const RINSE_BACK_MAX = 2000

function rangeError(label: string, value: number, min: number, max: number): string | null {
  if (!Number.isFinite(value)) return `${label}不是有效数字`
  if (value < min || value > max) return `${label}应在 ${min}~${max} 之间`
  return null
}

async function savePatient() {
  // 非 owner 的保存会被数据库 RLS 静默拦成 0 行，绝不能提示「已保存」（假值还会污染本机缓存）
  if (!canEditConfig.value) {
    showToast('仅创建者可修改病人配置')
    return
  }
  if (savingPatient.value) return

  const wheelchairWeight = parseNum(form.wheelchairWeight) ?? 0
  const rinseBackVolume = parseNum(form.rinseBackVolume) ?? DEFAULT_RINSE_BACK_ML
  const bad =
    rangeError('轮椅重量', wheelchairWeight, 0, WHEELCHAIR_MAX) ??
    rangeError('回水量', rinseBackVolume, 0, RINSE_BACK_MAX)
  if (bad) {
    showToast(`${bad}（未保存）`)
    return
  }

  const now = Date.now()
  const p: Patient = {
    id: currentPatientId.value,
    name: form.name.trim() || '未命名',
    birthday: form.birthday,
    wheelchairWeight,
    rinseBackVolume,
    createdAt: patient.value?.createdAt ?? now,
    updatedAt: now,
  }
  savingPatient.value = true
  try {
    await repository.savePatient(p)
    patient.value = p
    formSnapshot = snapshotForm() // 保存后表单就是「服务端值」，后续 load 可正常回填
    showToast('已保存')
  } catch (err) {
    console.error(err)
    showToast(`保存失败：${errorText(err)}`)
  } finally {
    savingPatient.value = false
  }
}

function openDw() {
  dwForm.value = ''
  dwForm.effectiveDate = todayStr()
  dwForm.note = ''
  showDwForm.value = true
}

async function saveDw() {
  if (!canEditConfig.value) {
    showToast('仅创建者可修改病人配置')
    return
  }
  const v = parseNum(dwForm.value)
  if (v == null) {
    showToast('请填写干体重')
    return
  }
  const bad = rangeError('干体重', v, WEIGHT_MIN, WEIGHT_MAX)
  if (bad) {
    showToast(`${bad}（未添加）`)
    return
  }
  if (savingDw.value) return
  const d: DryWeight = {
    id: uuid(),
    patientId: currentPatientId.value,
    value: v,
    effectiveDate: dwForm.effectiveDate || todayStr(),
    note: dwForm.note.trim() || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  savingDw.value = true
  try {
    await repository.saveDryWeight(d)
    showDwForm.value = false
    await load()
    showToast('已添加')
  } catch (err) {
    console.error(err)
    showToast(`保存失败：${errorText(err)}`)
  } finally {
    savingDw.value = false
  }
}

async function removeDw(d: DryWeight) {
  if (!canEditConfig.value) {
    showToast('仅创建者可修改病人配置')
    return
  }
  try {
    await showConfirmDialog({
      title: '删除',
      message: `删除干体重 ${fmt(d.value)}kg（${d.effectiveDate}）？删除后该日期之后的记录会按更早的干体重重新计算，请确认。`,
    })
  } catch {
    return
  }
  try {
    await repository.deleteDryWeight(d.id)
    await load()
  } catch (err) {
    console.error(err)
    showToast(`删除失败：${errorText(err)}`)
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 从备份 JSON 里数出记录条数（解析不出来就按 0 算，由调用方决定怎么提示） */
function backupCounts(data: unknown): { patients: number; sessions: number } {
  const obj = (data ?? {}) as { patients?: unknown; sessions?: unknown }
  return {
    patients: Array.isArray(obj.patients) ? obj.patients.length : 0,
    sessions: Array.isArray(obj.sessions) ? obj.sessions.length : 0,
  }
}

async function exportData() {
  if (exporting.value) return
  exporting.value = true
  try {
    const json = await repository.exportAll()
    let count = 0
    try {
      count = backupCounts(JSON.parse(json)).sessions
    } catch {
      count = 0
    }
    if (Capacitor.isNativePlatform()) {
      // APK：写入缓存并调起系统分享面板（可保存到文件 / 发送微信等）
      const name = `透析记录备份-${todayStr()}.json`
      const res = await Filesystem.writeFile({
        path: name,
        data: json,
        directory: Directory.Cache,
        recursive: true,
        encoding: Encoding.UTF8,
      })
      await Share.share({ title: '透析记录备份', url: res.uri, files: [res.uri] })
      showToast(`已生成备份（${count} 条透析记录），请选择保存或发送`)
    } else {
      // 浏览器：直接下载到下载目录
      const blob = new Blob([json], { type: 'application/json' })
      downloadBlob(blob, `透析记录备份-${todayStr()}.json`)
      // 带上条数：否则「导出成功」可能掩盖一份空备份（用户以为备份好了）
      showToast(count > 0 ? `已导出，共 ${count} 条透析记录` : '已导出，备份中没有透析记录')
    }
  } catch (err) {
    console.error(err)
    showToast(`导出失败：${errorText(err)}，请检查网络后重试`)
  } finally {
    exporting.value = false
  }
}

function importData() {
  // 云端模式数据在服务器上，本地仓库的 importAll 会无条件抛错 —— 入口就该是灰的
  if (isLoggedIn.value) {
    showToast('云端模式下数据在服务器，恢复备份请先退出登录')
    return
  }
  fileInput.value?.click()
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    if (isLoggedIn.value) {
      showToast('云端模式下数据在服务器，恢复备份请先退出登录')
      return
    }
    const text = await file.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      showToast('导入失败：不是有效的备份文件')
      return
    }
    const counts = backupCounts(parsed)
    try {
      await showConfirmDialog({
        title: '导入数据恢复',
        message:
          `导入会覆盖本机现有全部数据，且无法撤销。\n` +
          `备份中含 ${counts.patients} 个病人、${counts.sessions} 条透析记录，确认恢复？`,
      })
    } catch {
      return // 用户取消：一个字节都不动
    }
    try {
      await repository.importAll(text)
      showToast('导入成功')
      await load(true) // 整份数据被替换：无条件回填表单
    } catch (err) {
      console.error(err)
      // 展示仓储抛出的真实原因（如「备份文件格式不正确：patients 第 1 条缺少 id」）
      showToast(`导入失败：${errorText(err)}`)
    }
  } finally {
    input.value = '' // 任何分支都清空，保证同一个文件能再次选中
  }
}

function showHelp() {
  showDialog({
    title: '使用说明',
    message:
      '1. 先在「设置」建立病人档案（姓名、生日、轮椅重量、回水量），并添加当前干体重。\n' +
      '2. 在「记录」页用「快速创建」填入上机前体重（含轮椅）快速建记录。\n' +
      '3. 进入记录详情填写下机后体重、血压、血糖、不良反应。\n' +
      '4. 完成后点「标记完成」；若因血管条件差等原因没做完，点「中止透析」记录中止时间与原因。\n' +
      '5. 在报告页导出图片发给医生（报告会显示本次状态与中止原因）。\n' +
      '6. 轮椅重量、回水量会快照到每次记录；干体重按日期取当时有效值。',
  })
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="设置" :border="false" />

    <!-- 首次加载（本机还没有缓存）时显示骨架，避免白屏干等 -->
    <div v-if="loading" class="card" style="margin-top: 12px">
      <van-skeleton title :row="6" />
    </div>

    <template v-if="!loading">
    <div class="card">
      <div class="card-title">病人档案</div>
      <van-field v-model="form.name" label="姓名" placeholder="请输入姓名" />
      <van-field v-model="form.birthday" label="生日" placeholder="用于计算年龄" type="date" />
      <van-field v-model="form.wheelchairWeight" label="轮椅重量" placeholder="kg" type="number" />
      <van-field v-model="form.rinseBackVolume" label="回水量" placeholder="ml" type="number" />
      <div v-if="patient?.birthday" class="muted" style="margin: 4px 16px">
        当前年龄约 {{ calcAgeStr(patient.birthday) }}
      </div>
      <div v-if="!canEditConfig" class="muted" style="margin: 4px 16px">
        仅创建者可修改病人配置（你当前是「{{ roleLabel(currentRole ?? '') }}」，修改不会被保存）
      </div>
      <van-button
        type="primary"
        block
        style="margin-top: 10px"
        :loading="savingPatient"
        :disabled="!canEditConfig || savingPatient"
        @click="savePatient"
      >
        保存档案
      </van-button>
    </div>

    <div class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">干体重历史</div>
        <van-button size="small" type="primary" plain :disabled="!canEditConfig" @click="openDw">＋ 新增</van-button>
      </div>
      <div v-if="!canEditConfig" class="muted" style="margin: 6px 0 4px">仅创建者可修改病人配置</div>
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
          <van-icon
            v-if="canEditConfig"
            name="delete-o"
            color="#ee0a24"
            style="cursor: pointer"
            @click="removeDw(d)"
          />
          <van-icon v-else name="delete-o" color="#c8c9cc" />
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">数据管理</div>
      <van-button block plain type="primary" :loading="exporting" :disabled="exporting" @click="exportData">
        导出全部数据（JSON 备份）
      </van-button>
      <van-button
        block
        plain
        style="margin-top: 10px"
        :disabled="isLoggedIn"
        @click="importData"
      >
        导入数据恢复
      </van-button>
      <div v-if="isLoggedIn" class="muted" style="margin: 6px 2px 0">
        云端模式下数据在服务器，恢复备份请先退出登录
      </div>
      <van-button block plain style="margin-top: 10px" @click="showHelp">使用说明</van-button>
      <van-button
        v-if="isLoggedIn"
        block
        plain
        style="margin-top: 10px"
        :loading="migrating"
        :disabled="migrating"
        @click="onMigrate"
      >
        上传本地数据到云端
      </van-button>
      <input ref="fileInput" type="file" accept=".json,application/json" style="display: none" @change="onImportFile" />
    </div>

    <div v-if="isLoggedIn" class="card">
      <div class="row">
        <div class="card-title" style="margin: 0">我的病人</div>
        <van-button size="small" type="primary" plain :loading="creatingPatient" :disabled="creatingPatient" @click="openNewPatient">
          ＋ 新建
        </van-button>
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
      <van-field v-model="myName" label="我的姓名" placeholder="记录人显示用（默认手机号）" />
      <div v-if="myPhone" class="muted" style="margin: 4px 16px">手机号 {{ myPhone }}</div>
      <van-button block plain type="primary" style="margin-top: 10px" :loading="savingName" :disabled="savingName" @click="saveMyName">
        保存姓名
      </van-button>
      <van-button block plain type="danger" style="margin-top: 10px" @click="onLogout">退出登录</van-button>
    </div>

    <van-popup v-model:show="showDwForm" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">新增干体重</div>
        <van-field v-model="dwForm.value" label="干体重" placeholder="kg" type="number" />
        <van-field v-model="dwForm.effectiveDate" label="生效日期" type="date" />
        <van-field v-model="dwForm.note" label="备注" placeholder="如：医生调整（可选）" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block @click="showDwForm = false">取消</van-button>
          <van-button block type="primary" :loading="savingDw" :disabled="savingDw" @click="saveDw">保存</van-button>
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
          <van-button block type="primary" :loading="creatingPatient" :disabled="creatingPatient" @click="onCreatePatient">
            创建
          </van-button>
        </div>
      </div>
    </van-popup>
    </template>
  </div>
</template>
