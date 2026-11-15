# iOS 可安装包：可行实现方案对比

> 生成时间：2026-10-01
> 项目：`D:\ai\project\dialysis-app`（Vue 3 + Vite + Capacitor 6，已有 Android APK）
> 结论先行：**iOS 不存在「在 Windows 上直接产出可安装包」的官方路径**。可行路线分两大类——PWA（零成本、零 Mac）与原生 IPA（必须 macOS + Apple 签名）。

---

## 零、先明确一个硬约束

| 事实 | 说明 |
|---|---|
| IPA 必须在 macOS 上构建 | iOS 编译器、iOS SDK、CocoaPods/SPM、codesign 只随 Xcode 提供，Apple 未授权任何 Windows 工具链 |
| 签名必须由 Apple 签发 | 免费 Apple ID = 7 天个人证书；付费开发者账号 = 1 年证书 |
| 安装到 iPhone 必须有合法签名 | 无论是 Xcode 直连、Ad Hoc、TestFlight 还是 App Store |
| 例外 | **PWA 不需要签名**——通过 Safari「添加到主屏幕」即可获得桌面图标 |

因此「生成 iOS 安装包」实际要在下面 4 条路线里选一条。

---

## 一、方案总览

| # | 方案 | 需要 Mac | 需要 $99/年 | 有效期 | 分发能力 | 原生插件 | 落地成本 |
|---|---|---|---|---|---|---|---|
| **A** | PWA 添加到主屏幕 | ❌ | ❌ | 长期（建议定期导出备份） | 发链接即可，无设备数限制 | ❌ 无 Filesystem/Share | ⭐ 最低，今天就能用 |
| **B** | Capacitor iOS + Xcode 免费自签 | ✅ | ❌ | **7 天**，需重签 | 仅 1 台（插线）或 3 台（AltStore） | ✅ 全支持 | 中 |
| **C** | 开发者账号 + Ad Hoc 分发 | ✅（仅首次） | ✅ | **1 年** | ≤100 台，UDID 白名单 | ✅ 全支持 | 中高 |
| **D** | 开发者账号 + TestFlight | ✅（仅首次） | ✅ | 构建 90 天 | ≤10000 人，链接邀请 | ✅ 全支持 | 高（要过审核） |

> B/C/D 的「需要 Mac」在无 Mac 时可替换为**云 Mac 租用**（见第四节）。

---

## 二、方案 A：PWA 添加到主屏幕（推荐先做）

项目**已经具备全部 PWA 条件**，无需改代码即可上线：

- ✅ `vite-plugin-pwa` 已配置（`vite.config.ts`）
- ✅ `index.html` 已含 `apple-mobile-web-app-capable`、`apple-touch-icon`、`viewport-fit=cover`
- ✅ 已生成 `dist/manifest.webmanifest` + `sw.js`（离线可用）
- ✅ 图标齐备：`apple-touch-icon.png`、`pwa-192.png`、`pwa-512.png`

### 落地步骤

1. **部署 `dist/` 到 HTTPS 静态托管**（PWA 强制要求 HTTPS）
   - 国内访问快：腾讯云 Webify / Gitee Pages / 阿里云 OSS+CDN
   - 免费国际：Cloudflare Pages / Vercel / Netlify
   ```powershell
   cd D:\ai\project\dialysis-app
   npm run build        # 产物在 dist/
   # 将 dist/ 整个目录上传
   ```
2. **iPhone 上的安装动作**
   - Safari 打开网址 → 底部分享按钮 → 「添加到主屏幕」→ 命名「透析记录」
   - 之后从桌面图标启动，**全屏无地址栏**，与原生 App 观感一致
3. **验证清单**
   - [ ] 图标显示正常（不再是网页截图缩略图）
   - [ ] 启动后无 Safari 地址栏
   - [ ] 断网后仍能打开（Service Worker 生效）
   - [ ] 记录一条数据 → 杀掉 App 重开 → 数据仍在（IndexedDB 持久化）

### 必须处理的 iOS 适配点

| 问题 | 现状 | 处理方式 |
|---|---|---|
| **JSON 备份导出** | `SettingsView.vue:124-129` 走 `downloadBlob`（`<a download>`）。iOS Safari 对 blob URL + download 支持不完整，可能只是新开标签页 | 改为 `navigator.share({ files: [file] })` + 兜底 |
| **报告图片分享** | `ReportView.vue:139-147` 已用 `navigator.share` + `canShare` 检测 | ✅ 已适配，无需改动 |
| **存储配额** | 主屏幕 PWA 的 storage 有独立配额，非无限 | 定期导出 JSON 备份；当前数据量（纯文本）远不会触顶 |
| **存储持久化** | iOS ITP 的「7 天清除脚本可写存储」针对 Safari 浏览器标签页；添加到主屏幕后独立运行 | 建议仍加 `navigator.storage.persist()` 申请持久化，并保留定期备份习惯 |
| **安全区** | 已用 `viewport-fit=cover` + `black-translucent` | 检查顶部标题栏是否被刘海/灵动岛遮挡，必要时给 `van-nav-bar` 加 `padding-top: env(safe-area-inset-top)` |
| **启动画面** | 未配置 | 可选：加 `apple-touch-startup-image`，消除启动白屏 |

### 结论

**这是本项目性价比最高的 iOS 方案**：0 成本、0 Mac、0 审核、改一次链接全家人可用。唯一代价是没有 Capacitor 原生插件，以及需要把导出逻辑改成 Web Share API（约 10 行代码）。

---

## 三、方案 B/C/D：Capacitor 原生 iOS 包

### 共同的前置步骤（在 macOS 上执行一次）

```bash
# 1. 项目根目录，安装 iOS 平台包
npm i @capacitor/ios@^6

# 2. 构建 Web 产物并生成 iOS 工程
npm run build
npx cap add ios          # 生成 ios/App/App.xcworkspace
npx cap sync ios         # 拷贝 dist/ + 安装 pod 依赖

# 3. 打开 Xcode
npx cap open ios
```

> **现有插件全部兼容 iOS**：`@capacitor/filesystem`、`@capacitor/share` 均在 `node_modules/@capacitor/` 中，Capacitor 6 官方插件都提供 iOS 实现，**代码里的 `Capacitor.isNativePlatform()` 分支无需修改**——一旦跑在 iOS 原生壳里，导出就会自动走原生分享面板，比 PWA 体验更好。

### Xcode 内必做的 4 项配置

1. **Signing & Capabilities** → Team 选你的 Apple ID；Bundle Identifier 保持 `com.dialysis.record`（与 `capacitor.config.json` 一致，不可与他人重复）
2. **Deployment Target** ≥ iOS 13.0（Capacitor 6 要求），按家人的 iPhone 系统版本可上调
3. **Icons**：替换默认图标（沿用现有 `pwa-512.png` 即可，需生成 1024×1024 无透明通道版本）
4. **Info.plist**：若后续加相机等功能再补权限描述，当前功能集**不需要任何权限声明**（这是本项目的一大优势，也意味着上架审核阻力小）

---

### 方案 B：免费 Apple ID 自签（无 $99）

| 项 | 内容 |
|---|---|
| 产出 | 无需显式导出 IPA，Xcode 直连 iPhone 点 Run 即安装 |
| 有效期 | **7 天**，到期 App 打不开，必须重新连接 Mac 用 Xcode 重装 |
| 设备数 | Xcode 直连 1 台；用 AltStore/Sideloadly 可到 3 台 |
| 数据 | 重签覆盖安装**保留数据**（与 Android 覆盖安装同理） |

**适用于**：有 Mac 可随时用，或愿意接受每周重签的调试期。

**无 Mac 时的替代**：租云 Mac 产出 IPA，再用 Windows 上的 [AltStore](https://altstore.io/) / Sideloadly 自签安装（AltStore 支持同一 Wi-Fi 下自动续签，缓解 7 天到期问题，但需要一台常开的电脑）。

---

### 方案 C：开发者账号 + Ad Hoc 分发（长期自用首选）

| 项 | 内容 |
|---|---|
| 成本 | Apple Developer Program **$99/年**（国内 ¥688/年） |
| 有效期 | 证书 1 年，到期需重新签名分发 |
| 设备数 | **≤100 台**，需提前登记设备 UDID |
| 安装方式 | Mac 上 Xcode `Archive` → 导出 Ad Hoc IPA → 用 Apple Configurator / 爱思助手 / iMazing 装机 |

**步骤**：
1. 注册开发者账号 → 在 Certificates, Identifiers & Profiles 登记家人 iPhone 的 UDID（可用爱思助手读取）
2. 创建 **Ad Hoc** Provisioning Profile 并下载
3. Xcode 签名配置选该 Profile → `Product > Archive` → `Distribute App > Ad Hoc` → 导出 `.ipa`
4. Windows 上用爱思助手 / iMazing 把这个 IPA 装到已登记 UDID 的 iPhone 上

**优点**：一次签名，一年内随时重装，不需要 Mac 常驻。
**缺点**：每年续费；换新手机要重新登记 UDID；证书到期后需重新出包。

---

### 方案 D：TestFlight（想省去装机线缆时）

| 项 | 内容 |
|---|---|
| 成本 | $99/年 |
| 有效期 | 每个构建 **90 天**，到期需上传新构建 |
| 人数 | 外部测试 ≤10000 人，链接邀请 |
| 障碍 | 需通过 **App Review** 审核才能对外测试 |

**对本项目的风险**：医疗健康类应用即使只是个人记录，也可能被要求提供隐私政策、数据用途说明，甚至被质疑「个人健康数据 App 无需上架」。审核不通过则白白等待。

**建议**：仅在有分发需求时选；纯家人自用，Ad Hoc（方案 C）更直接。

---

## 四、无 Mac 时如何获得 IPA

| 途径 | 说明 | 可靠性 |
|---|---|---|
| **云 Mac 租用** | MacStadium、MacinCloud、AWS EC2 Mac 实例（按小时计费，约 $1-3/小时）。装上 Xcode + 拉 Git 仓库 + `npx cap sync ios`，1-2 小时可出包 | ⭐⭐⭐⭐⭐ 与本地 Mac 完全等价 |
| **GitHub Actions `macos-latest` runner** | 免费额度 2000 分钟/月。可写 workflow 自动 `npm ci && npm run build && npx cap sync ios && xcodebuild archive`，产出未签名 IPA 工件 | ⭐⭐⭐⭐ 需自行处理签名（可只出未签名 IPA，再本地自签） |
| **Codemagic / Ionic Appflow** | 移动端专用 CI，有 Capacitor 模板，能托管证书并直接出签名 IPA。免费额度有限，超出收费 | ⭐⭐⭐⭐ 上手最快 |
| **XTool / isoc 等 Windows 工具** | 社区项目，可在 Windows/Linux 编译部分 iOS 程序。对 Capacitor 这类依赖完整 iOS SDK + CocoaPods 的工程**不实用** | ⭐ 不推荐 |
| **第三方代签 / 企业证书 / 超级签名** | 淘宝、微商常见服务，几十到几百元 | ⭐ 高风险：证书随时被吊销导致 App 集体失效；且你把患者的健康数据 App 交给不明第三方签名，隐私上不可接受 |

---

## 五、决策建议

| 你的情况 | 推荐 |
|---|---|
| 只想让家人在 iPhone 上用起来，越快越好 | **方案 A（PWA）** —— 部署一次即可，无任何 Apple 环节 |
| 接受每周点一次重签，且手边有 Mac 或愿意租云 Mac | 方案 B |
| 愿意付 $99/年，要「像正常 App 一样」长期稳定 | **方案 C（Ad Hoc）** —— 本项目功能集不需要权限，签名阻力最小 |
| 未来想给多个病友家庭分发 | 方案 C 扩到 100 台，或评估方案 D |

**我的建议**：先落 **A**（今天可完成，顺便把导出逻辑改成 Web Share API，这一改动对原生包同样有益），把家人的使用跑顺；若确实遇到 PWA 无法满足的点（如需要后台通知、需要访问文件系统特定目录），再上 **C**。

---

## 六、若走 PWA 路线，待改代码清单

| 文件 | 改动 | 工作量 |
|---|---|---|
| `src/views/SettingsView.vue:124-129` | 导出 JSON 时优先用 `navigator.share({ files })`，失败再 `downloadBlob` | ~15 行 |
| `src/main.ts`（或 App 挂载处） | 启动时调用 `navigator.storage?.persist?.()` 申请持久化存储 | ~5 行 |
| `index.html` | 可选：加 `apple-mobile-web-app-title`、启动图 `apple-touch-startup-image` | ~3 行 |
| 全局样式 | 可选：安全区内边距微调（真机验证后再决定） | 视情况 |

---

## 七、参考链接

- [Capacitor 官方文档 · iOS 平台](https://capacitorjs.com/docs/ios)
- [Capacitor 6 升级说明（Xcode 15.0+ 要求）](https://capacitorjs.com/docs/v7/updating/6-0)
- [Capacitor · Deploying to App Store](https://capacitorjs.com/docs/ios/deploying-to-app-store)
- [Apple Developer Program 价格与设备限额](https://developer.apple.com/programs/)
- [AltStore 自签工具](https://altstore.io/)
- [WebKit Bug 232302：主屏幕 Web App 的存储清除行为讨论](https://wiki.webkit.org/show_bug.cgi?id=232302)
