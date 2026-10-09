// @vitest-environment node
/**
 * 静态守卫 · 后台隐私边界（AGENTS.md 的硬约定）
 *
 * 约定：**后台管理端看不到任何病历明细**。这条边界是在数据库层实现的 ——
 * `sessions` / `blood_pressures` / `blood_glucoses` / `blood_flows` / `adverse_reactions` / `dry_weights`
 * 的 RLS 一行未动，管理员的所有读写都经 admin-api 的 service_role 完成，
 * 因此「后台能不能看到病历」实际取决于 admin-api 与 src/admin 的源码写了什么。
 *
 * 本文件把这件事固化成断言：
 * 1. admin-api 里没有对病历表的取数调用（`from('sessions')` 这类）；
 * 2. admin-api 的通用读取辅助只允许白名单表，且 countRows 只能拿 count（head:true，不返回行）；
 * 3. admin-api / src/admin 源码里不出现任何病历字段标识符（systolic、pre_weight_measured…）；
 * 4. src/admin 不直连 PostgREST，只能走 admin-api（唯一入口）；
 * 5. `public.admins` 没有任何写策略（防自助提权），主键落在 user_id；
 * 6. security definer 函数按 AGENTS.md 收口（revoke ... from public），豁免项逐个写明理由；
 * 7. 前端 api.ts 调用的 action 必须全部存在于 admin-api 的 HANDLERS（接口契约，拼错只在运行时炸）。
 *
 * 全部是纯文本/正则解析，离线、无网络、不需要真实凭据。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8')
}

/** 去掉注释后再扫描：中文说明里允许出现「血压/adverse」这类词，只有真代码才算违规 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '') // Vue 模板注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 https://）
}

/** 病历明细字段名（camelCase + snake_case）：后台源码里一个都不许出现 */
const MEDICAL_FIELDS = [
  'systolic',
  'diastolic',
  'preWeightMeasured',
  'postWeightMeasured',
  'pre_weight_measured',
  'post_weight_measured',
  'preWeight',
  'postWeight',
  'pre_weight',
  'post_weight',
  'abortedAt',
  'abortTags',
  'abortReason',
  'aborted_at',
  'abort_tags',
  'abort_reason',
  'doctorUf',
  'doctor_uf',
  'wheelchairWeightUsed',
  'rinseBackVolumeUsed',
  'wheelchair_weight_used',
  'rinse_back_volume_used',
  'measuredAt',
  'measured_at',
  'recordedAt',
  'recorded_at',
  'bloodPressure',
  'blood_pressures',
  'bloodGlucose',
  'blood_glucoses',
  'bloodFlow',
  'blood_flows',
  'adverse',
  'adverseReactions',
  'adverse_reactions',
  'dryWeight',
  'dryWeights',
  'dry_weight',
  'dry_weights',
]

/** 病历明细表名 */
const MEDICAL_TABLES = [
  'sessions',
  'blood_pressures',
  'blood_glucoses',
  'blood_flows',
  'adverse_reactions',
  'dry_weights',
]

const MEDICAL_FIELD_RE = new RegExp(`\\b(${MEDICAL_FIELDS.join('|')})\\b`)

/** 报告「某文件出现了哪些禁用标识符」 */
function findForbiddenIdentifiers(src: string): string[] {
  const clean = stripComments(src)
  const found = new Set<string>()
  for (const field of MEDICAL_FIELDS) {
    if (new RegExp(`\\b${field}\\b`).test(clean)) found.add(field)
  }
  return [...found]
}

// ------------------------------------------------------------------
// schema.sql 解析（只看策略与函数这两件事）
// ------------------------------------------------------------------

function stripSqlComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

interface Policy {
  name: string
  table: string
  /** for 后面的命令；没写 for = ALL（PostgreSQL 默认），这一点很关键 */
  cmd: string | null
  line: number
}

function parsePolicies(sql: string): Policy[] {
  const out: Policy[] = []
  const re = /create\s+policy\s+(\w+)\s+on\s+([\w."]+)(?:\s+for\s+(\w+))?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    out.push({
      name: m[1],
      table: m[2].replace(/^public\./, '').replace(/"/g, ''),
      cmd: m[3] ? m[3].toLowerCase() : null,
      line: sql.slice(0, m.index).split('\n').length,
    })
  }
  return out
}

describe('静态守卫 · 后台隐私边界', () => {
  const adminApi = read('supabase/functions/admin-api/index.ts')
  const schemaSql = read('supabase/schema.sql')

  /**
   * src/admin 下的全部源码 + 后台入口 HTML。
   * 用 readdir 递归发现（而不是写死清单）：新增后台页面时守卫自动覆盖，
   * 否则「新加一个能看到病历的页面」正好落在清单之外 —— 这是最危险的漏网方式。
   */
  const adminFiles = [
    'admin/index.html',
    ...readdirSync(`${ROOT}/src/admin`, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|vue)$/.test(e.name))
      .map((e) => `src/admin/${relative(`${ROOT}/src/admin`, join(e.parentPath, e.name)).replace(/\\/g, '/')}`),
  ].sort()

  describe('admin-api：不得直接读病历表', () => {
    it(`没有 from('病历表') 取数调用（${MEDICAL_TABLES.join(' / ')}）`, () => {
      const clean = stripComments(adminApi)
      const hits: string[] = []
      const re = /\bfrom\s*\(\s*['"]([^'"]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(clean)) !== null) {
        if (MEDICAL_TABLES.includes(m[1])) {
          hits.push(`index.ts:${clean.slice(0, m.index).split('\n').length} from('${m[1]}')`)
        }
      }

      expect(
        hits,
        `admin-api 直接查了病历表：\n${hits.map((h) => '  ' + h).join('\n')}\n` +
          '修法：后台只能拿聚合数字。记录条数/首末日期走 admin_patient_stats() RPC（它只 group by 出 count/min/max），' +
          '不要 select 明细行 —— 这是 AGENTS.md 第二节承诺给用户的隐私边界',
      ).toEqual([])
    })

    it('通用读取辅助只允许白名单表：selectAll 不许碰病历表，countRows 只数行不取行', () => {
      const clean = stripComments(adminApi)

      // selectAll(table, columns) 会真的把行读回来 → 只允许账号 / 病人基础配置 / 成员关系 / 管理员名单 / 审计日志
      // （admins 与 admin_audit_logs 都属于后台自身的数据，不是病历）
      const allowedSelectAll = ['users', 'patients', 'patient_members', 'admins', 'admin_audit_logs']
      // countRows(table) 用 head:true 只拿计数 → sessions 允许（后台要展示"记录总数"）
      const allowedCountRows = ['users', 'patients', 'patient_members', 'sessions']

      // 白名单自身不能混进病历表（防「顺手把 sessions 加进白名单」这种改动）
      const polluted = [...allowedSelectAll, ...allowedCountRows].filter((t) => MEDICAL_TABLES.includes(t) && t !== 'sessions')
      expect(polluted, `守卫白名单被写进了病历表：[${polluted.join(', ')}]`).toEqual([])

      const bad: string[] = []
      for (const [fn, allowed] of [
        ['selectAll', allowedSelectAll],
        ['countRows', allowedCountRows],
      ] as const) {
        const re = new RegExp(`\\b${fn}\\s*\\(\\s*['"]([^'"]+)['"]`, 'g')
        let m: RegExpExecArray | null
        while ((m = re.exec(clean)) !== null) {
          if (!allowed.includes(m[1])) {
            bad.push(`${fn}('${m[1]}') 不在白名单 [${allowed.join(', ')}]（第 ${clean.slice(0, m.index).split('\n').length} 行）`)
          }
        }
      }

      // countRows 自身必须带 head:true（PostgREST 才不会回传行数据），这是"只取聚合"的技术保证
      if (!/async function countRows[\s\S]{0,400}?head:\s*true/.test(clean)) {
        bad.push("countRows() 没有用 select('*', { count: 'exact', head: true })：会真的把病历行读回来")
      }

      expect(
        bad,
        `admin-api 的通用读取范围超出隐私边界：\n${bad.map((x) => '  ' + x).join('\n')}\n` +
          '修法：需要新表时先确认它不是病历明细；病历相关只能走 admin_patient_stats() 这类聚合函数',
      ).toEqual([])
    })

    it('确实用聚合 RPC 拿记录统计（而不是查明细）', () => {
      expect(
        /rpc\(\s*['"]admin_patient_stats['"]\s*\)/.test(adminApi),
        "admin-api 没有调用 admin_patient_stats() —— 后台的记录条数只能来自这个聚合函数（schema.sql 第 11 节）",
      ).toBe(true)
      expect(
        adminApi.includes('admin_patient_stats'),
        'admin_patient_stats 不见了：后台的病人列表/详情拿不到聚合统计',
      ).toBe(true)
    })

    it('源码里没有任何病历字段标识符', () => {
      const found = findForbiddenIdentifiers(adminApi)
      expect(
        found,
        `admin-api 源码出现病历明细字段：[${found.join(', ')}]\n` +
          '修法：后台只展示账号、成员关系、病人基础配置与聚合数字；要展示病历请先改产品设计（会违反隐私承诺）',
      ).toEqual([])
    })
  })

  describe('src/admin：不得出现病历字段，也不得绕过 admin-api', () => {
    it('所有病历字段标识符都不出现', () => {
      // 防「扫描范围为空导致永远绿」：后台页面少说也有十几个文件
      expect(adminFiles.length, `只发现 ${adminFiles.length} 个后台源文件，扫描范围可疑`).toBeGreaterThan(10)

      const bad: string[] = []
      for (const rel of adminFiles) {
        const found = findForbiddenIdentifiers(read(rel))
        if (found.length) bad.push(`${rel}：${found.join(', ')}`)
      }

      expect(
        bad,
        `后台前端出现病历明细字段：\n${bad.map((x) => '  ' + x).join('\n')}\n` +
          '修法：后台只显示 patients 的基础配置（姓名 / 生日 / 轮椅重量 / 回水量）与聚合数字；' +
          '轮椅重量、回水量是病人配置，允许出现（注意别写成 wheelchairWeightUsed / rinseBackVolumeUsed —— 那是病历字段）',
      ).toEqual([])
    })

    it('不直连 PostgREST，也不出现病历表名（数据只能经 admin-api）', () => {
      const bad: string[] = []
      // 只认「真的在拼 PostgREST 请求」的两种形态：supabase.from(…) / .from('表名')。
      // 不能用裸 /\.from\s*\(/：Array.from(s)、Buffer.from(...) 这类标准库调用会被误伤。
      const postgrestCall = /supabase\s*\.\s*from\s*\(|\.from\s*\(\s*['"`]/
      for (const rel of adminFiles) {
        const clean = stripComments(read(rel))
        if (postgrestCall.test(clean)) bad.push(`${rel}：出现 supabase.from(…) 直连 PostgREST`)
        if (/rest\/v1/.test(clean)) bad.push(`${rel}：出现 rest/v1 直连地址`)
        const tableRe = new RegExp(`['"](${MEDICAL_TABLES.join('|')})['"]`)
        const m = tableRe.exec(clean)
        if (m) bad.push(`${rel}：出现病历表名 '${m[1]}'`)
      }

      expect(
        bad,
        `后台前端绕过 admin-api 访问数据：\n${bad.map((x) => '  ' + x).join('\n')}\n` +
          '修法：后台前端只持有 anon key，所有读写都走 functions/v1/admin-api（前端直连 PostgREST 会受 RLS 限制，' +
          '而且一旦 RLS 被"顺手"放宽就等于绕过隐私边界）',
      ).toEqual([])
    })
  })

  describe('schema.sql：admins 表不给任何写入口', () => {
    it('admins 表存在，且主键 / 唯一约束落在 user_id 上', () => {
      const sql = stripSqlComments(schemaSql)
      const m = /create table if not exists public\.admins\s*\(([\s\S]*?)\n\);/.exec(sql)
      expect(
        m,
        'schema.sql 里找不到 `create table if not exists public.admins (...)`：管理员名单表是后台鉴权的唯一依据',
      ).not.toBeNull()

      const body = m![1]
      const userPk =
        /user_id\s+uuid[^,]*primary\s+key/i.test(body) ||
        /primary\s+key\s*\(\s*user_id\s*\)/i.test(body) ||
        /unique\s*\(\s*user_id\s*\)/i.test(body)
      expect(
        userPk,
        'admins 表的主键/唯一约束没有落在 user_id 上：一个账号可能被插成多行，鉴权结果不确定\n' +
          '修法：user_id uuid primary key references public.users(id) on delete cascade',
      ).toBe(true)
    })

    it('目标表是 admins 的策略只有 select（没有任何 insert/update/delete/all）', () => {
      // 说明：这里刻意**不**写成「admins 不许有任何 create policy」——
      // admins_select 是刻意存在的（管理员只能读自己那一行，用于前端判断是否有后台权限）。
      // 真正要守的约定是「没有任何写入口」：PostgreSQL 里 `create policy x on t` 不带 for 等于 ALL，
      // 所以只允许 for select，其余形态（含省略 for）一律视为提权后门。
      const policies = parsePolicies(stripSqlComments(schemaSql))
      expect(policies.length, 'schema.sql 里一条 create policy 都没解析到，解析逻辑可能失效了').toBeGreaterThan(10)

      const onAdmins = policies.filter((p) => p.table === 'admins')
      const writers = onAdmins.filter((p) => p.cmd !== 'select')

      expect(
        writers.map((p) => `schema.sql:${p.line} create policy ${p.name} on ${p.table}${p.cmd ? ' for ' + p.cmd : '（省略 for = ALL）'}`),
        'admins 表出现了写策略（或省略 for 的 ALL 策略）：' +
          'users_update 允许用户更新自己那一行，任何针对 admins 的写策略都可能变成自助提权后门\n' +
          '修法：只保留 admins_select（for select using (user_id = auth.uid())）；' +
          '授予/撤销管理员只能走 SQL Editor 或 admin-api 的 service_role',
      ).toEqual([])

      expect(
        onAdmins.some((p) => p.name === 'admins_select'),
        'admins 缺少 admins_select（管理员读不到自己那一行，后台 whoami 会误判无权限）',
      ).toBe(true)
    })
  })

  describe('schema.sql：security definer 函数调用面收口', () => {
    // 豁免名单：逐个写明理由，新增豁免必须有人解释
    const EXEMPT: Record<string, string> = {
      is_admin: 'RLS 策略需要它（admins 表自身开了 RLS，非 definer 会自我递归）；只返回调用者自己是否是管理员，不泄露他人数据',
      is_member: 'RLS 策略需要它；函数体固定 user_id = auth.uid()，只回答「我是不是这个病人的成员」',
      handle_new_user: '触发器函数（returns trigger），PostgreSQL 不允许直接当普通函数调用',
    }

    it('除豁免项外，每个 security definer 函数都有 revoke all ... from public', () => {
      const sql = stripSqlComments(schemaSql)

      // 抓 `create or replace function public.xxx(...)` ... `security definer` 的函数名
      const fns: string[] = []
      const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns[\s\S]*?(?=\$\$|\bas\b)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(sql)) !== null) {
        const head = m[0]
        if (/security\s+definer/i.test(head)) fns.push(m[1])
      }
      expect(fns.length, '没解析到任何 security definer 函数，解析逻辑可能失效了').toBeGreaterThan(0)

      const missing = fns
        .filter((name) => !(name in EXEMPT))
        .filter((name) => !new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\s*\\(`, 'i').test(sql))

      expect(
        missing,
        `以下 security definer 函数没有收口（任何登录用户都能执行）：[${missing.join(', ')}]\n` +
          '修法：函数定义后补 `revoke all on function public.<name>(<参数类型>) from public;`' +
          '（必要时再加 grant execute ... to service_role）\n' +
          `当前豁免项：${Object.keys(EXEMPT).join('、')}`,
      ).toEqual([])
    })

    it('限流与后台统计函数是收口的（这两条是 AGENTS.md 点名的）', () => {
      const sql = stripSqlComments(schemaSql)
      const need = ['admin_patient_stats', 'check_rate_limit']
      const bad = need.filter((name) => !new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\s*\\(`, 'i').test(sql))
      expect(
        bad,
        `[${bad.join(', ')}] 缺少 revoke all ... from public：` +
          'check_rate_limit 被任意登录用户调用可污染限流计数；admin_patient_stats 会泄露全量病人的记录条数\n' +
          '修法：revoke all on function public.<name>(…​) from public; 然后 grant execute ... to service_role;',
      ).toEqual([])
    })
  })

  describe('接口契约：前端 action ↔ admin-api HANDLERS', () => {
    /** api.ts 里所有 call<…>('action') 的 action 名（泛型可能是嵌套的，如 call<Paged<AdminUserRow>>） */
    function frontendActions(): string[] {
      const src = read('src/admin/lib/api.ts')
      const out: string[] = []
      // [^(]* 吃掉 call 与左括号之间的泛型/空格；函数定义那行 call<T>(action: …) 的第一个参数不是字符串，不会误匹配
      const re = /\bcall\b[^(]*\(\s*['"]([^'"]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) out.push(m[1])
      return [...new Set(out)]
    }

    /** admin-api HANDLERS 表的键 */
    function handlerActions(): string[] {
      const m = /const HANDLERS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(adminApi)
      expect(m, 'admin-api 里找不到 HANDLERS 表（路由表被改名/挪走了？）').not.toBeNull()
      const out: string[] = []
      const re = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm
      let k: RegExpExecArray | null
      while ((k = re.exec(m![1])) !== null) out.push(k[1] ?? k[2] ?? k[3])
      return out
    }

    it('前端调用的每个 action 都在 HANDLERS 里（或在入口特判的 whoami）', () => {
      const actions = frontendActions()
      expect(actions.length, 'api.ts 里一个 action 都没解析到（调用写法变了？）').toBeGreaterThan(15)
      // 抽样校验解析器没漏（嵌套泛型的 call<Paged<X>> 曾经漏过，这里钉死几个）
      for (const must of ['user.list', 'patient.list', 'audit.list', 'whoami']) {
        expect(actions, `解析 api.ts 时漏掉了 ${must}（守卫的正则跟不上调用写法了）`).toContain(must)
      }

      const handlers = handlerActions()
      expect(handlers.length, 'HANDLERS 解析为空').toBeGreaterThan(10)

      const unknown = actions.filter((a) => a !== 'whoami' && !handlers.includes(a))
      expect(
        unknown,
        `前端调了后端不认识的操作：[${unknown.join(', ')}]（只会在运行时返回"未知操作：xxx"，构建期发现不了）\n` +
          '修法：在 admin-api 的 HANDLERS 里补上同名的处理函数（名字必须逐字一致，含点号与大小写）',
      ).toEqual([])
    })

    it('HANDLERS 里的 action 都真的可达（未被前端使用只提示、不失败）', () => {
      const used = new Set([...frontendActions(), 'whoami'])
      const unused = handlerActions().filter((h) => !used.has(h))
      if (unused.length) {
        console.log(`[admin-privacy] 提示：HANDLERS 里这些 action 前端没用上（允许保留，仅作提醒）：${unused.join(', ')}`)
      }
      // 反向只做提示：后端预留接口是允许的，硬失败会让守卫变得难以维护
      expect(handlerActions().length).toBeGreaterThan(0)
    })
  })
})
