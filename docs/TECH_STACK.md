# MeshNote 技术方案

## 决策

- **React + TypeScript + Vite**：桌面优先 Web MVP。单 package，避免空壳 monorepo；领域与适配器边界支持以后提取 core/web/electron。
- **React Flow (@xyflow/react)**：图为视觉中心，自定义紧凑卡片、缩放、拖动画布、选中、定位、MiniMap 和键盘可访问性均可复用。React 卡片可以直接表达问答节点状态。
- **ELK.js layered / RIGHT**：初始布局与用户主动重排使用左→右分层布局。新增节点采用固定旧位置的增量放置，避开已有卡片；不因 streaming/title 变化重新布局。主动重排是恢复全局紧凑性的显式操作。
- **Zustand**：管理视图选择、搜索与 application snapshot；领域生命周期不放入组件。
- **普通 CSS + design tokens**：安静、紧凑、专业的三栏工作台，不引入非必要 UI 框架。
- **IndexedDB**：本地事务持久化，由 Repository adapter 封装；SQLite 可以替换，不允许 UI 直接操作存储。
- **LLMProvider**：chat 的 AsyncIterable 流式接口，generateTitle / summarize 独立能力。Mock 与 OpenAI-compatible 实现可替换。
- **本地 Node HTTP 代理**（用户已确认）：密钥只读服务端环境变量。开发时 Vite 转发 /api；生产本机运行 Node 服务并托管 dist。默认不配置 key 即 Mock；不实现公网账号/权限系统。
- **Vitest + Playwright**：领域/流协议/存储测试与真实 Chromium 用户流程测试。

## 图引擎比较

| 方案 | 优点 | 本项目取舍 |
|---|---|---|
| React Flow | 自定义 React 节点，交互和 TS 成熟，内置导航 | 最匹配可交互知识步骤；采用 |
| Cytoscape.js | 图算法及复杂关系强 | 富内容 React 卡片需额外桥接，本期算法收益较小 |
| Sigma.js | WebGL 大规模网络 | 数万节点渲染强，但紧凑表单式卡片与分层探索 UX 需大量定制 |
| D3.js | 布局/视觉自由度极高 | 相机、选中、键盘、节点交互均需自行搭建 |
| Dagre | 小巧易用的有向分层布局 | 可用于简单树；ELK 的分层与端口选项更适合未来通用 Graph |
| ELK.js | 通用图分层与交叉优化 | 是布局器而非交互库，与 React Flow 配合 |

## 性能与边界

MVP 优先几十到几百个知识节点；采用可视区域渲染、固定卡片尺寸、memo、布局与回答更新分离。几千节点的实际性能必须后续基准测试，不能仅凭选库保证。增量固定布局牺牲部分全局紧凑性，换取 mental map stability；后续可引入子图布局、折叠和 worker 化。
