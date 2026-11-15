/**
 * 病人配置变更记录（patient_change_logs）的领域逻辑测试
 *
 * 覆盖四块：
 * 1. **表结构**：Dexie v3 真的建出了 `patientChangeLogs` 表且 `patientId` / 复合索引可用；
 * 2. **条目形状与写入语义**：拷贝语义、同 id 覆盖、null 老值不被折成 0、operator 可空；
 * 3. **SettingsView 的留痕纪律**（源码级守卫，见下方说明为什么用这种方式）；
 * 4. **失败处理的业务约束**：写日志失败不能把整次保存判成失败。
 *
 * 为什么值单独一个文件：这个功能的价值全在「可信」二字 ——
 * 少一条、多一条、顺序乱了、老值取错了、写失败却提示「已保存」，用户就不会再信这份历史。
 * 仓储层的倒序 / 隔离 / 导入导出往返在 `tests/repo/localRepository.spec.ts` 里，
 * 缓存层的「追加后立刻能读到」在 `tests/repo/cachedRepository.spec.ts` 里，本文件不重复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { db } from '../../src/db/database'
import { localRepository } from '../../src/repo/localRepository'
import { makeChangeLog, resetIdSeq, TEST_PATIENT_ID } from '../helpers/factories'

beforeEach(async () => {
  await db.delete()
  await db.open()
  resetIdSeq()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('变更记录 · 表结构与索引', () => {
  it('Dexie v3 真的建出了 patientChangeLogs 表（能查、能写、能数）', async () => {
    // 表/索引没建好时 Dexie 抛 SchemaError；这里要求三个基本操作都走得通
    await expect(db.patientChangeLogs.where('patientId').equals('p1').toArray()).resolves.toEqual([])
    await expect(db.patientChangeLogs.count()).resolves.toBe(0)

    await db.patientChangeLogs.put(makeChangeLog({ id: 'l1', patientId: 'p1' }))
    await expect(db.patientChangeLogs.count()).resolves.toBe(1)
  })

  it('复合索引 [patientId+changedAt] 可用（按病人取一段时间区间的历史）', async () => {
    await db.patientChangeLogs.bulkPut([
      makeChangeLog({ id: 'a', patientId: 'p1', changedAt: 1000 }),
      makeChangeLog({ id: 'b', patientId: 'p1', changedAt: 2000 }),
      makeChangeLog({ id: 'c', patientId: 'p2', changedAt: 1500 }),
    ])

    const rows = await db.patientChangeLogs
      .where('[patientId+changedAt]')
      .between(['p1', 0], ['p1', Infinity])
      .toArray()

    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })
})

describe('变更记录 · 条目形状与写入语义', () => {
  it('七个字段原样往返（id / patientId / field / oldValue / newValue / operator / changedAt）', async () => {
    const log = makeChangeLog({
      id: 'l1',
      patientId: 'p1',
      field: 'wheelchairWeight',
      oldValue: 13.4,
      newValue: 13.5,
      operator: '李四',
      changedAt: 1_700_000_200_000,
    })
    await localRepository.addPatientChangeLog(log)

    expect(await localRepository.listPatientChangeLogs('p1')).toEqual([log])
  })

  it('写入是拷贝语义：外部对象事后被改不影响库里的值', async () => {
    const log = makeChangeLog({ id: 'l1', newValue: 13.5 })
    await localRepository.addPatientChangeLog(log)

    log.newValue = 999
    log.operator = '被改了'

    const got = (await localRepository.listPatientChangeLogs(TEST_PATIENT_ID))[0]
    expect(got.newValue).toBe(13.5)
    expect(got.operator).toBe('张三')
  })

  // 老值为 null = 「之前没有配置」，必须与「配置成 0kg」区分：
  // 折成 0 会让历史看起来像「从 0kg 改成 13.5kg」，用户会以为自己填错过。
  it('oldValue 为 null（首次配置）原样保留，不会被折成 0', async () => {
    await localRepository.addPatientChangeLog(makeChangeLog({ id: 'l1', oldValue: null, newValue: 13.5 }))

    const got = (await localRepository.listPatientChangeLogs(TEST_PATIENT_ID))[0]
    expect(got.oldValue).toBeNull()
    expect(got.oldValue).not.toBe(0)
  })

  it('operator 为 null（本地单机模式没有账号）原样保留，与空串不是一回事', async () => {
    await localRepository.addPatientChangeLog(makeChangeLog({ id: 'l1', operator: null }))

    const got = (await localRepository.listPatientChangeLogs(TEST_PATIENT_ID))[0]
    expect(got.operator).toBeNull()
    expect(got.operator).not.toBe('')
  })

  it('同 id 再写是覆盖（不会产生重复行）', async () => {
    await localRepository.addPatientChangeLog(makeChangeLog({ id: 'l1', newValue: 13.5 }))
    await localRepository.addPatientChangeLog(makeChangeLog({ id: 'l1', newValue: 14 }))

    const list = await localRepository.listPatientChangeLogs(TEST_PATIENT_ID)
    expect(list).toHaveLength(1)
    expect(list[0].newValue).toBe(14)
  })
})

/**
 * SettingsView 留痕纪律的源码级守卫。
 *
 * 为什么用源码断言而不是组件测试：`SettingsView.spec.ts` 由另一路 agent 并行维护，
 * 本轮不做改动；而这几条纪律恰恰是「变更记录可信度」的全部 —— 必须有一条防线钉住。
 * 判据用 `stripComments` 之后的源码匹配（注释骗不过它），这是本项目 guards 的既有做法。
 */
describe('SettingsView 的留痕纪律（源码级守卫）', () => {
  const settingsSrc = (() => {
    const p = resolve(process.cwd(), 'src/views/SettingsView.vue')
    const raw = readFileSync(p, 'utf8')
    // 去掉 // 行注释与 /* */ 块注释 + HTML 注释：注释里写着「必须写日志」不算实现
    return raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  })()

  it('保存成功后确实会追加变更记录（appendWheelchairLog → repository.addPatientChangeLog）', () => {
    expect(settingsSrc).toMatch(/repository\.addPatientChangeLog\s*\(/)
    // 必须是「档案保存成功之后」调：savePatient 里的 await 顺序不能颠倒，
    // 否则会出现「日志说改了、实际档案没存上」的自相矛盾历史
    const saveIdx = settingsSrc.indexOf('await repository.savePatient(')
    const logCallIdx = settingsSrc.indexOf('await appendWheelchairLog(')
    expect(saveIdx).toBeGreaterThan(-1)
    expect(logCallIdx).toBeGreaterThan(saveIdx)
  })

  it('只有重量变了才写日志（没有变化不得留痕，否则每次点保存都多一条噪声）', () => {
    expect(settingsSrc).toMatch(/wheelchairChanged/)
    expect(settingsSrc).toMatch(/if\s*\(\s*wheelchairChanged\s*\)/)
  })

  it('保存前的旧值在覆盖 patient.value 之前取（否则 oldValue 永远等于 newValue）', () => {
    // 只在 savePatient 函数体内比较，别处的同名赋值不算数
    const fnStart = settingsSrc.indexOf('async function savePatient')
    expect(fnStart).toBeGreaterThan(-1)
    const body = settingsSrc.slice(fnStart, settingsSrc.indexOf('\n}\n', fnStart))
    const prevIdx = body.indexOf('const prevWheelchair')
    const assignIdx = body.indexOf('patient.value = p')
    expect(prevIdx).toBeGreaterThan(-1)
    expect(assignIdx).toBeGreaterThan(prevIdx)
    // 而且要在调用 savePatient(仓储) 之前取：失败路径下 oldValue 才有意义
    expect(prevIdx).toBeLessThan(body.indexOf('await repository.savePatient('))
  })

  // 「已保存，但变更记录未能写入（请检查网络）」—— 三种后果必须能区分：
  // 全对了 / 档案存了但日志没写 / 档案没存上。文案混同会让用户二选一都猜错。
  it('日志写失败时的提示与成功路径明确区分（不假报成功、也不谎报失败）', () => {
    expect(settingsSrc).toContain('已保存，但变更记录未能写入')
    expect(settingsSrc).toMatch(/showToast\(\s*logged\s*\?\s*'已保存'\s*:/)
  })

  it('appendWheelchairLog 自己吞掉异常并返回布尔（日志失败不能把整次保存判成失败）', () => {
    const start = settingsSrc.indexOf('async function appendWheelchairLog')
    expect(start).toBeGreaterThan(-1)
    const body = settingsSrc.slice(start, settingsSrc.indexOf('\n}', start))
    expect(body).toMatch(/try\s*\{/)
    expect(body).toMatch(/catch/)
    expect(body).toMatch(/return false/)
    // 关键：catch 里不能再抛（否则 savePatient 的 catch 会把它当成保存失败去 toast「保存失败」）
    expect(body).not.toMatch(/throw/)
  })

  it('打开变更历史时用 fresh 读（否则命中旧缓存、刚改完看不到这一条）', () => {
    expect(settingsSrc).toMatch(/listPatientChangeLogs\([^)]*\{\s*fresh:\s*true\s*\}/)
  })

  // 读失败绝不能显示成「暂无变更记录」：那会让用户以为从没改过，反而更不信这份数据
  it('读变更记录失败时给出错误文案与重试，而不是显示成空列表', () => {
    expect(settingsSrc).toContain('变更记录加载失败')
    const start = settingsSrc.indexOf('async function openChangeLog')
    const body = settingsSrc.slice(start, settingsSrc.indexOf('\n}', start))
    expect(body).toMatch(/catch/)
    expect(body).toMatch(/changeLogError\.value\s*=/)
  })

  it('写完日志后清掉该病人的缓存 key（让变更历史读到新数据）', () => {
    expect(settingsSrc).toMatch(/cacheDelete\(\s*`patientChangeLogs:\$\{/)
  })

  it('日志的 patientId 来自**显式参数**（不能用全局 currentPatientId），其余来自当前上下文', () => {
    const start = settingsSrc.indexOf('async function appendWheelchairLog')
    const body = settingsSrc.slice(start, settingsSrc.indexOf('\n}', start))
    // ⚠️ 关键：patientId 必须由调用方传入，不能在这里读 `currentPatientId.value`。
    // 这个函数在 `await savePatient(...)` 之后才被调用 —— 等待期间用户切病人是可能的，
    // 读全局就会把 A 的变更记录写到 B 名下（独立评审 S-1，已用用例坐实）。
    expect(body).toMatch(/patientId[,\s]*\n/) // 简写属性 `patientId,`（来自参数）
    expect(body).not.toMatch(/patientId:\s*currentPatientId\.value/)
    // 缓存 key 也要用归属病人的 id，不能读全局
    expect(body).toMatch(/cacheDelete\(\s*`patientChangeLogs:\$\{patientId\}`/)
    expect(body).toMatch(/field:\s*'wheelchairWeight'/)
    expect(body).toMatch(/changedAt:\s*Date\.now\(\)/)
    expect(body).toMatch(/operator:/)
  })

  it('调用 appendWheelchairLog 时传入**发起保存时捕获**的病人 id（p.id），不是此刻的全局值', () => {
    // 同理：`p.id` 是在 await 之前取的，用它才不会串号
    expect(settingsSrc).toMatch(/appendWheelchairLog\([^)]*,\s*p\.id\s*\)/)
    // 待补队列的条目也要带 p.id
    expect(settingsSrc).toMatch(/patientId:\s*p\.id/)
  })
})

/**
 * 变更记录的**运行时**行为不在这里测。
 *
 * 这里原本有一组「失败处理契约」用例，在测试文件里重新实现了一遍 `toastFor()` 再断言它 ——
 * 评审指出那是**自证循环**：它跟 `SettingsView.vue` 的真实实现没有任何连接，
 * 把源码里的提示文案改坏，那三条照样绿。
 * 已删除，改由 `tests/views/SettingsView.spec.ts` 的
 * 「SettingsView · 轮椅及衣物重量变更记录（运行时行为）」真实挂载 + mock 断言覆盖
 * （重量没变不写 / 变了写一条且 oldValue 取保存前 / 写失败 toast 区分 / 读失败不显示空态）。
 */

