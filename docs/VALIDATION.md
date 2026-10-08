# MVP 验证记录

## 软件设置与 LLM 配置验证（2026-10-08）

本工作分支集成后实际运行：

- `bun run test`：15 文件、153 项通过，含设置校验、串行保存、私有权限、原子写入、重启恢复、密钥保留/删除、同源拒绝、在途 provider 快照及主题存储故障。
- `bun run build`：TypeScript 与生产构建通过；仍有大 chunk 警告（主包约 622 kB，ELK 约 1.44 MB）。
- `MESHNOTE_E2E_PORT=18878 bun run test:e2e -- --config=playwright.production.config.ts`：完整 Chromium 10 项通过，实际启动/关闭 Node 生产服务，使用测试专属配置文件。
- 新浏览器路径覆盖明暗切换与刷新、布局恢复、保留选中节点、未保存草稿确认、连接错误清洗、生成期间禁用保存、受控真实 API 测试、无需刷新切换模型、密钥留空保留/明确删除；新输入密钥未进入 localStorage/sessionStorage，配置接口不返回密钥。
- 已检查暗色设置页面截图 `test-results/settings-dark.png`。默认开发 E2E 因 5173/8787 已占用无法启动，未停止其他服务；生产流程使用空闲端口完整复验。

完整日志：`/tmp/meshnote-w4-tests-final.log`、`/tmp/meshnote-w4-build-final.log`、`/tmp/meshnote-w4-e2e-production-final.log`。失败日志保留：`/tmp/meshnote-w4-e2e-dev.log`（端口占用）、`/tmp/meshnote-w4-e2e-final.log`（新增测试误把收到首个 delta 前的 pending 状态当作 streaming；改为断言生成控制按钮后完整重跑通过）。

真实外网供应商未实测；连接测试仅证明最小非流式请求可用，不代表完整 SSE 兼容。服务端密钥为 0600 明文文件，单进程保存，不支持多服务进程共用配置文件。

以下为此前 MVP 历史验证记录。

## 实际运行

环境：Bun 1.4.2、Node v24.20.0、Linux、Playwright Chromium。包管理与命令入口已由 npm 切换为 Bun（`bun install` / `bun run`），Vite、Vitest、Playwright 与本地服务运行时仍由 Node 承载。

| 命令 | 结果 |
|---|---|
| `bun install` | 完成，`bun.lock` 已提交（由 `package-lock.json` 迁移） |
| `bun audit` | 0 vulnerabilities（281 packages） |
| `bun run build` | TypeScript 与 Vite 构建通过 |
| `bun run test` | 11 文件、93 测试通过 |
| `bun run test:e2e` | 6 Chromium 测试通过（开发服务） |
| `bun run test:e2e -- --config=playwright.production.config.ts` | 同 6 测试通过（Node 托管 production dist） |

浏览器测试自动启动、关闭实际服务，不是只检查 React 组件输出。`docs/images/demo-workspace.png` 来自生产服务的真实 Chromium 截图。

## 覆盖内容

- Demo 八节点七连接、首次初始化、Mesh CRUD 与级联清理。
- 历史节点创建两个兄弟分支，先出现节点再流式更新；刷新问答与边保留。
- 祖先路径只发送 root→selected，排除兄弟；循环、多父、跨 Mesh、缺失引用的错误处理。
- 初始布局、上→下方向、碰撞检测、增量布局旧坐标不变、通用图与显式重排。
- 点击/搜索/键盘激活选中、跨 Mesh 定位、相机居中、拖动或方向键移动后坐标刷新保留。
- 取消保留部分回答、标题失败保留 fallback、截断流不假装成功。
- IndexedDB 原子写入、存储错误、中断恢复、删除后 Demo 不复活。
- 上游 SSE 跨字节/多行/结束标识、HTTP/协议错误、代理安全边界和静态服务。

## 集成中修复

受控 React Flow 节点必须保留尺寸/handle 元数据；否则在异步布局及 snapshot 更新时，远端节点测量和边初始化可能丢失，导致首次 fit/定位不可靠。现在卡片尺寸固定，显式提供 measured 与 handle 几何，配合可视区域渲染；开发和生产端到端均重新运行通过。

首次浏览器下载命令超过执行时限，但完整 Chromium 已下载，后续通过 Playwright `channel: chromium` 实际运行成功，不依赖未完成下载的独立 headless-shell。

## 限制与风险

- **未提供真实供应商 key**：真实模型协议通过本机模拟上游测试，未声称完成外网供应商实测。
- Vite 提示 chunk > 500 kB：主包约 609 kB（gzip 195 kB），懒加载 ELK 约 1.44 MB（gzip 438 kB）。没有隐藏此警告；布局 worker 化与进一步拆包留待性能阶段。
- 未验证千节点性能、Firefox/Safari、Electron 包装、跨标签并发或公网部署。
- 核心与代理子任务的提交已由 runtime 合入本开发分支，随后子任务因连接故障被标记 cancelled，其代码由父 Worker 重新验证。UI 子任务最初连接失败，后恢复并针对固定父提交 `bf0196d` 完成源侧适配：保留父侧已验证工作台，补齐键盘选择/移动持久化和 3 项布局回归测试，合入为 `e026d35`。父 Worker 复核后新增持久的键盘浏览器测试，全量重跑通过并验收 UI 子任务；未将 cancelled 子任务误作已验收。

## 本次运行日志

本机临时完整日志（不作为运行依赖）：

- Bun 迁移后复验：`/tmp/meshnote-bun-build.log`、`/tmp/meshnote-bun-test.log`、`/tmp/meshnote-bun-audit.log`、`/tmp/meshnote-bun-e2e.log`、`/tmp/meshnote-bun-e2e-prod.log`
- 前次 npm 运行：`/tmp/meshnote-build-restored.log`
- `/tmp/meshnote-unit-restored.log`
- `/tmp/meshnote-e2e-restored.log`
- `/tmp/meshnote-production-restored.log`
- 集成失败诊断保留在 `/tmp/meshnote-e2e-5.log`、`/tmp/meshnote-e2e-6.log`，之后对应问题已修复并全量重跑。
