<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { repository } from '../repo'
import { DEFAULT_PATIENT_ID } from '../constants'
import { todayStr, formatDateCN, fmt, calcAge } from '../utils/format'
import { computeSession, getEffectiveDryWeight } from '../utils/calc'
import { uuid } from '../utils/id'
import type { Patient, DryWeight, DialysisSession } from '../types'

const router = useRouter()
const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const sessions = ref<DialysisSession[]>([])
const quickWeight = ref('')
const loading = ref(true)
const showNewDialog = ref(false)

onMounted(refresh)

async function refresh() {
  patient.value = (await repository.getPatient(DEFAULT_PATIENT_ID)) ?? null
  dryWeights.value = await repository.listDryWeights(DEFAULT_PATIENT_ID)
  sessions.value = await repository.listSessions(DEFAULT_PATIENT_ID)
  loading.value = false
}

const currentDry = computed(() => getEffectiveDryWeight(dryWeights.value, todayStr()))

function ageText(): string {
  const a = patient.value?.birthday ? calcAge(patient.value.birthday) : null
  return a == null ? '' : `${a} 岁`
}

const quickPreview = computed(() => {
  const p = patient.value
  if (!p || quickWeight.value.trim() === '') return null
  const w = Number(quickWeight.value)
  if (!Number.isFinite(w)) return null
  const pre = Math.round((w - p.wheelchairWeight) * 10) / 10
  const dry = getEffectiveDryWeight(dryWeights.value, todayStr())
  const plan = dry != null ? Math.round((pre - dry) * 10) / 10 : null
  return { pre, plan }
})

const grouped = computed(() => {
  const map = new Map<string, DialysisSession[]>()
  for (const s of sessions.value) {
    const month = s.date.slice(0, 7)
    const arr = map.get(month)
    if (arr) arr.push(s)
    else map.set(month, [s])
  }
  return Array.from(map.entries())
})

function summary(s: DialysisSession) {
  const dry = getEffectiveDryWeight(dryWeights.value, s.date)
  return computeSession(s, dry)
}

// 只允许数字和一个小数点，并把中文逗号/全角转换为英文点
function onWeightInput(e: Event) {
  const el = e.target as HTMLInputElement
  let v = el.value.replace(/,/g, '.').replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
  if (v.length > 8) v = v.slice(0, 8)
  quickWeight.value = v
  el.value = v
}

async function createSession(preWeight: number | null) {
  if (!patient.value) {
    router.push('/settings')
    return
  }
  const s: DialysisSession = {
    id: uuid(),
    patientId: DEFAULT_PATIENT_ID,
    date: todayStr(),
    preWeightMeasured: preWeight,
    postWeightMeasured: null,
    wheelchairWeightUsed: patient.value.wheelchairWeight,
    rinseBackVolumeUsed: patient.value.rinseBackVolume,
    operator: null,
    status: 'ongoing',
    notes: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await repository.saveSession(s)
  router.push(`/session/${s.id}`)
}

async function onQuickCreate() {
  if (!patient.value) {
    router.push('/settings')
    return
  }
  if (quickWeight.value.trim() === '') {
    await showConfirmDialog({
      title: '提示',
      message: '请先填写上机前体重（含轮椅），才能立即创建记录',
      showCancelButton: false,
      confirmButtonText: '知道了',
      confirmButtonColor: '#07c160',
      messageAlign: 'center',
    })
    return
  }
  const w = Number(quickWeight.value)
  if (!Number.isFinite(w)) {
    showToast('请输入有效的体重数值')
    return
  }
  await createSession(w)
}

function onNewBlank() {
  showNewDialog.value = true
}

async function doNewBlank() {
  showNewDialog.value = false
  await createSession(null)
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="透析记录" :border="false">
      <template #right>
        <van-button size="small" type="primary" plain @click="onNewBlank">＋ 新建</van-button>
      </template>
    </van-nav-bar>

    <div v-if="patient" class="card patient-card">
      <div class="patient-head">
        <div class="avatar">{{ patient.name.charAt(0) }}</div>
        <div class="patient-name">{{ patient.name }}</div>
        <span v-if="ageText()" class="age-badge">{{ ageText() }}</span>
      </div>
      <div class="patient-divider"></div>
      <div class="patient-stats">
        <div class="pstat">
          <div class="pstat-v">{{ fmt(currentDry) }}<small>kg</small></div>
          <div class="pstat-l">干体重</div>
        </div>
        <div class="pstat">
          <div class="pstat-v">{{ fmt(patient.wheelchairWeight) }}<small>kg</small></div>
          <div class="pstat-l">轮椅重量</div>
        </div>
        <div class="pstat">
          <div class="pstat-v">{{ patient.rinseBackVolume }}<small>ml</small></div>
          <div class="pstat-l">回水量</div>
        </div>
      </div>
    </div>

    <!-- 快速创建 -->
    <div class="quick-card">
      <div class="quick-title">快速创建</div>
      <div class="quick-label">上机前体重（含轮椅）</div>
      <div class="quick-input-wrap">
        <input
          :value="quickWeight"
          type="text"
          inputmode="decimal"
          placeholder="0.0"
          class="quick-input"
          @input="onWeightInput"
        />
        <span class="quick-unit">kg</span>
      </div>
      <div v-if="patient" class="quick-stats">
        <div class="stat">
          <div class="stat-label">实际体重</div>
          <div class="stat-value">{{ fmt(quickPreview?.pre) }}<small> kg</small></div>
        </div>
        <div class="stat">
          <div class="stat-label">计划脱水量</div>
          <div class="stat-value">{{ fmt(quickPreview?.plan) }}<small> L</small></div>
        </div>
      </div>
      <div v-else class="quick-hint">请先到「设置」建立病人档案，才能自动计算</div>
      <button class="quick-btn" @click="onQuickCreate">立即创建</button>
    </div>

    <!-- 无病人档案 -->
    <van-empty v-if="!loading && !patient" description="请先建立病人档案">
      <van-button type="primary" @click="router.push('/settings')">去设置</van-button>
    </van-empty>

    <!-- 记录列表 -->
    <template v-else>
      <van-empty v-if="!sessions.length" description="暂无透析记录，点击上方快速创建" />
      <div v-for="[month, list] in grouped" :key="month" class="card" style="padding: 8px 14px">
        <div class="card-title" style="margin: 6px 0">{{ month }}</div>
        <div
          v-for="s in list"
          :key="s.id"
          style="padding: 10px 0; border-top: 1px solid #f2f3f5; cursor: pointer"
          @click="router.push(`/session/${s.id}`)"
        >
          <div class="row">
            <span class="num">{{ formatDateCN(s.date) }}</span>
            <van-tag :type="s.status === 'completed' ? 'success' : 'warning'">
              {{ s.status === 'completed' ? '已完成' : '进行中' }}
            </van-tag>
          </div>
          <div class="muted" style="margin-top: 4px">
            上机前实际 <span class="num">{{ fmt(summary(s).preWeightActual) }}</span> kg
            <template v-if="summary(s).planUf != null">
              · 计划脱水 <span class="num">{{ fmt(summary(s).planUf) }}</span> L
            </template>
            <template v-if="s.operator"> · {{ s.operator }}</template>
          </div>
        </div>
      </div>
    </template>

    <!-- 新建确认弹窗 -->
    <van-dialog
      v-model:show="showNewDialog"
      title="新建记录"
      show-cancel-button
      confirm-button-text="创建"
      cancel-button-text="取消"
      confirm-button-color="#07c160"
      @confirm="doNewBlank"
    >
      <div class="new-dialog-body">
        <div class="new-dialog-title">将创建一条空白透析记录</div>
        <div class="new-dialog-sub">稍后可在详情页补充体重、血压、血糖等信息</div>
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.quick-card {
  background: linear-gradient(135deg, #07c160, #05a84f);
  border-radius: 16px;
  padding: 18px 18px 16px;
  margin-bottom: 14px;
  color: #fff;
  box-shadow: 0 8px 20px rgba(7, 193, 96, 0.28);
}
.quick-title {
  font-size: 15px;
  font-weight: 700;
}
.quick-label {
  font-size: 13px;
  opacity: 0.88;
  margin-top: 12px;
}
.quick-input-wrap {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  margin: 4px 0 14px;
}
.quick-input {
  width: 170px;
  background: transparent;
  border: none;
  border-bottom: 2px solid rgba(255, 255, 255, 0.7);
  font-size: 44px;
  font-weight: 700;
  color: #fff;
  text-align: center;
  outline: none;
  line-height: 1.2;
}
.quick-input::placeholder {
  color: rgba(255, 255, 255, 0.45);
}
.quick-unit {
  font-size: 18px;
  font-weight: 600;
}
.quick-stats {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.stat {
  flex: 1;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  padding: 12px 6px;
  text-align: center;
}
.stat-label {
  font-size: 12px;
  opacity: 0.92;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-value small {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.85;
}
.quick-hint {
  text-align: center;
  padding: 14px 0;
  font-size: 13px;
  opacity: 0.92;
  margin-bottom: 14px;
}
.quick-btn {
  width: 100%;
  background: #fff;
  color: #07c160;
  border: none;
  border-radius: 12px;
  padding: 12px 0;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}
.quick-btn:active {
  opacity: 0.9;
}
.patient-card {
  padding: 16px;
}
.patient-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: linear-gradient(135deg, #07c160, #05a84f);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 3px 8px rgba(7, 193, 96, 0.3);
}
.patient-name {
  font-size: 17px;
  font-weight: 700;
  color: #323233;
}
.age-badge {
  margin-left: auto;
  background: #e8f7ef;
  color: #07c160;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
}
.patient-divider {
  height: 1px;
  background: #f2f3f5;
  margin: 12px 0;
}
.patient-stats {
  display: flex;
}
.pstat {
  flex: 1;
  text-align: center;
}
.pstat + .pstat {
  border-left: 1px solid #f2f3f5;
}
.pstat-v {
  font-size: 20px;
  font-weight: 700;
  color: #323233;
  line-height: 1.2;
}
.pstat-v small {
  font-size: 11px;
  font-weight: 500;
  color: #969799;
  margin-left: 2px;
}
.pstat-l {
  font-size: 12px;
  color: #969799;
  margin-top: 4px;
}
.new-dialog-body {
  text-align: center;
  padding: 8px 4px 4px;
}
.new-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: #323233;
}
.new-dialog-sub {
  font-size: 13px;
  color: #969799;
  margin-top: 8px;
}
</style>
