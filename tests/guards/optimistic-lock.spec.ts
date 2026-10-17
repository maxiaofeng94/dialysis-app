/**
 * 静态守卫：**每个写入方法都必须被显式归类**（要不要乐观锁）。
 *
 * 起因：给 `saveSession` 加了乐观锁之后，同一个模式在 `savePatient`（整行覆盖）
 * 与 `replaceAdverseReactions`（整表替换）上漏了两处 —— 是用户追问「是不是所有写入都有」
 * 才发现的。测试全绿、类型检查通过、CI 通过，没有任何一道自动防线会提醒。
 *
 * 这个守卫的作用就是：**以后新增一个写方法时，如果没想清楚要不要乐观锁，这里会红**。
 *
 * 判断口径（不是「所有写入都要」）：
 * - 整行覆盖 / 整表替换同一条既有数据 → **必须**带版本参数
 * - 按 id 追加或删除单条子记录 → 不需要：各写各的行，天然不冲突
 * - 按 id 删除 → 不需要：`assertDeleted` 复查行数已能发现「没删掉」
 * - 只改自己那行（`updateMyName`）→ 不需要
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(process.cwd(), 'src/repo/repository.ts'), 'utf8')

/** 必须带乐观锁版本参数的方法（整行覆盖 / 整表替换） */
const VERSIONED = ['savePatient', 'saveSession', 'replaceAdverseReactions']

/** 明确不需要版本参数的方法及理由 */
const NOT_VERSIONED: Record<string, string> = {
  saveDryWeight: '干体重只有新增（新 uuid）与删除，没有「编辑既有记录」入口',
  deleteDryWeight: '按 id 删除，命中 0 行由 assertDeleted 报错',
  deleteSession: '按 id 删除',
  saveBloodPressure: '按 id 追加/更新单条，不同 id 之间不会互相覆盖',
  deleteBloodPressure: '按 id 删除',
  saveBloodGlucose: '同血压',
  deleteBloodGlucose: '按 id 删除',
  saveBloodFlow: '同血压',
  deleteBloodFlow: '按 id 删除',
  importAll: '整库导入，调用前已有「会覆盖本机云端数据」的二次确认',
}

/** 取接口里某个方法的完整签名（含多行参数） */
function signatureOf(name: string): string {
  const start = src.indexOf(`${name}(`)
  if (start < 0) throw new Error(`src/repo/repository.ts 里找不到方法 ${name}`)
  let depth = 0
  let i = start + name.length
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(start, i + 1)
}

describe('乐观锁覆盖守卫', () => {
  it.each(VERSIONED)('%s 带乐观锁版本参数', (name) => {
    expect(signatureOf(name)).toMatch(/expected/)
  })

  it.each(Object.keys(NOT_VERSIONED))('%s 不带版本参数（理由见注释）', (name) => {
    expect(signatureOf(name)).not.toMatch(/expected/)
  })

  /**
   * 关键的一条：新增写方法时这里会红 —— 逼着人去想「这个要不要乐观锁」，
   * 而不是像上次那样漏掉。归类后把方法名加到上面两个清单之一即可。
   */
  it('接口里的写方法都被显式归类（新增写方法必须想清楚要不要乐观锁）', () => {
    const declared = [...src.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1])
    const writes = declared.filter((m) => /^(save|replace|delete|import)/.test(m))
    const classified = [...VERSIONED, ...Object.keys(NOT_VERSIONED)]

    expect(writes.filter((m) => !classified.includes(m))).toEqual([])
    // 反向：清单里不该留下已经删掉的方法
    expect(classified.filter((m) => !writes.includes(m))).toEqual([])
  })

  it('云端实现确实做了版本比对（不是只把参数写在接口上）', () => {
    const cloud = readFileSync(resolve(process.cwd(), 'src/lib/cloudRepository.ts'), 'utf8')
    // 三个方法都必须出现「.eq('updated_at', …)」或 id 集合比对
    expect(cloud).toMatch(/\.eq\('updated_at', expectedUpdatedAt\)/)
    expect(cloud).toMatch(/throw new ConflictError/)
  })

  it('缓存层把新版本号写回对象（否则下一次保存会自己跟自己冲突）', () => {
    const cached = readFileSync(resolve(process.cwd(), 'src/repo/cachedRepository.ts'), 'utf8')
    expect(cached).toMatch(/updatedAtIso = iso/)
  })

  it('冲突恢复路径走 fresh 读（缓存里正是冲突前那份数据）', () => {
    const session = readFileSync(resolve(process.cwd(), 'src/views/SessionView.vue'), 'utf8')
    expect(session).toMatch(/load\(\{ fresh: true \}\)/)
    expect(session).toMatch(/loadSub\(\{ fresh: true \}\)/)

    const settings = readFileSync(resolve(process.cwd(), 'src/views/SettingsView.vue'), 'utf8')
    expect(settings).toMatch(/load\(true, \{ fresh: true \}\)/)
  })

  /**
   * 读取时**必须原样保留**库里的 `updated_at` 字符串。
   *
   * 评审用真实 PostgREST 验过：`Z` 与 `+00:00` 等价、`.071` 与 `.071000` 等价，
   * 但**微秒一旦被截断**（`new Date(r.updated_at).toISOString()` 就是毫秒精度）就 0 命中 ——
   * 那会变成「每次保存都假冲突」，而且只在这种极端组合下才暴露。
   */
  it('读取时不得把 updated_at 转成毫秒（截断微秒 → 每次保存都假冲突）', () => {
    const cloud = readFileSync(resolve(process.cwd(), 'src/lib/cloudRepository.ts'), 'utf8')
    expect(cloud).toMatch(/updatedAtIso: r\.updated_at \?\? null/)
    expect(cloud).not.toMatch(/updatedAtIso: new Date/)
  })

  /**
   * 整行覆盖的每一处调用点都要带版本号（或明确是「新建」不需要）。
   * 曾经漏了 `confirmAbort` 的 `saveSession(s)` —— 它会把对方刚改的体重整段抹掉。
   */
  it('SessionView 里所有整行写入都带版本号', () => {
    const session = readFileSync(resolve(process.cwd(), 'src/views/SessionView.vue'), 'utf8')
    const calls = [...session.matchAll(/repository\.saveSession\(([^)]*)\)/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const args of calls) {
      expect(args, `saveSession(${args}) 没有带乐观锁版本号`).toMatch(/knownUpdatedAtIso|override/)
    }
  })
})
