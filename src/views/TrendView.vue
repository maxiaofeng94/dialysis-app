<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { repository } from '../repo'
import { DEFAULT_PATIENT_ID } from '../constants'
import { formatTime } from '../utils/format'
import { computeSession, getEffectiveDryWeight } from '../utils/calc'
import BaseChart from '../components/BaseChart.vue'
import type { DryWeight, DialysisSession } from '../types'

const active = ref(0)
const dryWeights = ref<DryWeight[]>([])
const sessions = ref<DialysisSession[]>([])
const bpTrend = ref<{ time: number; date: string; systolic: number; diastolic: number }[]>([])
const gluTrend = ref<{ time: number; date: string; value: number }[]>([])

onMounted(load)

async function load() {
  dryWeights.value = await repository.listDryWeights(DEFAULT_PATIENT_ID)
  sessions.value = await repository.listSessions(DEFAULT_PATIENT_ID)
  await loadBpTrend()
  await loadGlucoseTrend()
}

async function loadBpTrend() {
  const recent = sessions.value.slice(0, 30)
  const all: { time: number; date: string; systolic: number; diastolic: number }[] = []
  for (const s of recent) {
    const list = await repository.listBloodPressures(s.id)
    for (const bp of list) {
      all.push({ time: bp.measuredAt, date: s.date, systolic: bp.systolic, diastolic: bp.diastolic })
    }
  }
  all.sort((a, b) => a.time - b.time)
  bpTrend.value = all
}

async function loadGlucoseTrend() {
  const recent = sessions.value.slice(0, 30)
  const all: { time: number; date: string; value: number }[] = []
  for (const s of recent) {
    const list = await repository.listBloodGlucoses(s.id)
    for (const g of list) {
      all.push({ time: g.measuredAt, date: s.date, value: g.value })
    }
  }
  all.sort((a, b) => a.time - b.time)
  gluTrend.value = all
}

const weightOption = computed(() => {
  const recent = [...sessions.value].sort((a, b) => a.date.localeCompare(b.date)).slice(-30)
  const dates = recent.map((s) => s.date.slice(5))
  const pre = recent.map((s) => computeSession(s, getEffectiveDryWeight(dryWeights.value, s.date)).preWeightActual)
  const post = recent.map((s) => computeSession(s, getEffectiveDryWeight(dryWeights.value, s.date)).postWeightActual)
  const dry = recent.map((s) => getEffectiveDryWeight(dryWeights.value, s.date))
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['上机前', '下机后', '干体重'] },
    grid: { left: 42, right: 20, top: 48, bottom: 32 },
    xAxis: { type: 'category', data: dates },
    yAxis: { type: 'value', name: 'kg' },
    series: [
      { name: '上机前', type: 'line', smooth: true, color: '#ee0a24', data: pre },
      { name: '下机后', type: 'line', smooth: true, color: '#1989fa', data: post },
      { name: '干体重', type: 'line', smooth: true, color: '#07c160', data: dry, lineStyle: { type: 'dashed' } },
    ],
  }
})

const bpOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['高压', '低压'] },
  grid: { left: 42, right: 20, top: 48, bottom: 66 },
  xAxis: { type: 'category', data: bpTrend.value.map((b) => `${b.date.slice(5)} ${formatTime(b.time)}`), axisLabel: { rotate: 30 } },
  yAxis: { type: 'value', name: 'mmHg' },
  series: [
    { name: '高压', type: 'line', smooth: true, color: '#ee0a24', data: bpTrend.value.map((b) => b.systolic) },
    { name: '低压', type: 'line', smooth: true, color: '#1989fa', data: bpTrend.value.map((b) => b.diastolic) },
  ],
}))

const gluOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 16, itemHeight: 10, textStyle: { fontSize: 12 }, data: ['血糖'] },
  grid: { left: 42, right: 20, top: 48, bottom: 66 },
  xAxis: { type: 'category', data: gluTrend.value.map((g) => `${g.date.slice(5)} ${formatTime(g.time)}`), axisLabel: { rotate: 30 } },
  yAxis: { type: 'value', name: 'mmol/L' },
  series: [
    { name: '血糖', type: 'line', smooth: true, color: '#ee0a24', symbol: 'circle', symbolSize: 8, data: gluTrend.value.map((g) => g.value) },
  ],
}))
</script>

<template>
  <div class="page">
    <van-nav-bar title="趋势分析" :border="false" />
    <van-tabs v-model:active="active">
      <van-tab title="体重">
        <div class="card" style="margin-top: 12px">
          <div class="card-title">体重趋势（近 30 次）</div>
          <BaseChart v-if="sessions.length" :option="weightOption" />
          <van-empty v-else description="暂无数据" />
        </div>
      </van-tab>
      <van-tab title="血压">
        <div class="card" style="margin-top: 12px">
          <div class="card-title">血压趋势（近 30 次）</div>
          <BaseChart v-if="bpTrend.length" :option="bpOption" />
          <van-empty v-else description="暂无血压数据" />
        </div>
      </van-tab>
      <van-tab title="血糖">
        <div class="card" style="margin-top: 12px">
          <div class="card-title">血糖趋势（近 30 次）</div>
          <BaseChart v-if="gluTrend.length" :option="gluOption" />
          <van-empty v-else description="暂无血糖数据" />
        </div>
      </van-tab>
    </van-tabs>
  </div>
</template>
