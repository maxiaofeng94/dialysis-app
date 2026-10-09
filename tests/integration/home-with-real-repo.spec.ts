/**
 * 首页 × 真实本地仓储 · 端到端集成测试
 *
 * 与 tests/views/HomeView.spec.ts 的区别：**不 mock `src/repo`**。
 * HomeView 里 `import { repository } from '../repo'` 拿到的是那个「按登录态分发」的动态代理；
 * 测试环境恒为纯本地模式（isCloudConfigured=false），于是它自动落到真实的 `localRepository`，
 * 整条链路「组件 → 仓储代理 → Dexie/IndexedDB」都是真的，只有 Vant 的命令式弹层
 * （showToast/showConfirmDialog）保持真实但不会被触发，路由用内存 history 真实跳转。
 *
 * 数值断言一律用 `computeSession()` / `getEffectiveDryWeight()` 现算再比，
 * 避免把公式结果硬编码进测试（否则公式改了测试和实现会「一起错」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { defineComponent, h } from 'vue'
import Vant from 'vant'
import HomeView from '../../src/views/HomeView.vue'
import { db } from '../../src/db/database'
import { localRepository } from '../../src/repo/localRepository'
import { currentPatientId } from '../../src/stores/patient'
import { computeSession, getEffectiveDryWeight } from '../../src/utils/calc'
import { fmt, formatDateCN, todayStr, calcAge } from '../../src/utils/format'
import { makePatient, makeDryWeight, makeSession, resetIdSeq } from '../helpers/factories'
import type { DialysisSession, Patient } from '../../src/types'

/** 固定的「现在」：2024-06-15 10:00 本地时间（决定 todayStr 与新建记录的 date） */
const FIXED_NOW = new Date(2024, 5, 15, 10, 0, 0)

/** 预置数据：病人 + 两条不同月份的记录 + 两条干体重（其中一条尚未生效） */
const PATIENT: Patient = makePatient({
  id: 'patient-default', // 本地单机模式的固定病人 id
  name: '张三',
  birthday: '1950-06-01',
  wheelchairWeight: 20,
  rinseBackVolume: 300,
})
const DRY_WEIGHTS = [
  makeDryWeight({ id: 'dw-60', patientId: PATIENT.id, value: 60, effectiveDate: '2024-04-01', createdAt: 100 }),
  // 未来生效：按「今天」取有效干体重时不能被算进来
  makeDryWeight({ id: 'dw-59', patientId: PATIENT.id, value: 59, effectiveDate: '2024-07-01', createdAt: 200 }),
]
const MAY_SESSION = makeSession({
  id: 's-may',
  patientId: PATIENT.id,
  date: '2024-05-20',
  preWeightMeasured: 79.5,
  wheelchairWeightUsed: 20,
  rinseBackVolumeUsed: 300,
  status: 'completed',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})
const APRIL_SESSION = makeSession({
  id: 's-apr',
  patientId: PATIENT.id,
  date: '2024-04-10',
  preWeightMeasured: 80,
  wheelchairWeightUsed: 20,
  rinseBackVolumeUsed: 300,
  status: 'aborted',
  abortedAt: 1_700_000_100_000,
  abortTags: ['hypotension', 'other'],
  abortReason: '血压持续偏低',
  createdAt: 1_600_000_000_000,
  updatedAt: 1_600_000_000_000,
})

const Blank = defineComponent({ render: () => h('div') })

let wrapper: VueWrapper | null = null
let router: Router

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/session/:id', component: Blank },
      { path: '/settings', component: Blank },
    ],
  })
}

/** IndexedDB 的写入/读取是宏任务级异步：多刷几轮再断言，避免偶发时序 flake */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** 挂载首页并等待数据加载完成 */
async function mountHome(): Promise<VueWrapper> {
  router = makeRouter()
  await router.push('/')
  await router.isReady()
  wrapper = mount(HomeView, { global: { plugins: [Vant, router] } })
  await settle()
  return wrapper
}

/** 首页里「记录行」的容器（唯一带内联 cursor:pointer 的 div） */
function sessionRows(w: VueWrapper) {
  return w.findAll('div').filter((d) => (d.attributes('style') ?? '').includes('cursor: pointer'))
}

/** 把预置数据真正写进 IndexedDB */
async function seedData() {
  await localRepository.savePatient(PATIENT)
  for (const d of DRY_WEIGHTS) await localRepository.saveDryWeight(d)
  await localRepository.saveSession(MAY_SESSION)
  await localRepository.saveSession(APRIL_SESSION)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }) // 只 fake Date：定时器保持真实，IndexedDB 才不会被卡住
  vi.setSystemTime(FIXED_NOW)
  await db.delete()
  await db.open()
  resetIdSeq()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('首页 × 真实本地仓储 · 首屏渲染', () => {
  it('从 IndexedDB 读出档案卡：姓名、年龄徽标、干体重/轮椅/回水量', async () => {
    await seedData()
    const w = await mountHome()

    expect(w.find('.patient-card').exists()).toBe(true)
    expect(w.find('.patient-name').text()).toBe('张三')
    expect(w.find('.avatar').text()).toBe('张')

    // 年龄用 calcAge 现算（1950-06-01 在 2024-06-15 时是 74 岁）
    expect(w.find('.age-badge').text()).toBe(`${calcAge(PATIENT.birthday)} 岁`)

    const stats = w.findAll('.pstat-v').map((n) => n.text())
    expect(stats[0]).toBe(`${fmt(getEffectiveDryWeight(DRY_WEIGHTS, todayStr()))}kg`) // 未来生效的 59 不算
    expect(stats[1]).toBe(`${fmt(PATIENT.wheelchairWeight)}kg`)
    expect(stats[2]).toBe(`${PATIENT.rinseBackVolume}ml`)
    expect(stats[0]).toBe('60.0kg')
  })

  it('无档案时显示空状态（本地模式：引导去设置）', async () => {
    const w = await mountHome()

    expect(w.find('.patient-card').exists()).toBe(false)
    expect(w.text()).toContain('请先建立病人档案')
    expect(sessionRows(w)).toHaveLength(0)
  })
})

describe('首页 × 真实本地仓储 · 记录列表', () => {
  it('两条记录按月份分组渲染，标题为 YYYY-MM（仓储已按日期倒序）', async () => {
    await seedData()
    const w = await mountHome()

    const listed = await localRepository.listSessions(PATIENT.id)
    const expectedMonths = Array.from(new Set(listed.map((s) => s.date.slice(0, 7))))

    expect(w.findAll('.card-title').map((n) => n.text())).toEqual(expectedMonths)
    expect(expectedMonths).toEqual(['2024-05', '2024-04'])
    expect(sessionRows(w)).toHaveLength(2)
  })

  it('每行显示中文日期与状态标签，内容与库里那条一致', async () => {
    await seedData()
    const w = await mountHome()

    const rows = sessionRows(w)
    const texts = rows.map((r) => r.text())

    expect(texts[0]).toContain(formatDateCN(MAY_SESSION.date)) // 5月20日 周一
    expect(texts[0]).toContain('已完成')
    expect(texts[1]).toContain(formatDateCN(APRIL_SESSION.date))
    expect(texts[1]).toContain('已中止')
    // 中止行由 abortText 组合出中文文案
    expect(texts[1]).toContain('中止：低血压、血压持续偏低')
  })

  it('行内展示的数值与 computeSession() 现算结果一致', async () => {
    await seedData()
    const w = await mountHome()

    const listed = await localRepository.listSessions(PATIENT.id) // 倒序：5 月在前，4 月在后
    const dryWeights = await localRepository.listDryWeights(PATIENT.id)
    const rows = sessionRows(w)

    rows.forEach((row, i) => {
      const session = listed[i]
      // 与 HomeView 一样：历史记录按记录自己的日期取当时生效的干体重
      const computed = computeSession(session, getEffectiveDryWeight(dryWeights, session.date))
      expect(row.text()).toContain(`上机前实际 ${fmt(computed.preWeightActual)} kg`)
      expect(row.text()).toContain(`计划脱水 ${fmt(computed.planUf)} L`)
    })

    // 5 月那条：79.5 - 20 = 59.5；59.5 - 60 = -0.5 → 脱水量按 0 兜底
    // （回归：曾经照实显示「计划脱水 -0.5 L」，会被读成「要往身体里输 0.5 升」）
    expect(rows[0].text()).toContain('59.5')
    expect(rows[0].text()).toContain('计划脱水 0.0 L')
  })

  it('没有记录时显示空状态文案', async () => {
    await localRepository.savePatient(PATIENT)
    const w = await mountHome()

    expect(w.find('.patient-card').exists()).toBe(true)
    expect(w.text()).toContain('暂无透析记录，点击上方快速创建')
  })
})

describe('首页 × 真实本地仓储 · 快速创建真的写库', () => {
  it('填体重后点「立即创建」：IndexedDB 里多出一条，字段来自输入与档案快照', async () => {
    await seedData()
    const w = await mountHome()
    expect(await localRepository.listSessions(PATIENT.id)).toHaveLength(2)

    await w.find('input.quick-input').setValue('80.5')
    await w.find('.quick-btn').trigger('click')
    await settle()

    const listed = await localRepository.listSessions(PATIENT.id)
    expect(listed).toHaveLength(3)

    const created = listed[0] // 日期是「今天」，倒序排在第一条
    expect(created).toMatchObject({
      patientId: currentPatientId.value,
      date: todayStr(),
      preWeightMeasured: 80.5, // 直接存「含轮椅」的输入值
      postWeightMeasured: null,
      wheelchairWeightUsed: PATIENT.wheelchairWeight, // 建档时的快照，后续改档案不影响历史
      rinseBackVolumeUsed: PATIENT.rinseBackVolume,
      status: 'ongoing',
      abortedAt: null,
      abortTags: [],
      abortReason: null,
      operator: null,
      doctorUf: null,
      notes: null,
      createdAt: FIXED_NOW.getTime(),
      updatedAt: FIXED_NOW.getTime(),
    })
    // 真的能按 id 读回来，并且跳转到了这条记录的详情页
    expect(await localRepository.getSession(created.id)).toEqual(created)
    expect(router.currentRoute.value.path).toBe(`/session/${created.id}`)
  })

  it('创建后重新挂载首页：新记录出现在列表里（数据真的落盘了）', async () => {
    await seedData()
    const w = await mountHome()

    await w.find('input.quick-input').setValue('81')
    await w.find('.quick-btn').trigger('click')
    await settle()
    w.unmount()

    const again = await mountHome()
    const rows = sessionRows(again)
    expect(rows).toHaveLength(3)
    expect(again.findAll('.card-title').map((n) => n.text())).toEqual(['2024-06', '2024-05', '2024-04'])
    // 最新那条就是刚创建的：81 - 20 = 61，61 - 60 = 1
    const dryWeights = await localRepository.listDryWeights(PATIENT.id)
    const [newest] = await localRepository.listSessions(PATIENT.id)
    const computed = computeSession(newest, getEffectiveDryWeight(dryWeights, newest.date))
    expect(rows[0].text()).toContain(`上机前实际 ${fmt(computed.preWeightActual)} kg`)
    expect(rows[0].text()).toContain('进行中')
  })

  it('快速创建预览的两个数字与 computeSession() 的结果一致（不硬编码公式结果）', async () => {
    await seedData()
    const w = await mountHome()

    await w.find('input.quick-input').setValue('80.5')
    await settle()

    const dryWeights = await localRepository.listDryWeights(PATIENT.id)
    const dryToday = getEffectiveDryWeight(dryWeights, todayStr())
    // 用一条「同输入的假记录」跑真实计算函数，得到期望值
    const expected = computeSession(
      makeSession({
        patientId: PATIENT.id,
        date: todayStr(),
        preWeightMeasured: 80.5,
        wheelchairWeightUsed: PATIENT.wheelchairWeight,
        rinseBackVolumeUsed: PATIENT.rinseBackVolume,
      }),
      dryToday,
    )

    const preview = w.findAll('.stat-value').map((n) => n.text())
    expect(preview[0]).toBe(`${fmt(expected.preWeightActual)} kg`)
    expect(preview[1]).toBe(`${fmt(expected.planUf)} L`)
    expect(preview[0]).toBe('60.5 kg') // 80.5 - 20
    expect(preview[1]).toBe('0.5 L') // 60.5 - 60
  })

  it('未填体重时点创建不写库（弹层 API 被真实调用但不会误写数据）', async () => {
    await seedData()
    const w = await mountHome()

    // 这里只断言「没有写库」：真实 showConfirmDialog 会往 body 挂弹层，随后由 setup 的 afterEach 清掉
    await w.find('.quick-btn').trigger('click')
    await settle()

    expect(await localRepository.listSessions(PATIENT.id)).toHaveLength(2)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('连点两次「立即创建」只写一条记录（H3：创建中在途，第二次点击必须被忽略）', async () => {
    await seedData()
    const w = await mountHome()

    await w.find('input.quick-input').setValue('80.5')
    const btn = w.find('.quick-btn')
    // 两次点击落在同一轮事件循环里（真实用户连点就是这个时序），中间没有 await
    await Promise.all([btn.trigger('click'), btn.trigger('click')])
    await settle()

    expect(await localRepository.listSessions(PATIENT.id)).toHaveLength(3)
    expect(router.currentRoute.value.path.startsWith('/session/')).toBe(true)
  })
})

describe('首页 × 真实本地仓储 · 计算口径与仓储一致', () => {
  it('干体重卡片、列表与 computeSession 用的是同一套干体重取值规则', async () => {
    await seedData()
    const w = await mountHome()

    const dryWeights = await localRepository.listDryWeights(PATIENT.id)
    const listed = await localRepository.listSessions(PATIENT.id)

    // 卡片：今天的有效干体重
    expect(fmt(getEffectiveDryWeight(dryWeights, todayStr()))).toBe('60.0')
    // 4 月那条记录：4/10 时 60kg 已生效（4/1 起），未来那条 59 不参与
    const april = listed.find((s) => s.id === APRIL_SESSION.id) as DialysisSession
    expect(getEffectiveDryWeight(dryWeights, april.date)).toBe(60)
    expect(computeSession(april, 60).planUf).toBe(computeSession(april, getEffectiveDryWeight(dryWeights, april.date)).planUf)
  })

  it('病人档案改动后新建的记录用新快照，老记录仍是老数值（历史不被改写）', async () => {
    await seedData()
    const w = await mountHome()

    // 把轮椅重量从 20 改成 25（模拟设置页改了档案）
    await localRepository.savePatient({ ...PATIENT, wheelchairWeight: 25, rinseBackVolume: 400 })
    w.unmount()
    const again = await mountHome()

    await again.find('input.quick-input').setValue('80')
    await again.find('.quick-btn').trigger('click')
    await settle()

    const listed = await localRepository.listSessions(PATIENT.id)
    const newest = listed[0]
    expect(newest.wheelchairWeightUsed).toBe(25)
    expect(newest.rinseBackVolumeUsed).toBe(400)
    expect(computeSession(newest, 60).preWeightActual).toBe(55) // 80 - 25

    // 老记录（5 月那条）仍按当时的 20kg 快照计算
    const may = listed.find((s) => s.id === MAY_SESSION.id) as DialysisSession
    expect(may.wheelchairWeightUsed).toBe(20)
    expect(computeSession(may, 60).preWeightActual).toBe(59.5)
  })
})
