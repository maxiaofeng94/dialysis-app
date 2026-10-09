/**
 * CI 门禁结构守卫
 *
 * 这些 workflow 文件不会参与 vue-tsc 类型检查，YAML 写错、`needs` 被误删
 * 都只会在推送之后才暴露 —— 而「部署在工作流里是否真的被测试挡住」
 * 恰恰是本项目最重要的一条发布安全属性。这里用结构化解析把它固化下来。
 *
 * 注意：`on` 在 YAML 1.1 里会被解析成布尔 true，所以访问时做了兼容。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const WF_DIR = join(process.cwd(), '.github/workflows')

function loadWorkflow(file: string): any {
  return parse(readFileSync(join(WF_DIR, file), 'utf8'))
}

/** `on:` 在部分解析器下会变成布尔键 true */
function triggers(doc: any): any {
  return doc.on ?? doc[true as unknown as string] ?? {}
}

/** needs 可能是字符串或数组，统一成数组 */
function needsOf(job: any): string[] {
  const n = job?.needs
  if (!n) return []
  return Array.isArray(n) ? n : [n]
}

/** 把某个 job 的所有 run 步骤拼起来，便于做包含判断 */
function runScript(job: any): string {
  return (job?.steps ?? [])
    .map((s: any) => s?.run ?? '')
    .filter(Boolean)
    .join('\n')
}

const workflowFiles = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

describe('CI 门禁 · 语法与完整性', () => {
  it('存在测试工作流与被调用的门禁文件', () => {
    expect(workflowFiles).toContain('test.yml')
    expect(workflowFiles).toContain('ci.yml')
    expect(workflowFiles).toContain('deploy.yml')
    expect(workflowFiles).toContain('deploy-admin.yml')
    expect(workflowFiles).toContain('build-apk.yml')
  })

  it.each(workflowFiles)('%s 是合法 YAML 且每个 job 都有 runs-on 或 uses', (file) => {
    const doc = loadWorkflow(file)
    expect(doc, `${file} 解析后为空`).toBeTruthy()
    expect(doc.jobs, `${file} 没有 jobs`).toBeTruthy()
    for (const [name, job] of Object.entries<any>(doc.jobs)) {
      const ok = Boolean(job['runs-on'] || job.uses)
      expect(ok, `${file} 的 job「${name}」既没有 runs-on 也没有 uses`).toBe(true)
    }
  })
})

describe('CI 门禁 · test.yml 是唯一定义', () => {
  const doc = loadWorkflow('test.yml')

  it('可被其它工作流调用（on: workflow_call）', () => {
    expect(triggers(doc)).toHaveProperty('workflow_call')
  })

  it('含「测试」与「构建」两个 job', () => {
    expect(Object.keys(doc.jobs)).toEqual(expect.arrayContaining(['tests', 'build']))
  })

  it('测试 job 跑带覆盖率的测试（覆盖率阈值在这里生效）', () => {
    const script = runScript(doc.jobs.tests)
    expect(script).toMatch(/npm run test:coverage|vitest run --coverage/)
  })

  it('构建 job 覆盖 App 构建、后台构建与后台冒烟', () => {
    const script = runScript(doc.jobs.build)
    expect(script).toMatch(/npm run build\b/)
    expect(script).toMatch(/npm run build:admin/)
    expect(script).toMatch(/npm run smoke:admin/)
    // 后台产物入口必须校验，否则 Pages 根路径 404
    expect(script).toMatch(/dist-admin\/index\.html/)
  })
})

describe('CI 门禁 · 调用方都真的被挡住', () => {
  it('ci.yml 在 push 与 PR 都触发，并调用 test.yml', () => {
    const doc = loadWorkflow('ci.yml')
    const on = triggers(doc)
    expect(on).toHaveProperty('push')
    expect(on).toHaveProperty('pull_request')
    expect(doc.jobs.test.uses).toBe('./.github/workflows/test.yml')
  })

  it.each(['deploy.yml', 'deploy-admin.yml', 'build-apk.yml'])(
    '%s 先跑测试门禁，发布 job 依赖它（needs: test）',
    (file) => {
      const doc = loadWorkflow(file)
      const testJob = doc.jobs.test
      expect(testJob, `${file} 缺少 test 门禁 job`).toBeTruthy()
      expect(testJob.uses, `${file} 的 test job 没有复用 test.yml`).toBe('./.github/workflows/test.yml')

      // 真正的发布动作：App 部署 / 后台部署 / APK 构建
      const publishJobName = doc.jobs.deploy ? 'deploy' : 'build'
      const publishJob = doc.jobs[publishJobName]
      expect(publishJob, `${file} 缺少 ${publishJobName} job`).toBeTruthy()
      expect(
        needsOf(publishJob),
        `${file} 的 ${publishJobName} 没有 needs: test —— 测试挂了也会照常发布`,
      ).toContain('test')
    },
  )

  it('发布类工作流都把仓库 secrets 传给门禁（构建 job 需要 VITE_SUPABASE_*）', () => {
    for (const file of ['ci.yml', 'deploy.yml', 'deploy-admin.yml', 'build-apk.yml']) {
      const doc = loadWorkflow(file)
      expect(doc.jobs.test.secrets, `${file} 的 test job 没有 secrets: inherit`).toBe('inherit')
    }
  })
})
