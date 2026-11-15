/**
 * 生产库结构检查的**声明清单**守卫（第十二轮独立评审·中级-1）。
 *
 * ⭐ 为什么需要这个文件：
 * `prod-schema-check.spec.ts` 里那条「探测集合 == 声明集合」的断言是**自指的** ——
 * `asked` 与 `expected` 都来自同一个 `parseSchema(sql)`，等于 `f(x) == f(x)`。
 * 加上数量断言用的是 `>=` 下限，于是「换列」（删一个加一个，净数不变）永远不红。
 *
 * 独立评审实测：把真实 `schema.sql` 里 **26/84 个列**逐个改名后，整套测试全绿，
 * 包括 7 张表的 `created_at`、`rate_limits.bucket/key/count`、
 * `admin_audit_logs.admin_id/action/target_type/target_id/detail`、
 * `admins.created_by/note`、`patient_members.role`、`users.phone/name`。
 * 这些列一旦改名，代码里的 `r.created_at` 会读到 `undefined`（时间显示错乱），
 * 而生产库结构检查会去探测一个**不存在的列名**、恰好也「通过」（因为两边都错）。
 *
 * 所以这里放一份**手写的、与 parseSchema 无关的**清单：
 *   - 每张表 + 精确列数 + 完整列名集合（精确 `toEqual`，不是 `>=`）
 *   - 关键列显式点名（出问题时报错信息直接指出是哪一列）
 *
 * 加列/加表 → 这里必须同步更新（这是**好事**：结构变更本就该被看见一次）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { parseSchema, dedupeColumns } from '../../scripts/check-prod-schema.mjs'

/**
 * 手工维护的结构基线。
 *
 * ⚠️ 改动 `supabase/schema.sql` 加/删/改列时，必须同步这里 ——
 * 这条用例红，就是在提醒你「生产库也要同步」。
 */
const EXPECTED_TABLES: Record<string, string[]> = {
  users: ['created_at', 'id', 'name', 'phone'],
  patients: [
    'birthday',
    'created_at',
    'id',
    'name',
    'rinse_back_volume',
    'updated_at',
    'wheelchair_weight',
  ],
  dry_weights: ['created_at', 'effective_date', 'id', 'note', 'patient_id', 'updated_at', 'value'],
  sessions: [
    'abort_reason',
    'abort_tags',
    'aborted_at',
    'created_at',
    'date',
    'doctor_uf',
    'id',
    'notes',
    'operator_id',
    'patient_id',
    'post_weight_measured',
    'pre_weight_measured',
    'rinse_back_volume_used',
    'status',
    'updated_at',
    'wheelchair_weight_used',
  ],
  blood_pressures: ['diastolic', 'id', 'measured_at', 'note', 'pulse', 'session_id', 'systolic'],
  blood_glucoses: ['id', 'measured_at', 'note', 'session_id', 'value'],
  blood_flows: ['id', 'measured_at', 'note', 'session_id', 'value'],
  adverse_reactions: ['detail', 'id', 'recorded_at', 'session_id', 'severity', 'type'],
  patient_change_logs: [
    'changed_at',
    'field',
    'id',
    'new_value',
    'old_value',
    'operator_id',
    'patient_id',
  ],
  patient_members: ['created_at', 'id', 'patient_id', 'role', 'user_id'],
  admins: ['created_at', 'created_by', 'note', 'user_id'],
  admin_audit_logs: ['action', 'admin_id', 'created_at', 'detail', 'id', 'target_id', 'target_type'],
  rate_limits: ['bucket', 'count', 'key', 'window_start'],
}

/**
 * 代码里**直接按名字读**的列（`r.<col>` / `row.<col>`）。
 * 这些列一旦改名，运行时就是 `undefined`，且不会抛错 —— 最隐蔽的一类。
 */
const COLUMNS_READ_BY_CODE = [
  'sessions.created_at',
  'sessions.doctor_uf',
  'sessions.aborted_at',
  'sessions.abort_tags',
  'sessions.abort_reason',
  'sessions.wheelchair_weight_used',
  'sessions.rinse_back_volume_used',
  'patients.created_at',
  'patients.wheelchair_weight',
  'patients.rinse_back_volume',
  'dry_weights.created_at',
  'blood_pressures.pulse',
  'patient_change_logs.old_value',
  'patient_change_logs.new_value',
  'patient_change_logs.field',
  'patient_change_logs.changed_at',
  'patient_members.role',
  'users.phone',
  'rate_limits.window_start',
]

function parsedByTable() {
  const sql = readFileSync('supabase/schema.sql', 'utf8')
  const { tables, columns } = parseSchema(sql)
  const uniq = dedupeColumns(columns)
  const byTable: Record<string, string[]> = {}
  for (const t of tables) byTable[t] = []
  for (const c of uniq) {
    if (!byTable[c.table]) byTable[c.table] = []
    byTable[c.table].push(c.column)
  }
  for (const t of Object.keys(byTable)) byTable[t].sort()
  return byTable
}

describe('schema.sql 结构基线（手写清单，与 parseSchema 无耦合）', () => {
  it('表清单必须精确一致（多一张少一张都要显式更新）', () => {
    const actual = Object.keys(parsedByTable()).sort()
    const expected = Object.keys(EXPECTED_TABLES).sort()
    expect(actual).toEqual(expected)
  })

  it('每张表的列必须精确一致（换列必红，不只是数量下限）', () => {
    const actual = parsedByTable()
    for (const [table, cols] of Object.entries(EXPECTED_TABLES)) {
      expect(actual[table], `表 ${table} 的列集合变了`).toEqual([...cols].sort())
    }
  })

  it('表数量与列总数必须精确是 13 / 84', () => {
    const actual = parsedByTable()
    expect(Object.keys(actual).length).toBe(13)
    const total = Object.values(actual).reduce((n, cols) => n + cols.length, 0)
    expect(total).toBe(84)
  })

  it('代码直接读的列必须都在声明清单里（防「改名后读到 undefined」）', () => {
    const actual = parsedByTable()
    // ⚠️ 这条清单是**手写的、故意不全**的抽样（点名的都是历次事故现场）。
    // 上一版本曾把它当「完整清单」用，评审实测改名 `blood_glucoses.value` /
    // `adverse_reactions.severity` 仍然全绿 —— 手写清单天生会漏。
    // 完整覆盖由下面那条「从源码自动提取 r.<col>」的用例负责。
    const missing = COLUMNS_READ_BY_CODE.filter((key) => {
      const [table, column] = key.split('.')
      return !actual[table] || !actual[table].includes(column)
    })
    expect(missing, `以下被代码读取的列不在 schema.sql 里：${missing.join(', ')}`).toEqual([])
  })

  it('cloudRepository 里出现的每个 r.<列> 都能在 schema.sql 里找到（自动提取，不靠手写清单）', () => {
    const src = readFileSync('src/lib/cloudRepository.ts', 'utf8')
    const actual = parsedByTable()
    // 收集 schema 里所有列名（跨表），只要能在**任意**表里找到就放行 ——
    // 这条用例的职责是「防拼错/防改名后读到 undefined」，精确的「哪张表」由
    // 上面那条按 fromRow 函数归属表的用例负责。
    const allColumns = new Set<string>()
    for (const cols of Object.values(actual)) for (const c of cols) allColumns.add(c)

    const referenced = [...src.matchAll(/\br\.([a-z][a-z0-9_]*)\b(?!\s*\?\.|\s*\.)/g)].map((x) => x[1])
    const unique = [...new Set(referenced)]
    // 防「正则失效 → 恒真」
    expect(unique.length, '必须真的从 cloudRepository 里提取到若干列引用').toBeGreaterThan(30)

    const unknown = unique.filter((c) => !allColumns.has(c))
    expect(
      unknown,
      `cloudRepository 读了这些列，但 schema.sql 里任何表都没有：${unknown.join(', ')}`,
    ).toEqual([])
  })

  it('关键列必须逐一点名存在（出错时能直接看出是哪一列）', () => {
    const actual = parsedByTable()
    // 这几列是历次事故的现场：心率（第十一轮）、变更历史（第十一轮）、
    // 轮椅及衣物重量（第九轮改名）、回水量、机器超滤
    expect(actual['blood_pressures']).toContain('pulse')
    expect(actual['patient_change_logs']).toContain('old_value')
    expect(actual['patient_change_logs']).toContain('new_value')
    expect(actual['patients']).toContain('wheelchair_weight')
    expect(actual['patients']).toContain('rinse_back_volume')
    expect(actual['sessions']).toContain('wheelchair_weight_used')
    expect(actual['sessions']).toContain('rinse_back_volume_used')
    expect(actual['sessions']).toContain('doctor_uf')
  })
})

describe('代码读列 vs schema.sql（反向检查，中级-2）', () => {
  /**
   * ⭐ 中级-2：`schema-contract.spec.ts` 只检查**写方向**（`xxxToRow` 的键必须在 schema 里），
   * 而 8 个 `toRow` 全都不写 `created_at` ⇒ `created_at` 永远进不了那条检查。
   * 读方向（`r.created_at`）没有任何守卫：改名后 `new Date(undefined).getTime()` 是 NaN，
   * 时间显示错乱，没有任何测试会红。
   *
   * 这里补一条读方向检查：`cloudRepository.ts` 里所有 `r.<col>` 必须在 schema.sql 里存在。
   */
  it('cloudRepository 里读的每个 r.<列> 都必须在 schema.sql 里（按所在 fromRow 函数归属表）', async () => {
    const src = readFileSync('src/lib/cloudRepository.ts', 'utf8')
    const actual = parsedByTable()

    // 从 `function xxxFromRow(r: ...)` 里抽 r.<col>，并按函数名推断目标表。
    // ⚠️ 键必须与 `cloudRepository.ts` 里的真实函数名**逐字一致** ——
    // 上一版本这里写错 4 个键（`userFromRow` / `bloodPressureFromRow` /
    // `bloodGlucoseFromRow` / `adverseReactionFromRow`），于是这 4 张表被静默跳过，
    // 实际只覆盖 5 表 / 40 列，**恰好漏掉第十一轮事故的 `blood_pressures`**。
    // 现在下面的 `unmapped` 断言会拦住「键名写错」这种错误。
    const tableOf: Record<string, string> = {
      patientFromRow: 'patients',
      dryWeightFromRow: 'dry_weights',
      sessionFromRow: 'sessions',
      bpFromRow: 'blood_pressures',
      bgFromRow: 'blood_glucoses',
      bloodFlowFromRow: 'blood_flows',
      reactionFromRow: 'adverse_reactions',
      changeLogFromRow: 'patient_change_logs',
    }

    const problems: string[] = []
    const unmapped: string[] = []
    const coveredTables = new Set<string>()
    // 匹配 `function xxxFromRow(r: ...) { ... }`，抽出函数名与函数体
    const fnRe = /function\s+(\w+FromRow)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g
    let m: RegExpExecArray | null
    let checked = 0
    while ((m = fnRe.exec(src))) {
      const [, fnName, body] = m
      const table = tableOf[fnName]
      if (!table) {
        // 新增了 *FromRow 却忘了登记 → 必须红，否则新表静默逃出这条守卫
        unmapped.push(fnName)
        continue
      }
      coveredTables.add(table)
      // 只取「当作标量读」的列：`r.col` 后面不能紧跟 `?.` / `.`（那是 PostgREST 的
      // 嵌套关联对象，如 `r.operator?.name` —— 关联名不是本表列，不该在这里检查）
      const cols = [...body.matchAll(/\br\.([a-z][a-z0-9_]*)\b(?!\s*\?\.|\s*\.)/g)].map((x) => x[1])
      for (const col of new Set(cols)) {
        checked++
        if (!actual[table] || !actual[table].includes(col)) {
          problems.push(`${fnName} 读了 r.${col}，但 ${table} 没有这一列`)
        }
      }
    }
    // 防「正则没匹配到任何函数」导致恒真
    expect(checked, '必须真的检查到若干列（否则正则失效）').toBeGreaterThan(50)
    // 防「键名写错导致整表被跳过」：8 个 fromRow 必须全部映射上
    expect(unmapped, `这些 *FromRow 没有在 tableOf 里登记，会被静默跳过：${unmapped.join(', ')}`).toEqual([])
    expect(coveredTables.size, '必须覆盖 cloudRepository 里全部 8 张业务表').toBe(8)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('读方向检查必须能抓到「fromRow 读了 schema 里不存在的列」', () => {
    // 自我验证：造一段假的 fromRow 源码，确认上面的检查逻辑真的会报错
    const fakeSrc = `function bpFromRow(r: any) {
  return { id: r.id, pulse: r.pulse, ghost: r.ghost_column }
}`
    const actual = parsedByTable()
    const fnRe = /function\s+(\w+FromRow)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g
    const tableOf: Record<string, string> = { bpFromRow: 'blood_pressures' }
    const problems: string[] = []
    let m: RegExpExecArray | null
    while ((m = fnRe.exec(fakeSrc))) {
      const [, fnName, body] = m
      const table = tableOf[fnName]
      if (!table) continue
      const cols = [...body.matchAll(/\br\.([a-z][a-z0-9_]*)\b(?!\s*\?\.|\s*\.)/g)].map((x) => x[1])
      for (const col of new Set(cols)) {
        if (!actual[table].includes(col)) problems.push(`${fnName} 读了 r.${col}，但 ${table} 没有这一列`)
      }
    }
    expect(problems).toEqual(['bpFromRow 读了 r.ghost_column，但 blood_pressures 没有这一列'])
  })
})
