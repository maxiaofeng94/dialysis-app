// @vitest-environment node
/**
 * 静态守卫 · 回水量上限三处必须一致
 *
 * 为什么需要这条守卫（第三轮独立评审 D3）：
 * 回水量上限写在**三个互不相干的地方**：
 *   - App 端 `src/views/SettingsView.vue` 的 `RINSE_BACK_MAX = 2000`
 *   - 后台 `src/admin/views/PatientDetailView.vue` 的 `rinse > 2000`
 *   - Edge `supabase/functions/admin-api/index.ts` 的 `value > 2000`
 *
 * 历史上这三处走散过：后台是 5000、后端是 2000，管理员填 3000 时前端放行、
 * 后端返回 400，用户只看到「保存失败」而表单没标红，根本不知道错在哪。
 *
 * 评审实测：把三处**同时**改回 5000（保持「一致」但错），全量 1739 条用例里
 * 只有 App 端一条红（因为它的 toast 文案硬编码了 `0~2000`），后台与 Edge **零反应**。
 * 也就是说「上限是 2000 还是 5000」这件事，除了 App 端文案外没有任何测试在守。
 *
 * 这条守卫做两件事：
 * 1. 三处解析出的上限字面量必须**完全相同**（挡住走散）；
 * 2. 必须等于 2000（挡住「三处一起改错」—— 那三条边界用例（2001 拦 / 2000 放行）
 *    分别在 tests/views、tests/admin、tests/edge 里守着，这里只是再加一道显式锚点）。
 *
 * 解析器自带「自检」：解析不到就报错，而不是静默通过 —— 否则改了写法（比如把
 * `2000` 抽成常量）守卫会假装绿，比没有更糟。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(rel: string): string {
  return readFileSync(`${ROOT}/${rel}`, 'utf8')
}

/** 去掉注释，避免把说明文字里的「2000」当成代码 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

interface Extracted {
  file: string
  max: number
  /** 匹配到的原始片段，报错时给人看 */
  snippet: string
}

/** App 端：`const RINSE_BACK_MAX = 2000` */
function extractFromApp(): Extracted {
  const file = 'src/views/SettingsView.vue'
  const src = stripComments(read(file))
  const m = src.match(/RINSE_BACK_MAX\s*=\s*(\d+)/)
  expect(m, `${file} 里找不到 RINSE_BACK_MAX = <数字>（改写法了？请同步更新本守卫）`).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

/** 后台：`rinse > 2000` */
function extractFromAdmin(): Extracted {
  const file = 'src/admin/views/PatientDetailView.vue'
  const src = stripComments(read(file))
  // 只认「回水量」那一段：先定位 rinse 变量参与的比较
  const m = src.match(/rinse\s*>\s*(\d+)/)
  expect(m, `${file} 里找不到 rinse > <数字>（改写法了？请同步更新本守卫）`).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

/** Edge：`key === 'rinseBackVolume' && value > 2000` */
function extractFromEdge(): Extracted {
  const file = 'supabase/functions/admin-api/index.ts'
  const src = stripComments(read(file))
  const m = src.match(/rinseBackVolume'?\s*&&\s*value\s*>\s*(\d+)/)
  expect(m, `${file} 里找不到 rinseBackVolume && value > <数字>（改写法了？请同步更新本守卫）`).toBeTruthy()
  return { file, max: Number(m![1]), snippet: m![0] }
}

describe('静态守卫 · 回水量上限三处一致', () => {
  it('三处解析器都能找到上限（解析器自检：跟不上就报错，不许静默通过）', () => {
    for (const fn of [extractFromApp, extractFromAdmin, extractFromEdge]) {
      const r = fn()
      expect(Number.isFinite(r.max), `${r.file} 解析出的上限不是有限数字`).toBe(true)
      expect(r.max, `${r.file} 解析出的上限为 0 或负数，解析器可能匹配错了位置`).toBeGreaterThan(0)
    }
  })

  it('App / 后台 / Edge 的回水量上限必须完全相同（走散会让前端放行、后端 400）', () => {
    const app = extractFromApp()
    const admin = extractFromAdmin()
    const edge = extractFromEdge()

    // 报错时把三处的原始片段都打出来，一眼看出谁跟谁不一致
    const all = [app, admin, edge]
    const desc = all.map((x) => `  ${x.file}: ${x.snippet}  → ${x.max}`).join('\n')

    expect(admin.max, `后台与 App 的上限不一致：\n${desc}`).toBe(app.max)
    expect(edge.max, `Edge 与 App 的上限不一致：\n${desc}`).toBe(app.max)
  })

  it('上限就是 2000ml（实测合理量程；改这个数字必须同时改三处 + 三条边界用例）', () => {
    // 2000ml 是护理常规的回水量上限量级。真要改，请同步：
    //   src/views/SettingsView.vue、src/admin/views/PatientDetailView.vue、
    //   supabase/functions/admin-api/index.ts，以及
    //   tests/views/SettingsView.spec.ts、tests/admin/views.spec.ts、tests/edge/admin-api.spec.ts
    expect(extractFromApp().max).toBe(2000)
  })
})
