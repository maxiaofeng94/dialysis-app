import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { probe } from '../../scripts/check-prod-schema.mjs'

const PROD_URL = 'https://vbamprkcwrpsazkyknjq.supabase.co'
const ANON = 'anon-key-fake'

/**
 * 造一个**完全自包含**的沙箱：脚本 + schema.sql 都复制进去。
 *
 * ⭐ 为什么必须沙箱化（第十二轮评审·严重-1 / 严重-2）：
 * 原来的用例 `cwd: process.cwd()` 直接跑仓库里的脚本，于是行为**依赖本机是否恰好有
 * `.env.production`** —— 本地有（开发者机器）就绿、CI 的 tests job 没有就红，
 * 而 CI 的 tests job 根本不创建该文件（唯一写入点在 build job，不同 runner）。
 * 结果是「每次推送 tests 必红」的假红，会训练所有人忽略这条信号。
 *
 * 沙箱里我们自己决定有没有 `.env.production`，两个场景都能稳定断言。
 */
function makeSandbox(opts: { withEnv: boolean; anon?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'schema-cli-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'supabase'), { recursive: true })
  copyFileSync('scripts/check-prod-schema.mjs', join(dir, 'scripts', 'check-prod-schema.mjs'))
  copyFileSync('supabase/schema.sql', join(dir, 'supabase', 'schema.sql'))
  if (opts.withEnv) {
    writeFileSync(
      join(dir, '.env.production'),
      `VITE_SUPABASE_URL=${PROD_URL}\nVITE_SUPABASE_ANON_KEY=${opts.anon ?? 'fake-anon'}\n`,
      'utf8',
    )
  }
  return dir
}

/** 写一个把 fetch 换成「恒返回给定状态」的 stub（--import 预加载，先于主模块生效） */
function writeFetchStub(dir: string, status: number): string {
  const stub = join(dir, 'stub.mjs')
  writeFileSync(
    stub,
    [
      'globalThis.fetch = async () => ({',
      '  ok: false,',
      `  status: ${status},`,
      '  text: async () => JSON.stringify({ code: null }),',
      '})',
      '',
    ].join('\n'),
    'utf8',
  )
  return pathToFileURL(stub).href
}

function runCli(cwd: string, importStub?: string) {
  const args = importStub
    ? ['--import', importStub, join(cwd, 'scripts', 'check-prod-schema.mjs')]
    : [join(cwd, 'scripts', 'check-prod-schema.mjs')]
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, args, { cwd }, (err: any, stdout: string, stderr: string) => {
      resolve({ code: err ? err.code : 0, stdout, stderr })
    })
  })
}

describe('生产库结构检查 · probe 的请求构造（第十二轮评审·严重-1）', () => {
  /**
   * ⭐ 严重-1：`probe()` 靠 `select=<column>` 让 PostgREST 在列不存在时返回 400/42703。
   * 一旦退化成 `select=*`，**列探测永远 200、缺列永远发现不了**，
   * 而脚本照样打印「✅ 一致」exit 0 —— 这就是第十一轮「心率保存报错」那一半事故，
   * 且守卫完全不报警。所以必须精确断言 URL，不能只断言返回值。
   */
  it('列探测的 URL 必须精确是 ?select=<column>&limit=0', async () => {
    const origFetch = globalThis.fetch
    let captured: { url: string; init: any } | null = null
    globalThis.fetch = (async (url: string, init: any) => {
      captured = { url, init }
      return { ok: true, status: 200, text: async () => '' }
    }) as any
    try {
      await probe(PROD_URL, ANON, 'blood_pressures', 'pulse')
      expect(captured!.url).toBe(`${PROD_URL}/rest/v1/blood_pressures?select=pulse&limit=0`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('表探测的 URL 必须是 select=*', async () => {
    const origFetch = globalThis.fetch
    let captured = ''
    globalThis.fetch = (async (url: string) => {
      captured = url
      return { ok: true, status: 200, text: async () => '' }
    }) as any
    try {
      await probe(PROD_URL, ANON, 'users', '*')
      expect(captured).toBe(`${PROD_URL}/rest/v1/users?select=*&limit=0`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('probe 必须带 apikey 与 Authorization 头', async () => {
    const origFetch = globalThis.fetch
    let captured: any = null
    globalThis.fetch = (async (_url: string, init: any) => {
      captured = init
      return { ok: true, status: 200, text: async () => '' }
    }) as any
    try {
      await probe(PROD_URL, ANON, 'users', '*')
      expect(captured.headers.apikey).toBe(ANON)
      expect(captured.headers.Authorization).toBe(`Bearer ${ANON}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('生产库结构检查 · CLI 退出码（第十二轮评审·严重-2）', () => {
  /**
   * ⭐ 严重-2：pre-push 第 ④ 步只认**进程退出码**，
   * 而所有其它用例都是 import 后直接调 runCheck() —— 「runCheck 返回 1」
   * 不等于「进程 exit 1」。把 process.exit(r.code) 改成 exit(0)、
   * 或把 isMain 改成恒假，其余用例全绿，而 pre-push 会直接放行。
   * 所以必须启动**真实子进程**跑 CLI。
   */
  it(
    'CLI：全 401（anon key 失效）时进程退出码必须是 1',
    async () => {
      const dir = makeSandbox({ withEnv: true })
      try {
        const stub = writeFetchStub(dir, 401)
        const r = await runCli(dir, stub)
        expect(r.code).toBe(1)
        // 防「isMain 恒假时静默无输出」：必须真的跑起来了
        expect(r.stdout).toContain('检查目标：')
        // ⭐ 证明 stub 真的生效了（否则可能真打了网络 → flaky）：
        // 真网络不会对全部 97 项探测都返回 401，且脚本会把 401 归为「无法判定」
        expect(r.stderr).toContain('401')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )

  it(
    'CLI：.env.production 缺失时退出码必须是 1，且 stdout 为空、stderr 说明原因',
    async () => {
      // ⭐ 原来这条写成 `if (existsSync('.env.production')) return` ——
      // 在有配置的开发者机器上静默 0 断言，vitest 却统计成「通过」，
      // 报告里看不出它从没执行过（第十二轮评审·严重-2）。
      // 现在用沙箱：我们自己决定有没有该文件，任何环境都真跑。
      const dir = makeSandbox({ withEnv: false })
      try {
        const r = await runCli(dir)
        expect(r.code).toBe(1)
        // 没读到配置就退出，不会走到「检查目标」那行
        expect(r.stdout).toBe('')
        expect(r.stderr).toContain('.env.production')
        expect(r.stderr).toContain('找不到')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )

  it(
    'CLI：结构齐全时退出码必须是 0（防「恒 exit 1」的假红）',
    async () => {
      const dir = makeSandbox({ withEnv: true })
      try {
        // 全部探测成功 → 应 exit 0
        const stub = join(dir, 'stub-ok.mjs')
        writeFileSync(
          stub,
          'globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "" })\n',
          'utf8',
        )
        const r = await runCli(dir, pathToFileURL(stub).href)
        expect(r.code).toBe(0)
        expect(r.stdout).toContain('一致')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
})
