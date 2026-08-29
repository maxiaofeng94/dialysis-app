<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import html2canvas from 'html2canvas'
import { Capacitor } from '@capacitor/core'
import { Share } from '@capacitor/share'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { repository } from '../repo'
import { DEFAULT_PATIENT_ID, reactionLabel } from '../constants'
import { fmt, formatTime, calcAge } from '../utils/format'
import { computeSession, getEffectiveDryWeight } from '../utils/calc'
import { assessBp, assessGlucose } from '../utils/assess'
import BaseChart from '../components/BaseChart.vue'
import type { DialysisSession, Patient, DryWeight, BloodPressure, BloodGlucose, BloodFlow, AdverseReaction } from '../types'

const route = useRoute()
const router = useRouter()
const sessionId = route.params.id as string

const session = ref<DialysisSession | null>(null)
const patient = ref<Patient | null>(null)
const dryWeights = ref<DryWeight[]>([])
const bps = ref<BloodPressure[]>([])
const glucoses = ref<BloodGlucose[]>([])
const flows = ref<BloodFlow[]>([])
const reactions = ref<AdverseReaction[]>([])
const reportEl = ref<HTMLDivElement>()

onMounted(load)

async function load() {
  session.value = (await repository.getSession(sessionId)) ?? null
  if (!session.value) {
    router.replace('/')
    return
  }
  patient.value = (await repository.getPatient(DEFAULT_PATIENT_ID)) ?? null
  dryWeights.value = await repository.listDryWeights(DEFAULT_PATIENT_ID)
  bps.value = await repository.listBloodPressures(sessionId)
  glucoses.value = await repository.listBloodGlucoses(sessionId)
  flows.value = await repository.listBloodFlows(sessionId)
  reactions.value = await repository.listAdverseReactions(sessionId)
}

const comp = computed(() => {
  if (!session.value) return null
  const dry = getEffectiveDryWeight(dryWeights.value, session.value.date)
  return computeSession(session.value, dry)
})

const reactionText = computed(() => {
  if (!reactions.value.length) return '无'
  return reactions.value
    .map((r) => (r.type === 'other' && r.detail ? `${r.detail}` : reactionLabel(r.type)))
    .join('、')
})

const bpOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['高压', '低压'] },
  grid: { left: 42, right: 20, top: 48, bottom: 32 },
  xAxis: { type: 'category', data: bps.value.map((b) => formatTime(b.measuredAt)) },
  yAxis: { type: 'value', name: 'mmHg' },
  series: [
    { name: '高压', type: 'line', smooth: true, color: '#ee0a24', data: bps.value.map((b) => b.systolic) },
    { name: '低压', type: 'line', smooth: true, color: '#1989fa', data: bps.value.map((b) => b.diastolic) },
  ],
}))

const summaryText = computed(() => {
  const c = comp.value
  const name = patient.value?.name ?? ''
  const date = session.value?.date ?? ''
  return (
    `透析报告 ${name} ${date}\n` +
    `上机前 ${fmt(c?.preWeightActual)}kg，下机后 ${fmt(c?.postWeightActual)}kg，干体重 ${fmt(c?.effectiveDryWeight)}kg\n` +
    `医生设定脱水 ${fmt(session.value?.doctorUf)}ml，计划脱水 ${fmt(c?.planUf)}L，实际脱水 ${fmt(c?.actualUf)}L，回水 ${c?.rinseBackMl ?? ''}ml\n` +
    `不良反应：${reactionText.value}`
  )
})

const isNative = Capacitor.isNativePlatform()

function reportFilename(): string {
  return `透析报告-${session.value?.date ?? ''}.png`
}

async function capture(): Promise<HTMLCanvasElement> {
  if (!reportEl.value) throw new Error('no element')
  return Promise.race([
    html2canvas(reportEl.value, { scale: 2, backgroundColor: '#ffffff', useCORS: true }),
    new Promise<HTMLCanvasElement>((_, reject) => setTimeout(() => reject(new Error('截图超时')), 15000)),
  ])
}

function downloadDataUrl(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

async function writeImageNative(): Promise<string> {
  const canvas = await capture()
  const base64 = canvas.toDataURL('image/png').split(',')[1] ?? ''
  const res = await Filesystem.writeFile({
    path: reportFilename(),
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  })
  return res.uri
}

async function share() {
  try {
    if (isNative) {
      const uri = await writeImageNative()
      await Share.share({ title: '透析报告', text: summaryText.value, files: [uri] })
    } else {
      const canvas = await capture()
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
      })
      const file = new File([blob], reportFilename(), { type: 'image/png' })
      if (navigator.share) {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: '透析报告' })
        } else {
          await navigator.share({ title: '透析报告', text: summaryText.value })
        }
      } else {
        downloadDataUrl(canvas.toDataURL('image/png'), reportFilename())
      }
    }
  } catch (err) {
    // 用户取消分享等，忽略
    console.error(err)
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar class="no-print" title="透析报告" left-text="返回" left-arrow @click-left="router.back()">
      <template #right>
        <van-icon name="share-o" size="22" color="#07c160" style="cursor: pointer" @click="share" />
      </template>
    </van-nav-bar>

    <div ref="reportEl" style="background: #fff; border-radius: 10px; padding: 16px">
      <div style="text-align: center; margin-bottom: 14px">
        <div style="font-size: 18px; font-weight: 700">透析报告</div>
        <div class="muted" style="margin-top: 4px">
          {{ patient?.name }} · {{ session?.date }}<template v-if="session?.operator"> · 记录人 {{ session.operator }}</template>
        </div>
        <div v-if="patient?.birthday" class="muted">
          年龄约 {{ calcAge(patient.birthday) ?? '—' }} 岁
        </div>
      </div>

      <div class="report-flow">
        <div class="rnode">
          <div class="rlabel">上机前体重</div>
          <div class="rval">{{ fmt(comp?.preWeightActual) }}<small>kg</small></div>
        </div>
        <div class="rmid">
          <div class="rarrow">↓</div>
          <div v-if="comp?.actualUf != null" class="rdiff">脱 {{ fmt(comp.actualUf) }}L</div>
        </div>
        <div class="rnode">
          <div class="rlabel">下机后体重</div>
          <div class="rval">{{ fmt(comp?.postWeightActual) }}<small>kg</small></div>
        </div>
      </div>
      <div class="report-uf">
        <div class="ruf"><span>医生设定脱水量</span><b>{{ fmt(session?.doctorUf) }} ml</b></div>
        <div class="ruf"><span>计划脱水量</span><b>{{ fmt(comp?.planUf) }} L</b></div>
        <div class="ruf"><span>实际脱水量</span><b>{{ fmt(comp?.actualUf) }} L</b></div>
      </div>
      <div class="report-meta">干体重 {{ fmt(comp?.effectiveDryWeight) }}kg · 回水 {{ comp?.rinseBackMl ?? '—' }}ml · 机器超滤 {{ fmt(comp?.machineUf) }}L</div>

      <div style="height: 1px; background: #ebedf0; margin: 14px 0"></div>
      <div class="card-title" style="margin-bottom: 6px">血压曲线</div>
      <BaseChart v-if="bps.length" :option="bpOption" />
      <div v-else class="muted" style="padding: 10px 0">暂无血压记录</div>
      <div v-if="bps.length" style="margin-top: 6px">
        <div v-for="bp in bps" :key="bp.id" class="kv">
          <span class="k">{{ formatTime(bp.measuredAt) }}</span>
          <span class="v">{{ bp.systolic }} / {{ bp.diastolic }} mmHg
            <van-tag :type="assessBp(bp.systolic, bp.diastolic).color" style="margin-left: 6px">{{ assessBp(bp.systolic, bp.diastolic).text }}</van-tag>
          </span>
        </div>
      </div>

      <div style="height: 1px; background: #ebedf0; margin: 14px 0"></div>
      <div class="kv">
        <span class="k">血糖</span>
        <span class="v">{{ glucoses.length ? `${fmt(glucoses[0].value)} mmol/L` : '—' }}
          <van-tag v-if="glucoses.length" :type="assessGlucose(glucoses[0].value).color" style="margin-left: 6px">{{ assessGlucose(glucoses[0].value).text }}</van-tag>
        </span>
      </div>
      <div v-if="flows.length" style="margin: 8px 0 0">
        <div class="muted" style="margin-bottom: 4px">血流量</div>
        <div v-for="f in flows" :key="f.id" class="kv">
          <span class="k">{{ formatTime(f.measuredAt) }}</span>
          <span class="v">{{ f.value }} ml/min</span>
        </div>
      </div>
      <div class="kv">
        <span class="k">不良反应</span>
        <span class="v">{{ reactionText }}</span>
      </div>
      <div v-if="session?.notes" class="muted" style="margin-top: 8px">备注：{{ session.notes }}</div>
    </div>
  </div>
</template>

<style scoped>
.report-flow {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f7f8fa;
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 12px;
}
.rnode {
  flex: 1;
  text-align: center;
}
.rlabel {
  font-size: 12px;
  color: #969799;
}
.rval {
  font-size: 22px;
  font-weight: 700;
  color: #323233;
}
.rval small {
  font-size: 12px;
  font-weight: 500;
  color: #969799;
  margin-left: 2px;
}
.rmid {
  text-align: center;
  min-width: 56px;
}
.rarrow {
  font-size: 20px;
  color: #07c160;
  line-height: 1;
}
.rdiff {
  font-size: 12px;
  color: #07c160;
  font-weight: 600;
  margin-top: 2px;
}
.report-uf {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}
.ruf {
  flex: 1;
  background: #e8f7ef;
  border-radius: 12px;
  padding: 12px 6px;
  text-align: center;
}
.ruf span {
  display: block;
  font-size: 12px;
  color: #07c160;
}
.ruf b {
  font-size: 22px;
  font-weight: 700;
  color: #07c160;
}
.report-meta {
  font-size: 12px;
  color: #969799;
  text-align: center;
}
</style>
