import { describe, it, expect } from 'vitest'
import {
  round1,
  getEffectiveDryWeight,
  calcWeights,
  computeSession,
  resolveEffectiveConfig,
  snapshotConfigInto,
} from '../../src/utils/calc'
import { makeDryWeight, makePatient, makeSession, resetIdSeq } from '../helpers/factories'

describe('round1', () => {
  it('保留一位小数（四舍五入）', () => {
    expect(round1(1.25)).toBe(1.3)
    expect(round1(1.24)).toBe(1.2)
    expect(round1(0.05)).toBe(0.1) // Math.round(0.5) = 1
    expect(round1(-1.25)).toBe(-1.2) // Math.round(-12.5) = -12
  })

  it('整数原样返回', () => {
    expect(round1(60)).toBe(60)
    expect(round1(0)).toBe(0)
  })
})

describe('getEffectiveDryWeight', () => {
  it('空列表返回 null', () => {
    expect(getEffectiveDryWeight([], '2024-06-01')).toBeNull()
  })

  it('取生效日期不晚于目标日期的最新一条', () => {
    resetIdSeq()
    const list = [
      makeDryWeight({ id: 'a', value: 61, effectiveDate: '2024-01-01' }),
      makeDryWeight({ id: 'b', value: 60, effectiveDate: '2024-03-01' }),
      makeDryWeight({ id: 'c', value: 59, effectiveDate: '2024-05-01' }),
    ]
    expect(getEffectiveDryWeight(list, '2024-04-15')).toBe(60)
    expect(getEffectiveDryWeight(list, '2024-05-01')).toBe(59) // 当天生效即算数
    expect(getEffectiveDryWeight(list, '2024-06-30')).toBe(59)
  })

  it('同一天生效的取后创建的那条', () => {
    const list = [
      makeDryWeight({ id: 'old', value: 60, effectiveDate: '2024-03-01', createdAt: 100 }),
      makeDryWeight({ id: 'new', value: 62, effectiveDate: '2024-03-01', createdAt: 200 }),
    ]
    expect(getEffectiveDryWeight(list, '2024-03-01')).toBe(62)
  })

  it('全部晚于目标日期时，用最早生效的一条兜底', () => {
    const list = [
      makeDryWeight({ id: 'a', value: 61, effectiveDate: '2024-03-01' }),
      makeDryWeight({ id: 'b', value: 58, effectiveDate: '2024-07-01' }),
      makeDryWeight({ id: 'c', value: 60, effectiveDate: '2024-05-01' }),
    ]
    expect(getEffectiveDryWeight(list, '2024-01-01')).toBe(61)
  })

  it('不修改传入数组的顺序（内部先拷贝）', () => {
    const list = [
      makeDryWeight({ id: 'a', value: 61, effectiveDate: '2024-01-01' }),
      makeDryWeight({ id: 'b', value: 60, effectiveDate: '2024-03-01' }),
    ]
    const before = list.map((d) => d.id)
    getEffectiveDryWeight(list, '2024-02-01')
    expect(list.map((d) => d.id)).toEqual(before)
  })
})

describe('calcWeights', () => {
  it('常规计算：实际体重 / 计划脱水 / 实际脱水 / 机器脱水量', () => {
    const r = calcWeights(80, 78, 20, 300, 60)
    expect(r.preWeightActual).toBe(60)
    expect(r.postWeightActual).toBe(58)
    expect(r.planUf).toBe(0)
    expect(r.actualUf).toBe(2)
    expect(r.rinseBackMl).toBe(300)
    expect(r.machineUf).toBe(0.3) // 计划脱水 + 回水量/1000
    expect(r.effectiveDryWeight).toBe(60)
  })

  it('未测量上机前体重时，所有推导值都为 null', () => {
    const r = calcWeights(null, 78, 20, 300, 60)
    expect(r.preWeightActual).toBeNull()
    expect(r.postWeightActual).toBe(58)
    expect(r.planUf).toBeNull()
    expect(r.actualUf).toBeNull()
    expect(r.machineUf).toBeNull()
  })

  it('没有干体重时计划脱水量为 null，但实际脱水仍可算', () => {
    const r = calcWeights(80, 78.5, 20, 300, null)
    expect(r.preWeightActual).toBe(60)
    expect(r.planUf).toBeNull()
    expect(r.machineUf).toBeNull()
    expect(r.actualUf).toBe(1.5)
    expect(r.effectiveDryWeight).toBeNull()
  })

  it('浮点边界：0.1 + 0.2 类误差被规整到一位小数', () => {
    const r = calcWeights(80.15, 79.05, 20.1, 300, 59.95)
    expect(r.preWeightActual).toBe(60.1) // 80.15 - 20.1 = 60.049999…
    expect(r.postWeightActual).toBe(59) // 79.05 - 20.1 = 58.95 → 59（round1 语义）
    expect(r.planUf).toBe(0.1) // 60.05 → 0.1
  })

  // 实测（Playwright 打测试库）发现：上机前体重低于干体重时，界面会显示「计划脱水 -20.0 L」，
  // 家属会读成「要往身体里输 20 升」。三个脱水量一律按 0 兜底。
  it('上机前体重低于干体重 → 计划脱水按 0 兜底，机器超滤只算回水量', () => {
    const r = calcWeights(80, 78, 20, 300, 80) // 实际体重 60，干体重 80 → 算式 -20
    expect(r.preWeightActual).toBe(60)
    expect(r.planUf).toBe(0) // 回归：曾经是 -20
    expect(r.machineUf).toBe(0.3) // 回归：曾经是 -19.7
  })

  it('下机后比上机前还重 → 实际脱水按 0 兜底', () => {
    const r = calcWeights(80, 82, 20, 300, 60)
    expect(r.preWeightActual).toBe(60)
    expect(r.postWeightActual).toBe(62)
    expect(r.actualUf).toBe(0) // 回归：曾经是 -2
  })

  it('只钳制脱水量，体重本身照实显示（那是原始测量值）', () => {
    // 称重 15kg、轮椅 20kg → 实际体重 -5kg（显然是填错了，但界面要照实显示这个 -5）
    const r = calcWeights(15, 12, 20, 0, 60)
    expect(r.preWeightActual).toBe(-5) // 15 - 20
    expect(r.postWeightActual).toBe(-8) // 12 - 20
    expect(r.planUf).toBe(0) // -5 - 60 < 0 → 兜底
    expect(r.actualUf).toBe(3) // -5 - (-8) = 3，本身是正数，正常保留
    expect(r.machineUf).toBe(0) // 0 + 回水 0
  })

  it('正数脱水量不受影响（钳制不能把正常值改小）', () => {
    const r = calcWeights(85, 82.5, 22, 400, 60.5)
    expect(r.planUf).toBe(2.5)
    expect(r.actualUf).toBe(2.5)
    expect(r.machineUf).toBe(2.9)
  })
})

describe('computeSession', () => {
  it('从记录对象取出字段参与计算', () => {
    const s = makeSession({ preWeightMeasured: 80, postWeightMeasured: 77, wheelchairWeightUsed: 20, rinseBackVolumeUsed: 300 })
    const r = computeSession(s, 58)
    expect(r.preWeightActual).toBe(60)
    expect(r.actualUf).toBe(3)
    expect(r.planUf).toBe(2)
    expect(r.machineUf).toBe(2.3)
  })

  it('干体重为 null 时计划脱水为 null（记录可无干体重）', () => {
    const s = makeSession({ preWeightMeasured: 80 })
    expect(computeSession(s, null).planUf).toBeNull()
  })
})

/**
 * 需求①：进行中的记录实时跟随「当前病人档案」的轮椅及衣物重量 / 回水量，
 * 完成或中止时把档案值固化进记录快照，历史数字从此不变。
 *
 * 守的缺陷：档案值原来是**创建时一次性快照**的，天气转冷加了衣服、家属把 13.4 改成 13.5，
 * 进行中的那条记录仍按 13.4 算实际体重，用户只能把整条记录删掉重录。
 */
describe('resolveEffectiveConfig', () => {
  it('进行中 + 有档案：用档案值，并标记 fromPatientProfile', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const p = makePatient({ wheelchairWeight: 13.5, rinseBackVolume: 400 })

    const cfg = resolveEffectiveConfig(s, p)

    expect(cfg).toEqual({ wheelchairWeight: 13.5, rinseMl: 400, fromPatientProfile: true })
  })

  it('已完成：一律用记录里的快照（历史不可变），哪怕档案已改', () => {
    const s = makeSession({ status: 'completed', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const p = makePatient({ wheelchairWeight: 13.5, rinseBackVolume: 400 })

    const cfg = resolveEffectiveConfig(s, p)

    expect(cfg).toEqual({ wheelchairWeight: 13.4, rinseMl: 300, fromPatientProfile: false })
  })

  it('已中止：同样用快照（中止也是「退出进行中」）', () => {
    const s = makeSession({ status: 'aborted', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const p = makePatient({ wheelchairWeight: 13.5, rinseBackVolume: 400 })

    expect(resolveEffectiveConfig(s, p)).toEqual({
      wheelchairWeight: 13.4,
      rinseMl: 300,
      fromPatientProfile: false,
    })
  })

  // ⚠️ 最要命的一条：离线且本机没有缓存、或还没建档案时档案读不到。
  // 如果这时把重量当成 0，实际体重会凭空多出「一辆轮椅」（80kg → 80.0 而不是 66.6）。
  it('档案为 null 时回退快照，绝不能算成 0', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })

    expect(resolveEffectiveConfig(s, null)).toEqual({
      wheelchairWeight: 13.4,
      rinseMl: 300,
      fromPatientProfile: false,
    })
    // undefined 与 null 同义（页面里的 patient ref 初始值就是 null，读失败时是 undefined）
    expect(resolveEffectiveConfig(s, undefined).wheelchairWeight).toBe(13.4)
  })

  it('档案存在但字段缺失（旧云端行 / 脏数据）时按字段回退快照，不当成 0', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const dirty = { wheelchairWeight: undefined, rinseBackVolume: undefined } as unknown as Parameters<
      typeof resolveEffectiveConfig
    >[1]

    const cfg = resolveEffectiveConfig(s, dirty)

    expect(cfg.wheelchairWeight).toBe(13.4)
    expect(cfg.rinseMl).toBe(300)
  })

  it('快照字段缺失（老数据没有这两列）时按 0 兜底，不产出 NaN', () => {
    const s = makeSession({ status: 'completed' })
    const legacy = { ...s, wheelchairWeightUsed: undefined, rinseBackVolumeUsed: undefined } as unknown as Parameters<
      typeof resolveEffectiveConfig
    >[0]

    const cfg = resolveEffectiveConfig(legacy, null)

    expect(cfg.wheelchairWeight).toBe(0)
    expect(cfg.rinseMl).toBe(0)
    expect(Number.isNaN(cfg.wheelchairWeight)).toBe(false)
  })

  it('档案里的 0 是「真的 0」（轮椅 0kg），不能被 ?? 当成缺失而回退快照', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const p = makePatient({ wheelchairWeight: 0, rinseBackVolume: 0 })

    expect(resolveEffectiveConfig(s, p)).toEqual({ wheelchairWeight: 0, rinseMl: 0, fromPatientProfile: true })
  })
})

describe('computeSession（第三参数 patient）', () => {
  it('进行中：改档案后 preWeightActual / postWeightActual 立即跟着变', () => {
    const s = makeSession({
      status: 'ongoing',
      preWeightMeasured: 80,
      postWeightMeasured: 77,
      wheelchairWeightUsed: 13.4,
      rinseBackVolumeUsed: 300,
    })

    const before = computeSession(s, 60, makePatient({ wheelchairWeight: 13.4, rinseBackVolume: 300 }))
    const after = computeSession(s, 60, makePatient({ wheelchairWeight: 10, rinseBackVolume: 300 }))

    expect(before.preWeightActual).toBe(66.6) // 80 - 13.4
    expect(after.preWeightActual).toBe(70) // 80 - 10：改档立即生效，不用删记录重录
    expect(before.postWeightActual).toBe(63.6)
    expect(after.postWeightActual).toBe(67)
  })

  it('进行中：改档案的回水量后机器超滤跟着变（回水参与机器超滤）', () => {
    const s = makeSession({
      status: 'ongoing',
      preWeightMeasured: 80,
      postWeightMeasured: 77,
      wheelchairWeightUsed: 20,
      rinseBackVolumeUsed: 300,
    })

    const r = computeSession(s, 60, makePatient({ wheelchairWeight: 20, rinseBackVolume: 500 }))

    expect(r.rinseBackMl).toBe(500)
    expect(r.machineUf).toBe(0.5) // 计划 0 + 0.5
  })

  it('已完成：改档案后数字不变（报告给医生看过的数不能变）', () => {
    const s = makeSession({
      status: 'completed',
      preWeightMeasured: 80,
      postWeightMeasured: 77,
      wheelchairWeightUsed: 13.4,
      rinseBackVolumeUsed: 300,
    })

    const r = computeSession(s, 60, makePatient({ wheelchairWeight: 10, rinseBackVolume: 500 }))

    expect(r.preWeightActual).toBe(66.6) // 仍是快照 13.4，不是 80-10=70
    expect(r.postWeightActual).toBe(63.6)
    expect(r.rinseBackMl).toBe(300) // 不是 500
    expect(r.planUf).toBe(6.6) // 66.6 - 60
    expect(r.machineUf).toBe(6.9) // 计划 6.6 + 回水 0.3（回水也跟着快照走）
  })

  it('不传 patient（老调用方 / 首页历史卡片）时行为与改动前一致：用快照', () => {
    const s = makeSession({ preWeightMeasured: 80, wheelchairWeightUsed: 20, rinseBackVolumeUsed: 300 })

    const r = computeSession(s, 60)

    expect(r.preWeightActual).toBe(60)
    expect(r.rinseBackMl).toBe(300)
  })

  it('传 null（档案读不到）时回退快照，不会把体重多减一辆轮椅', () => {
    const s = makeSession({
      status: 'ongoing',
      preWeightMeasured: 80,
      wheelchairWeightUsed: 13.4,
      rinseBackVolumeUsed: 300,
    })

    const r = computeSession(s, 60, null)

    expect(r.preWeightActual).toBe(66.6) // 80 - 13.4，而不是 80 - 0
  })
})

/**
 * 需求①的第二半：标记完成 / 中止那一刻把当前档案固化进快照。
 *
 * 守的缺陷：若不固化，快照会停在一个用户根本没确认过的旧值上；
 * 而「进行中实时跟随档案」意味着完成后的历史数字可能跟着之后的档案改动漂移。
 */
describe('snapshotConfigInto', () => {
  it('有档案时把档案的轮椅及衣物重量 / 回水量写进记录快照', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const p = makePatient({ wheelchairWeight: 13.5, rinseBackVolume: 400 })

    snapshotConfigInto(s, p)

    expect(s.wheelchairWeightUsed).toBe(13.5)
    expect(s.rinseBackVolumeUsed).toBe(400)
  })

  // ⚠️ 档案读不到时**一个字段都不能动**：写成 0 就等于把「一辆轮椅」永久抹掉，
  // 而且这次写库之后历史数字再也改不回来了。
  it('档案为 null 时完全不动记录（不能清成 0）', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })

    snapshotConfigInto(s, null)
    snapshotConfigInto(s, undefined)

    expect(s.wheelchairWeightUsed).toBe(13.4)
    expect(s.rinseBackVolumeUsed).toBe(300)
  })

  it('档案字段缺失时保留原快照（不覆盖成 0）', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const dirty = { wheelchairWeight: undefined, rinseBackVolume: undefined } as unknown as Parameters<
      typeof snapshotConfigInto
    >[1]

    snapshotConfigInto(s, dirty)

    expect(s.wheelchairWeightUsed).toBe(13.4)
    expect(s.rinseBackVolumeUsed).toBe(300)
  })

  it('档案里的 0 会照实固化（轮椅 0kg 是合法配置）', () => {
    const s = makeSession({ status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })

    snapshotConfigInto(s, makePatient({ wheelchairWeight: 0, rinseBackVolume: 0 }))

    expect(s.wheelchairWeightUsed).toBe(0)
    expect(s.rinseBackVolumeUsed).toBe(0)
  })

  it('只改快照字段，不碰 status / 体重测量值', () => {
    const s = makeSession({
      status: 'ongoing',
      preWeightMeasured: 80,
      postWeightMeasured: 77,
      wheelchairWeightUsed: 13.4,
      rinseBackVolumeUsed: 300,
    })

    snapshotConfigInto(s, makePatient({ wheelchairWeight: 13.5, rinseBackVolume: 400 }))

    expect(s.status).toBe('ongoing')
    expect(s.preWeightMeasured).toBe(80)
    expect(s.postWeightMeasured).toBe(77)
  })

  /**
   * 端到端串起来：进行中改档 → 数字变 → 标记完成（固化）→ 之后改档不再影响。
   * 这条最容易「假绿」：任何一环缺失（不固化 / 固化后仍读档案）都会让它红。
   */
  it('改档后标记完成：快照=新值，且之后改档案不再影响这条记录', () => {
    const s = makeSession({
      status: 'ongoing',
      preWeightMeasured: 80,
      postWeightMeasured: 77,
      wheelchairWeightUsed: 13.4,
      rinseBackVolumeUsed: 300,
    })
    const newProfile = makePatient({ wheelchairWeight: 10, rinseBackVolume: 500 })

    // 1) 进行中：跟着新档案走
    expect(computeSession(s, 60, newProfile).preWeightActual).toBe(70)

    // 2) 标记完成这一刻固化（SessionView.persistStatus 的做法）
    snapshotConfigInto(s, newProfile)
    s.status = 'completed'

    // 3) 完成后的数字就是固化时的值
    expect(computeSession(s, 60, newProfile).preWeightActual).toBe(70)
    expect(s.wheelchairWeightUsed).toBe(10)

    // 4) 之后档案又改了：这条已完成记录的数字纹丝不动
    const laterProfile = makePatient({ wheelchairWeight: 15, rinseBackVolume: 800 })
    const frozen = computeSession(s, 60, laterProfile)
    expect(frozen.preWeightActual).toBe(70) // 不是 65（80-15）
    expect(frozen.rinseBackMl).toBe(500) // 不是 800
  })
})

/**
 * 评审 S2：**跨病人不得串用档案**（`calc` 层的第二道防线）。
 *
 * 页面层已经在 `load()` 里拦截并回首页，但 `calc` 是纯函数、被四个页面共用，
 * 必须有自己的一致性检查 —— 否则任何一个调用点漏了校验（或将来新增一个页面），
 * 就会把**另一个病人**的轮椅重量算进这条记录。
 *
 * 反例（评审实测）：记录属于 patient-A（快照 13.4kg），当前病人被切成 patient-B（25kg），
 * 上机前实际算成 80 − 25 = 55，而正确值是 80 − 13.4 = 66.6。
 */
describe('resolveEffectiveConfig / snapshotConfigInto · 跨病人归属校验（评审 S2）', () => {
  const sessionOfA = () =>
    makeSession({
      id: 's1',
      patientId: 'patient-A',
      status: 'ongoing',
      preWeightMeasured: 80,
      wheelchairWeightUsed: 13.4,
      rinseBackVolumeUsed: 300,
    })

  it('档案不属于这条记录：回退快照，不采用别的病人的重量', () => {
    const cfg = resolveEffectiveConfig(sessionOfA(), makePatient({ id: 'patient-B', wheelchairWeight: 25 }))

    expect(cfg).toEqual({ wheelchairWeight: 13.4, rinseMl: 300, fromPatientProfile: false })
  })

  it('跨病人时实际体重按快照算（66.6，不是 55）', () => {
    const comp = computeSession(sessionOfA(), 60, makePatient({ id: 'patient-B', wheelchairWeight: 25 }))

    expect(comp.preWeightActual).toBe(66.6)
  })

  it('归属一致时照常跟随档案（不能把正常路径一起关掉）', () => {
    const cfg = resolveEffectiveConfig(sessionOfA(), makePatient({ id: 'patient-A', wheelchairWeight: 25 }))

    expect(cfg).toEqual({ wheelchairWeight: 25, rinseMl: 300, fromPatientProfile: true })
  })

  it('snapshotConfigInto 跨病人时不写入（否则会把 B 的重量固化进 A 的记录）', () => {
    const s = sessionOfA()
    snapshotConfigInto(s, makePatient({ id: 'patient-B', wheelchairWeight: 25 }))

    expect(s.wheelchairWeightUsed).toBe(13.4)
    expect(s.rinseBackVolumeUsed).toBe(300)
  })

  it('snapshotConfigInto 归属一致时正常写入', () => {
    const s = sessionOfA()
    snapshotConfigInto(s, makePatient({ id: 'patient-A', wheelchairWeight: 25, rinseBackVolume: 800 }))

    expect(s.wheelchairWeightUsed).toBe(25)
    expect(s.rinseBackVolumeUsed).toBe(800)
  })

  it('任一侧没有 id 时不做归属判断（老数据 / 本地单机没有 uuid，不能因此全废掉）', () => {
    // 记录没有 patientId（极老的本地数据）
    const s = makeSession({ patientId: '', status: 'ongoing', wheelchairWeightUsed: 13.4, rinseBackVolumeUsed: 300 })
    const cfg = resolveEffectiveConfig(s, makePatient({ id: 'patient-A', wheelchairWeight: 25 }))
    expect(cfg.fromPatientProfile).toBe(true)
    expect(cfg.wheelchairWeight).toBe(25)

    // 档案没有 id
    const s2 = makeSession({ patientId: 'patient-A', status: 'ongoing', wheelchairWeightUsed: 13.4 })
    const cfg2 = resolveEffectiveConfig(s2, makePatient({ id: '', wheelchairWeight: 25 }))
    expect(cfg2.fromPatientProfile).toBe(true)
  })
})
