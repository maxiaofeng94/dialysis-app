import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * 测试配置（与 vite.config.ts 分离）
 *
 * 关键约定：
 * 1. `import.meta.env.VITE_SUPABASE_*` 被强制为 undefined —— 测试默认跑在「纯本地单机模式」，
 *    结果不依赖本机 .env / CI 的 secrets，任何人任何机器跑出来一致。
 *    需要验证云端分支的用例，用 vi.mock('.../lib/supabase') 显式注入假客户端（见 tests/helpers/cloud.ts）。
 * 2. Edge Function 源码里写的是 Deno 说明符 npm:@supabase/supabase-js@2，这里 alias 到本地依赖，
 *    使 supabase/functions/** 的纯逻辑可以在 Node 下直接被测（配合 tests/helpers/edge.ts 注入 Deno 全局）。
 * 3. 覆盖率只统计「被测得到的产品代码」，排除纯模板/入口/类型声明。
 */
export default defineConfig({
  plugins: [vue()],
  // 关键：把 .env 的加载目录指向一个不存在的路径。
  // Vite 会照常加载 .env 文件并注入 import.meta.env，test.env 覆盖不掉它 ——
  // 本机 .env 连的是测试库，若被带进测试，同一份用例在本地和 CI 上结果会不一致。
  // 指走之后 import.meta.env.VITE_SUPABASE_* 恒为空 = 恒定跑「纯本地单机模式」；
  // 要验证云端分支，用 vi.mock('.../lib/supabase') 显式注入（见 tests/helpers/cloud.ts）。
  envDir: fileURLToPath(new URL('./tests/.no-env', import.meta.url)),
  resolve: {
    alias: {
      'npm:@supabase/supabase-js@2': '@supabase/supabase-js',
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup/setup.ts'],
    include: ['tests/**/*.spec.ts'],
    // 双保险：即便 envDir 失效，也希望 import.meta.env 里是空串（setup.ts 会断言）
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    },
    // 视图/仓储用例之间通过 IndexedDB 隔离，禁止并发写同一个库
    fileParallelism: true,
    // CI runner 只有 2 核 / 7GB，43 个 jsdom 环境同时起容易把内存吃满；
    // 现象是「所有测试都通过、但 vitest 退出码为 1」（进程被 OOM 干掉时输出已刷完）。
    // 同一提交在不同 workflow 里一次失败一次成功，就是这个原因。CI 上降到 4 并发，本地全速。
    ...(process.env.CI ? { maxWorkers: 4, minWorkers: 1 } : {}),
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,vue}', 'supabase/functions/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/admin/main.ts',
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
        // 纯类型/接口文件：编译后没有可执行代码，统计进来只会拉低分母
        'src/types.ts',
        'src/admin/lib/types.ts',
        'src/repo/repository.ts',
        'supabase/functions/**/*.d.ts',
      ],
      // 阈值按「当前真实水位」设置：低于此线说明有功能退化，CI 直接红
      // 实测水位（1348 个用例）：statements 89.5% / branches 87.1% / functions 86.8% / lines 91.3%
      // 留约 4 个点的余量：小改动不会误报，但「删掉一批测试」或「加一大块没测的代码」会立刻红。
      // 阈值只允许上调；要下调必须在提交信息里写清原因。
      thresholds: {
        statements: 85,
        branches: 83,
        functions: 82,
        lines: 87,
      },
    },
  },
})
