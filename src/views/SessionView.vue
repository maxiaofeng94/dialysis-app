<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import { repository } from '../repo'
import { REACTION_TYPES } from '../constants'
import { currentPatientId } from '../stores/patient'
import { isLoggedIn } from '../stores/auth'
import { todayStr, parseNum, fmt, formatTime, combineDateTime } from '../utils/format'
import { getEffectiveDryWeight, calcWeights } from '../utils/calc'
import { assessBp, assessGlucose } from '../utils/assess'
import { uuid } from '../utils/id'
import type { DialysisSession, Patient, DryWeight, BloodPressure, BloodGlucose, AdverseReaction } from '../types'

const route = useRoute()
const router = useRouter()
const sessionId = route.params.id as string

const session = ref<DialysisSession | null>(null)
const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const bps = ref<BloodPressure[]>([])
const glucoses = ref<BloodGlucose[]>([])
const reactions = ref<AdverseReaction[]>([])

const form = reactive({
  date: '',
  operator: '',
  notes: '',
  preWeight: '',
  postWeight: '',
})

const showBp = ref(false)
const bpForm = reactive({ time: '', systolic: '', diastolic: '' })
const editingBpId = ref<string | null>(null)
const showGlu = ref(false)
const gluForm = reactive({ time: '', value: '' })
const editingGluId = ref<string | null>(null)
const selectedReactions = ref<string[]>([])
const otherDetail = ref('')

let loaded = false
let timer: ReturnType<typeof setTimeout> | null = null

onMounted(load)

async function load() {
  session.value = (await repository.getSession(sessionId)) ?? null
  if (!session.value) {
    router.replace('/')
    return
  }
  patient.value = (await repository.getPatient(currentPatientId.value)) ?? null
  dryWeights.value = await repository.listDryWeights(currentPatientId.value)
  await loadSub()
  form.date = session.value.date
  form.operator = session.value.operator ?? ''
  form.notes = session.value.notes ?? ''
  form.preWeight = session.value.preWeightMeasured != null ? String(session.value.preWeightMeasured) : ''
  form.postWeight = session.value.postWeightMeasured != null ? String(session.value.postWeightMeasured) : ''
  selectedReactions.value = reactions.value.map((r) => r.type)
  otherDetail.value = reactions.value.find((r) => r.type === 'other')?.detail ?? ''
  loaded = true
}

async function loadSub() {
  bps.value = await repository.listBloodPressures(sessionId)
  glucoses.value = await repository.listBloodGlucoses(sessionId)
  reactions.value = await repository.listAdverseReactions(sessionId)
}

const effectiveDry = computed(() => getEffectiveDryWeight(dryWeights.value, form.date || todayStr()))

const comp = computed(() => {
  if (!session.value) return null
  return calcWeights(
    parseNum(form.preWeight),
    parseNum(form.postWeight),
    session.value.wheelchairWeightUsed,
    session.value.rinseBackVolumeUsed,
    effectiveDry.value,
  )
})

function sanitizeDecimal(raw: string): string {
  let v = raw.replace(/,/g, '.').replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
  if (v.length > 8) v = v.slice(0, 8)
  return v
}
function onPreWeightInput(e: Event) {
  const el = e.target as HTMLInputElement
  const v = sanitizeDecimal(el.value)
  form.preWeight = v
  el.value = v
}
function onPostWeightInput(e: Event) {
  const el = e.target as HTMLInputElement
  const v = sanitizeDecimal(el.value)
  form.postWeight = v
  el.value = v
}

watch(form, () => {
  if (!loaded) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(persistSession, 400)
})

function persistSession(): Promise<void> {
  if (!session.value) return Promise.resolve()
  session.value.date = form.date || todayStr()
  session.value.operator = form.operator.trim() || null
  session.value.notes = form.notes.trim() || null
  session.value.preWeightMeasured = parseNum(form.preWeight)
  session.value.postWeightMeasured = parseNum(form.postWeight)
  session.value.updatedAt = Date.now()
  return repository.saveSession(session.value)
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

// 离开详情页前先等待保存完成，避免列表读到旧状态
onBeforeRouteLeave(async () => {
  try {
    await persistSession()
  } catch (err) {
    console.error(err)
  }
})

async function toggleStatus() {
  if (!session.value) return
  if (session.value.status === 'ongoing') {
    const post = parseNum(form.postWeight)
    if (post == null) {
      await showConfirmDialog({
        title: '提示',
        message: '请先填写下机后体重，才能标记完成',
        showCancelButton: false,
        confirmButtonText: '知道了',
        confirmButtonColor: '#07c160',
        messageAlign: 'center',
      })
      return
    }
  }
  session.value.status = session.value.status === 'completed' ? 'ongoing' : 'completed'
  session.value.updatedAt = Date.now()
  await repository.saveSession(session.value)
  showToast(session.value.status === 'completed' ? '已标记完成' : '已改为进行中')
}

function openBp() {
  editingBpId.value = null
  bpForm.time = formatTime(Date.now())
  bpForm.systolic = ''
  bpForm.diastolic = ''
  showBp.value = true
}
function editBp(bp: BloodPressure) {
  editingBpId.value = bp.id
  bpForm.time = formatTime(bp.measuredAt)
  bpForm.systolic = String(bp.systolic)
  bpForm.diastolic = String(bp.diastolic)
  showBp.value = true
}
async function saveBp() {
  const s = parseNum(bpForm.systolic)
  const d = parseNum(bpForm.diastolic)
  if (s == null || d == null) {
    showToast('请填写高压和低压')
    return
  }
  const sys = Math.round(s)
  const dia = Math.round(d)
  await repository.saveBloodPressure({
    id: editingBpId.value ?? uuid(),
    sessionId,
    measuredAt: combineDateTime(form.date, bpForm.time),
    systolic: sys,
    diastolic: dia,
    note: null,
  })
  showBp.value = false
  editingBpId.value = null
  await loadSub()
  showToast(`已保存：血压 ${sys}/${dia} ${assessBp(sys, dia).text}`)
}
async function removeBp(bp: BloodPressure) {
  try {
    await showConfirmDialog({ title: '删除', message: `删除 ${formatTime(bp.measuredAt)} 的血压记录？` })
  } catch {
    return
  }
  await repository.deleteBloodPressure(bp.id)
  await loadSub()
}

function openGlu() {
  editingGluId.value = null
  gluForm.time = formatTime(Date.now())
  gluForm.value = ''
  showGlu.value = true
}
function editGlu(g: BloodGlucose) {
  editingGluId.value = g.id
  gluForm.time = formatTime(g.measuredAt)
  gluForm.value = String(g.value)
  showGlu.value = true
}
async function saveGlu() {
  const v = parseNum(gluForm.value)
  if (v == null) {
    showToast('请填写血糖值')
    return
  }
  await repository.saveBloodGlucose({
    id: editingGluId.value ?? uuid(),
    sessionId,
    measuredAt: combineDateTime(form.date, gluForm.time),
    value: v,
    note: null,
  })
  showGlu.value = false
  editingGluId.value = null
  await loadSub()
  showToast(`已保存：血糖 ${fmt(v)} mmol/L ${assessGlucose(v).text}`)
}
async function removeGlu(g: BloodGlucose) {
  try {
    await showConfirmDialog({ title: '删除', message: `删除 ${formatTime(g.measuredAt)} 的血糖记录？` })
  } catch {
    return
  }
  await repository.deleteBloodGlucose(g.id)
  await loadSub()
}

function toggleReaction(key: string) {
  const i = selectedReactions.value.indexOf(key)
  if (i >= 0) selectedReactions.value.splice(i, 1)
  else selectedReactions.value.push(key)
  persistReactions()
}
function persistReactions() {
  if (!session.value) return
  const list: AdverseReaction[] = selectedReactions.value
    .filter((k) => k !== 'other' || otherDetail.value.trim() !== '')
    .map((k) => ({
      id: uuid(),
      sessionId,
      type: k,
      detail: k === 'other' ? otherDetail.value.trim() : null,
      severity: null,
      recordedAt: Date.now(),
    }))
  repository.replaceAdverseReactions(sessionId, list)
}
function onOtherBlur() {
  persistReactions()
}

async function removeSession() {
  try {
    await showConfirmDialog({ title: '删除', message: '删除整条透析记录（含血压/血糖/不良反应）？' })
  } catch {
    return
  }
  await repository.deleteSession(sessionId)
  session.value = null
  router.replace('/')
}
</script>

<template>
  <div class="page">
    <van-nav-bar class="sticky-nav" title="透析记录" left-text="返回" left-arrow @click-left="router.back()">
      <template #right>
        <van-icon
          name="description"
          size="20"
          color="#07c160"
          style="cursor: pointer; margin-right: 16px"
          @click="router.push(`/report/${sessionId}`)"
        />
        <van-icon name="delete-o" size="20" color="#969799" style="cursor: pointer" @click="removeSession" />
      </template>
    </van-nav-bar>

    <template v-if="session">
      <!-- 基本信息 -->
      <div class="card">
        <div class="status-row">
          <div class="status-badge" :class="session.status">
            <span class="dot"></span>
            {{ session.status === 'completed' ? '已完成' : '进行中' }}
          </div>
          <van-button
            size="small"
            round
            :type="session.status === 'completed' ? 'default' : 'success'"
            :icon="session.status === 'completed' ? 'replay' : 'checked'"
            @click="toggleStatus"
          >
            {{ session.status === 'completed' ? '改为进行中' : '标记完成' }}
          </van-button>
        </div>
        <van-field v-model="form.date" label="透析日期" type="date" />
        <van-field v-if="!isLoggedIn" v-model="form.operator" label="记录人" placeholder="谁记录的（可选）" />
      </div>

      <!-- 体重与脱水 -->
      <div class="card">
        <div class="card-title">体重与脱水</div>

        <div class="weight-fields">
          <div class="weight-field">
            <div class="weight-label">上机前称重（含轮椅）</div>
            <div class="weight-input-wrap">
              <input :value="form.preWeight" type="text" inputmode="decimal" placeholder="0.0" class="weight-input" @input="onPreWeightInput" />
              <span class="weight-unit">kg</span>
            </div>
          </div>
          <div class="weight-field">
            <div class="weight-label">下机后称重（含轮椅）</div>
            <div class="weight-input-wrap">
              <input :value="form.postWeight" type="text" inputmode="decimal" placeholder="0.0" class="weight-input" @input="onPostWeightInput" />
              <span class="weight-unit">kg</span>
            </div>
          </div>
        </div>

        <div class="flow">
          <div class="flow-node">
            <div class="flow-label">上机前实际</div>
            <div class="flow-val">{{ fmt(comp?.preWeightActual) }}<small>kg</small></div>
          </div>
          <div class="flow-mid">
            <div class="flow-arrow">↓</div>
            <div v-if="comp?.actualUf != null" class="flow-diff">脱 {{ fmt(comp.actualUf) }}L</div>
          </div>
          <div class="flow-node">
            <div class="flow-label">下机后实际</div>
            <div class="flow-val">{{ fmt(comp?.postWeightActual) }}<small>kg</small></div>
          </div>
        </div>

        <div class="uf-grid">
          <div class="uf-item">
            <div class="uf-label">计划脱水量</div>
            <div class="uf-val">{{ fmt(comp?.planUf) }}<small>L</small></div>
          </div>
          <div class="uf-item">
            <div class="uf-label">实际脱水量</div>
            <div class="uf-val">{{ fmt(comp?.actualUf) }}<small>L</small></div>
          </div>
        </div>

        <div class="uf-meta">当日干体重 {{ fmt(comp?.effectiveDryWeight) }}kg · 回水 {{ comp?.rinseBackMl ?? '—' }}ml · 机器超滤 {{ fmt(comp?.machineUf) }}L</div>
      </div>

      <!-- 血压 -->
      <div class="card">
        <div class="row">
          <div class="card-title" style="margin: 0">血压 ({{ bps.length }})</div>
          <van-button size="small" type="primary" plain @click="openBp">＋ 记录</van-button>
        </div>
        <div v-if="!bps.length" class="muted" style="padding: 10px 0">暂无血压记录</div>
        <div v-for="bp in bps" :key="bp.id" class="row" style="padding: 8px 0; border-top: 1px solid #f2f3f5">
          <div class="row" style="gap: 10px">
            <span class="muted">{{ formatTime(bp.measuredAt) }}</span>
            <span class="num">{{ bp.systolic }} / {{ bp.diastolic }} <span class="muted">mmHg</span></span>
            <van-tag :type="assessBp(bp.systolic, bp.diastolic).color">{{ assessBp(bp.systolic, bp.diastolic).text }}</van-tag>
          </div>
          <div class="row" style="gap: 10px">
            <van-icon name="edit" color="#1989fa" style="cursor: pointer" @click="editBp(bp)" />
            <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="removeBp(bp)" />
          </div>
        </div>
      </div>

      <!-- 血糖 -->
      <div class="card">
        <div class="row">
          <div class="card-title" style="margin: 0">血糖 ({{ glucoses.length }})</div>
          <van-button size="small" type="primary" plain @click="openGlu">＋ 记录</van-button>
        </div>
        <div v-if="!glucoses.length" class="muted" style="padding: 10px 0">暂无血糖记录（每次透析 1 次）</div>
        <div v-for="g in glucoses" :key="g.id" class="row" style="padding: 8px 0; border-top: 1px solid #f2f3f5">
          <div class="row" style="gap: 10px">
            <span class="muted">{{ formatTime(g.measuredAt) }}</span>
            <span class="num">{{ fmt(g.value) }} <span class="muted">mmol/L</span></span>
            <van-tag :type="assessGlucose(g.value).color">{{ assessGlucose(g.value).text }}</van-tag>
          </div>
          <div class="row" style="gap: 10px">
            <van-icon name="edit" color="#1989fa" style="cursor: pointer" @click="editGlu(g)" />
            <van-icon name="delete-o" color="#ee0a24" style="cursor: pointer" @click="removeGlu(g)" />
          </div>
        </div>
      </div>

      <!-- 不良反应 -->
      <div class="card">
        <div class="card-title">不良反应</div>
        <div>
          <span
            v-for="r in REACTION_TYPES"
            :key="r.key"
            class="chip"
            :class="{ active: selectedReactions.includes(r.key) }"
            @click="toggleReaction(r.key)"
          >
            {{ r.label }}
          </span>
        </div>
        <van-field
          v-if="selectedReactions.includes('other')"
          v-model="otherDetail"
          label="其他"
          placeholder="请描述具体不良反应"
          @blur="onOtherBlur"
        />
        <van-field v-model="form.notes" label="备注" placeholder="其他补充说明（可选）" />
      </div>

    </template>

    <!-- 血压弹窗 -->
    <van-popup v-model:show="showBp" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">{{ editingBpId ? '编辑血压' : '记录血压' }}</div>
        <van-field v-model="bpForm.time" label="测量时间" type="time" />
        <van-field v-model="bpForm.systolic" label="高压" placeholder="mmHg" type="number" />
        <van-field v-model="bpForm.diastolic" label="低压" placeholder="mmHg" type="number" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block @click="showBp = false">取消</van-button>
          <van-button block type="primary" @click="saveBp">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 血糖弹窗 -->
    <van-popup v-model:show="showGlu" round position="bottom">
      <div style="padding: 20px">
        <div class="card-title">{{ editingGluId ? '编辑血糖' : '记录血糖' }}</div>
        <van-field v-model="gluForm.time" label="测量时间" type="time" />
        <van-field v-model="gluForm.value" label="血糖值" placeholder="mmol/L" type="number" />
        <div style="display: flex; gap: 12px; margin-top: 16px">
          <van-button block @click="showGlu = false">取消</van-button>
          <van-button block type="primary" @click="saveGlu">保存</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding: 10px 12px;
  background: #f7f8fa;
  border-radius: 10px;
}
.status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 999px;
}
.status-badge .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.status-badge.ongoing {
  color: #ed6a0c;
  background: #fff4e8;
}
.status-badge.completed {
  color: #07c160;
  background: #e8f7ef;
}
.sticky-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  background: #fff;
}
.weight-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}
.weight-field {
  width: 100%;
}
.weight-label {
  font-size: 13px;
  color: #646566;
  margin-bottom: 6px;
}
.weight-input-wrap {
  display: flex;
  align-items: baseline;
  gap: 10px;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  border-radius: 12px;
  padding: 12px 16px;
}
.weight-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font-size: 34px;
  font-weight: 700;
  color: #323233;
  text-align: center;
  outline: none;
  line-height: 1.2;
}
.weight-input::placeholder {
  color: #c8c9cc;
}
.weight-unit {
  font-size: 16px;
  font-weight: 600;
  color: #646566;
}
.flow {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f7f8fa;
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 12px;
}
.flow-node {
  flex: 1;
  text-align: center;
}
.flow-label {
  font-size: 12px;
  color: #969799;
}
.flow-val {
  font-size: 22px;
  font-weight: 700;
  color: #323233;
}
.flow-val small {
  font-size: 12px;
  font-weight: 500;
  color: #969799;
  margin-left: 2px;
}
.flow-mid {
  text-align: center;
  min-width: 56px;
}
.flow-arrow {
  font-size: 20px;
  color: #07c160;
  line-height: 1;
}
.flow-diff {
  font-size: 12px;
  color: #07c160;
  font-weight: 600;
  margin-top: 2px;
}
.uf-grid {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}
.uf-item {
  flex: 1;
  background: #e8f7ef;
  border-radius: 12px;
  padding: 12px 6px;
  text-align: center;
}
.uf-label {
  font-size: 12px;
  color: #07c160;
}
.uf-val {
  font-size: 24px;
  font-weight: 700;
  color: #07c160;
}
.uf-val small {
  font-size: 13px;
  font-weight: 500;
  margin-left: 2px;
}
.uf-meta {
  font-size: 12px;
  color: #969799;
  text-align: center;
}
</style>
