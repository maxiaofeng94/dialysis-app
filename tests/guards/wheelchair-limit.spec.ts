// @vitest-environment node
/**
 * 静态守卫 · 轮椅及衣物重量上限四处必须一致
 *
 * 为什么需要这条守卫（第四轮独立评审 轻微-3）：
 * `rinse-back-limit.spec.ts` 只把回水量 2000ml 钉在了一起，**轮椅 100kg 没有对应守卫**。
 * 而这个数字同样写在四个互不相干的地方：
 *   - App 端 `src/views/SettingsView.vue` 的 `WHEELCHAIR_MAX = 100`（**及使用点**）
 *   - 后台 `src/admin/views/PatientDetailView.vue` 的 `wheelchair > 100`
 *   - Edge `supabase/functions/admin-api/index.ts` 的 `value > 100`
 *   - create-patient `supabase/functions/create-patient/index.ts` 的 `wheelchairWeight > 100`
 *
 * 运行时覆盖是有的（`tests/edge/create-patient.spec.ts` 的 101、`tests/edge/admin-api.spec.ts`
 * 的 13000），所以这不算「无覆盖」；但将来某处把 100 改成 150 时，**没有任何测试会红** ——
 * 前端放行、后端 400，用户只看到「保存失败」而表单没标红（回水量就出过这个事故）。
 *
 * 这条守卫做四件事：
 * 1. 四处解析出的上限字面量必须**完全相同**（挡住走散）；
 * 2. 必须等于 100（挡住「四处一起改错」）；
 * 3. 单位必须是 kg 不是克 —— `create-patient` 曾把 1500（= 1.5kg 写成克）当合法值收下，
 *    配着 100kg 上限会直接 400，运维脚本也因此长期是「跑必挂」状态；
 * 4. **App 的校验使用点必须引用常量、不能写裸数字**（中级-1，第六轮独立评审坐实）。
 *
 * ⚠️ 中级-1（第六轮独立评审）：上一版有两个漏洞，实测都能骗过守卫：
 *   · 只读常量**声明**（`WHEELCHAIR_MAX = 100`），不读**使用点** —— 把校验点写成裸 `150`
 *     而常量不动，守卫全绿；上线后 App 放行 150kg、后端 400，迁移时造重复病人。
 *   · 正则用 `(\d+)`，`100.5` 会被截断成 `100` —— 边缘量程被静默接受。
 *
 * 解析器自带自检：解析不到就报错，而不是静默通过。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8')
}

/** 去掉注释，避免把说明文字里的「100」当成代码 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 数字字面量：支持小数（`100.5` 必须能被解析出来，否则会被截断成 100 而静默通过） */
const NUM = String.raw`(\d+(?:\.\d+)?)`

interface Extracted {
  file: string
  max: number
  snippet: string
}

/** App 端：`const WHEELCHAIR_MAX = 100` */
function extractFromApp(): Extracted {
  const file = 'src/views/SettingsView.vue'
  const src = stripComments(read(file))
  const m = src.match(new RegExp(String.raw`WHEELCHAIR_MAX\s*=\s*` + NUM))
  expect(m, `${file} 里找不到 WHEELCHAIR_MAX = <数字>（改写法了？请同步更新本守卫）`).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

/**
 * App 端**使用点**：`rangeError('轮椅及衣物重量', wheelchairWeight, 0, WHEELCHAIR_MAX)`
 *
 * 中级-1：只读声明挡不住「校验点写裸数字」。这里取**每一处**使用点的第 4 个实参，
 * 断言它都不是数字字面量 —— 必须引用 `WHEELCHAIR_MAX`，否则改常量等于没改。
 *
 * ⚠️ 第八轮独立评审轻微-1（**实测坐实**）：上一版只用 `src.match(...)` 取**第一个** match，
 * 而 App 里有两处使用点（`onCreatePatient` 与 `savePatient`）。把 `savePatient` 那处改成裸
 * `150`，守卫仍然全绿（实测 `MUTANT(savePatient 处写裸 150) -> passes = true`）。
 * 现在改成 `matchAll` 逐个校验。
 */
function extractAppUsageArgs(): string[] {
  const file = 'src/views/SettingsView.vue'
  const src = stripComments(read(file))
  const re = /rangeError\(\s*'轮椅及衣物重量'\s*,[^)]*\)/g
  const matches = [...src.matchAll(re)].map((m) => m[0])
  expect(
    matches.length,
    `${file} 里找不到 rangeError('轮椅及衣物重量', …) 的校验点（改写法了？请同步更新本守卫）`,
  ).toBeGreaterThan(0)
  return matches.map((args) => {
    const m = args.match(/,\s*([^,()]+)\s*\)$/)
    expect(m, `校验点参数形状变了，解析不到量程上限：${args}`).toBeTruthy()
    return m![1].trim()
  })
}

/**
 * 导入闸门：`check('轮椅及衣物重量（kg）', p.wheelchairWeight, 100)`
 *
 * ⚠️ 第九轮独立评审轻微-1：这里原来是**第三份**没被守着的字面量。
 * 把 App 端 `WHEELCHAIR_MAX` 改成 150 并同步后台 / Edge / create-patient 之后，
 * 四条守卫全绿，但导入备份仍卡 100 —— 用户手写备份里 120kg 被拒，而界面上 120kg 合法。
 */
function extractFromImportGate(): Extracted {
  const file = 'src/repo/localRepository.ts'
  const src = stripComments(read(file))
  const m = src.match(new RegExp(String.raw`check\(\s*'轮椅及衣物重量（kg）'\s*,[^,]*,\s*` + NUM + String.raw`\s*\)`))
  expect(
    m,
    `${file} 里找不到 check('轮椅及衣物重量（kg）', …, <数字>)（改写法了？请同步更新本守卫）`,
  ).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

/** 后台：`wheelchair > 100` */
function extractFromAdmin(): Extracted {
  const file = 'src/admin/views/PatientDetailView.vue'
  const src = stripComments(read(file))
  const m = src.match(new RegExp(String.raw`wheelchair\s*>\s*` + NUM))
  expect(m, `${file} 里找不到 wheelchair > <数字>（改写法了？请同步更新本守卫）`).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

/** Edge：`key === 'wheelchairWeight' && value > 100` */
function extractFromEdge(): Extracted {
  const file = 'supabase/functions/admin-api/index.ts'
  const src = stripComments(read(file))
  const m = src.match(new RegExp(String.raw`wheelchairWeight'?\s*&&\s*value\s*>\s*` + NUM))
  expect(m, `${file} 里找不到 wheelchairWeight && value > <数字>（改写法了？请同步更新本守卫）`).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

/** create-patient：`wheelchairWeight > 100` */
function extractFromCreatePatient(): Extracted {
  const file = 'supabase/functions/create-patient/index.ts'
  const src = stripComments(read(file))
  const m = src.match(new RegExp(String.raw`wheelchairWeight\s*>\s*` + NUM))
  expect(m, `${file} 里找不到 wheelchairWeight > <数字>（改写法了？请同步更新本守卫）`).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

describe('静态守卫 · 轮椅及衣物重量上限五处一致', () => {
  it('五处解析器都能找到上限（解析器自检：跟不上就报错，不许静默通过）', () => {
    for (const fn of [
      extractFromApp,
      extractFromAdmin,
      extractFromEdge,
      extractFromCreatePatient,
      extractFromImportGate,
    ]) {
      const r = fn()
      expect(Number.isFinite(r.max), `${r.file} 解析出的上限不是有限数字`).toBe(true)
      expect(r.max, `${r.file} 解析出的上限为 0 或负数，解析器可能匹配错了位置`).toBeGreaterThan(0)
    }
  })

  it('App / 后台 / Edge / create-patient / 导入闸门的轮椅上限必须完全相同（走散会让前端放行、后端 400）', () => {
    const app = extractFromApp()
    const admin = extractFromAdmin()
    const edge = extractFromEdge()
    const create = extractFromCreatePatient()
    const gate = extractFromImportGate()

    const all = [app, admin, edge, create, gate]
    const desc = all.map((x) => `  ${x.file}: ${x.snippet}  → ${x.max}`).join('\n')

    expect(admin.max, `后台与 App 的上限不一致：\n${desc}`).toBe(app.max)
    expect(edge.max, `Edge 与 App 的上限不一致：\n${desc}`).toBe(app.max)
    expect(create.max, `create-patient 与 App 的上限不一致：\n${desc}`).toBe(app.max)
    expect(gate.max, `导入闸门（localRepository）与 App 的上限不一致：\n${desc}`).toBe(app.max)
  })

  it('上限就是 100kg（单位是 kg 不是克；改这个数字必须同时改四处 + 边界用例）', () => {
    // 100kg 是「电动轮椅 + 衣物」的合理上界。真要改，请同步：
    //   src/views/SettingsView.vue、src/admin/views/PatientDetailView.vue、
    //   supabase/functions/admin-api/index.ts、supabase/functions/create-patient/index.ts，
    //   以及 tests/edge/create-patient.spec.ts、tests/edge/admin-api.spec.ts
    expect(extractFromApp().max).toBe(100)
  })

  it('App 的每一处校验使用点都必须引用 WHEELCHAIR_MAX，不能写裸数字（否则改常量等于没改）', () => {
    const args = extractAppUsageArgs()
    // 逐个校验：App 里有 2 处（onCreatePatient / savePatient），只查第一处会被漏
    for (const [i, arg] of args.entries()) {
      expect(
        arg,
        `App 第 ${i + 1} 处校验点写成了数字字面量 ${arg} → 改 WHEELCHAIR_MAX 不起作用，前端会放行、后端 400`,
      ).toBe('WHEELCHAIR_MAX')
    }
  })

  it('create-patient 的错误文案要点明「单位是 kg 不是克」（1.5kg 写成 1500 是真实踩过的坑）', () => {
    // 中级-1：必须用 stripComments（避免把注释里的「不能超过 100kg」当成文案），
    // 且数字要与真实上限一致 —— 原来用 `\d+`，文案写 150kg 也能通过。
    const src = stripComments(read('supabase/functions/create-patient/index.ts'))
    const m = src.match(/轮椅及衣物重量不能超过\s*(\d+(?:\.\d+)?)\s*kg/)
    expect(m, 'create-patient 的轮椅超限提示里没提「kg / 克」，用户不知道 1500 该填 1.5').toBeTruthy()
    expect(
      Number(m![1]),
      `提示文案里的上限（${m![1]}kg）与实际校验的上限（${extractFromCreatePatient().max}kg）不一致`,
    ).toBe(extractFromCreatePatient().max)
  })
})
