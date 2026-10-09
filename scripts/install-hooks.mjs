#!/usr/bin/env node
/**
 * 注册仓库自带的 git 钩子（.githooks/）
 *
 * 通过 package.json 的 `prepare` 钩子自动执行：`npm install` / `npm ci` 之后就会跑一次，
 * 所以正常情况下你不需要手动调用它。也可以随时手动执行：`npm run hooks:install`。
 *
 * 注意：git 的钩子目录属于**本地配置**，不随仓库分发 —— 这正是需要每次安装依赖时重新注册的原因。
 *
 * 在非 git 环境（例如把源码打包后安装）里静默跳过，绝不能让 npm install 失败。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hooksDir = join(root, '.githooks')

/** 非致命退出：prepare 阶段不能因为这里失败而让 npm install 挂掉 */
function skip(reason) {
  console.log(`[hooks] 跳过 git 钩子安装：${reason}`)
  process.exit(0)
}

if (!existsSync(hooksDir)) skip('找不到 .githooks 目录')
if (!existsSync(join(root, '.git'))) skip('不是 git 工作区（.git 不存在）')

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' })
} catch {
  skip('git 不可用或当前目录不在仓库内')
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' })
} catch (err) {
  skip(`git config 失败：${err instanceof Error ? err.message : String(err)}`)
}

// Linux/macOS 上钩子必须有可执行位；Windows 会忽略，无害
for (const name of readdirSync(hooksDir)) {
  try {
    chmodSync(join(hooksDir, name), 0o755)
  } catch {
    // 忽略：Windows 上不支持 POSIX 权限位
  }
}

console.log('✅ 已启用仓库钩子：core.hooksPath = .githooks')
console.log('   · git push 前会自动跑「类型检查 + 全部测试」')
console.log('   · 临时跳过：SKIP_TESTS=1 git push')

