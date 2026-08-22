# 透析记录 App

透析病人体重与生命体征记录系统（PWA），一套代码支持**华为 / 苹果手机**，可免费部署。

## 功能一览

- **快速创建**：首页一键记录「上机前体重（含轮椅）」，自动扣轮椅重量、算计划脱水量
- **体重与脱水**：上/下机体重、计划脱水量、实际脱水量、回水量（固定 300ml）、机器超滤设置
  - 只填上机前体重 → 仅显示计划脱水量；填了下机后体重 → 计划 + 实际都显示
- **血压**：手动记录高压 / 低压（每小时一次）
- **血糖**：mmol/L，每次透析 1 次
- **不良反应**：呕吐、腿脚无力、头晕、低血压、抽筋、头痛、其他（多选 + 自定义文字）
- **报告**：汇总页、导出图片 / PDF、分享给医生
- **趋势**：体重、血压历史曲线
- **干体重历史**：按日期取「当时有效干体重」，历史记录稳定
- **数据**：手机本地存储（IndexedDB）、JSON 备份 / 恢复、记录人字段

## 技术栈

Vue 3 · Vite · TypeScript · Vant 4 · Dexie(IndexedDB) · ECharts · vite-plugin-pwa · html2canvas

## 本地运行

```bash
cd dialysis-app
npm install
npm run dev      # 打开 http://localhost:5173
```

## 构建与预览

```bash
npm run build    # 产物在 dist/
npm run preview  # 预览构建产物
```

## 部署（免费）

把 `dist/` 上传到任意静态托管即可（PWA 需 HTTPS）：

- Cloudflare Pages / Vercel / Netlify（免费）
- Gitee Pages / 腾讯云 Webify（国内访问更快）

手机上用浏览器打开网址，点「添加到主屏幕」即可像 App 一样全屏使用（iOS Safari、华为浏览器均支持）。

## 使用流程

1. 「设置」→ 建立病人档案（姓名、生日、轮椅重量、回水量），并添加当前干体重
2. 「记录」页 → 「快速创建」填上机前体重（含轮椅）
3. 进入详情页补录下机后体重、血压、血糖、不良反应
4. 「标记完成」→「查看报告」导出图片 / PDF 发给医生

## 目录结构

```
src/
  types.ts            数据模型
  constants.ts        常量与不良反应字典
  utils/              计算、格式化、id
  db/database.ts      IndexedDB(Dexie) 表结构
  repo/               数据访问抽象(本地实现 + 接口)
  router/             路由
  components/         BaseChart 图表封装
  views/              Home/Session/Report/Trend/Settings
docs/需求与设计文档.md  完整需求与设计文档
```

## 设计文档

完整需求、页面原型、数据库设计（含未来多人扩展）见 `docs/需求与设计文档.md`。

## 未来扩展（多人 / 多设备）

当前为本地单人版；数据访问走 `Repository` 接口。未来加 `users`、`patientMembers` 表 + 登录 + 行级权限（RLS），前端业务逻辑与计算公式无需改动。详见设计文档。
