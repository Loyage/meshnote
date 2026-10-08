# MeshNote 架构

## Graph First

Mesh 是主题容器；KnowledgeNode 是完整的一次问题 + 回答，不是 message。ExplorationEdge 是一等实体，表达 source → target 的探索来源。不存在作为唯一关系来源的 parentNodeId。

```text
React 可折叠侧栏 + 双栏可调 UI / Zustand 视图状态
                ↓ subscribe / commands
         ApplicationService
          ↙       ↓         ↘
 ContextBuilder  Repository  LLMProvider
       ↓          ↓           ↓
 edges + nodes  IndexedDB   Mock / Local proxy → compatible API

GraphLayout ← nodes + edges（不依赖 LLM / persistence）
```

## 领域契约

见 `src/domain/contracts.ts`。时间使用 ISO 8601 字符串，避免 JSON/IndexedDB/SQLite 之间 Date 实例语义漂移。

- Mesh：id、title、description、rootNodeId、timestamps。
- KnowledgeNode：meshId、短标题、完整问答、summary、pending/streaming/completed/error、error 文本、timestamps。
- ExplorationEdge：meshId、sourceNodeId、targetNodeId、type、timestamp；本期只创建 branch，可扩展关系类型。
- Document / DocumentChunk / NodeReference：预留文档、页码与引用，不伪装为已实现 PDF/RAG。
- NodePosition：独立于问答的布局元数据，持久化已有位置，streaming 不触发全图重排。

## 服务行为

ApplicationService 暴露不可变 Workspace snapshot、订阅、Mesh CRUD、ask 和 cancel。UI 只通过服务发送命令。ask 先持久化 pending Node 与 Edge/root 关联，再开始模型流。逐步通知 UI，增量回答持久化；成功置 completed，再独立生成标题；标题失败保留截断问题。错误保留可查看的问题和已有输出，不删除节点。取消保留部分输出并标 error。刷新后的未完成节点恢复为 error，明确告知中断。

MVP 同一应用实例只运行一次生成，可浏览其他节点但不同时发送第二次。Mesh 删除必须确认；不能在生成过程中删除活动 Mesh。持久化失败必须反馈，不可显示虚假的保存成功。

## ContextBuilder

独立模块沿 **branch edges** 计算 Root → Selected 路径，生成 user/assistant 对再追加新问题；不包含兄弟分支。防御循环、跨 Mesh、缺失节点和多条 branch 入边：遇到歧义/坏数据报错，绝不悄悄任选父路径。MVP 创建操作只产生单 root 的 branch 树，但底层存储、布局与关系实体不依赖树约束。未来多入边时引入显式 context route 策略，而不是把所有祖先无序拼接。

## Repository 与原子性

Repository 接口与 IndexedDB 实现分离；提供 Mesh、Node、Edge、Document 的查询边界，以及跨实体原子提交。节点创建及其关系、根引用必须一致；删除 Mesh 级联清理子实体。Demo seed 使用初始化标记，仅首次填充，用户删除所有 Mesh 后不能自动复活。布局位置与所有实体一起持久化。当前本地 MVP 不提供跨标签页并发编辑保证，后续可加入版本冲突检测。

## GraphLayout / 导航

React Flow 管渲染交互；独立 GraphLayout 管坐标。ELK DOWN 初始/主动全图布局（主体纵向、分支横向）；branch 新增在 source 下方找空位，保留已有坐标。工作空间侧栏默认收起，画布与详情面板各占剩余横向空间一半、中间分隔条可调。点击节点及搜索结果均选中并居中；支持 fit、回到选中节点、缩放、平移、MiniMap。选中路径及 breadcrumb 展示探索来源。非树边未来交由布局器绘制，不影响核心实体设计。

## Runtime / 安全

`src/app/createApplication.ts` 组合 IndexedDB 与领域服务；`src/services/llm/createProvider.ts` 组合 Mock 或本地代理客户端，`RuntimeLLMProvider` 在设置保存后替换后续调用的 provider，不重建领域服务或工作空间。核心服务不访问 window/DOM。Node 代理仅绑定 loopback、校验 Origin/Host 和请求体上限；upstream 由 `.env` 初始配置或服务端私有设置文件控制，chat/title/summarize 不接受客户端 URL/密钥。设置接口返回密钥是否存在而非密钥本身；写入与连接测试要求严格浏览器同源，文件原子保存，单进程串行提交。在途请求保留旧 provider 快照，不回传原始上游错误。没有公网认证；不得把服务直接暴露到互联网。Electron 以后使用 main-process provider / SQLite adapters，保持 UI 与领域契约。

`src/features/settings/` 提供软件设置页面、LLM 设置客户端与主题管理。主题和布局偏好保存在当前 origin 的 localStorage，知识内容仍保存在 IndexedDB；新输入密钥仅存在当前表单内存中，提交给本机服务后不写浏览器存储。主题使用 CSS 变量覆盖图、Markdown、表单及错误状态。

## 模块所有权

- `src/domain/contracts.ts`：公共契约。
- `src/repositories/`, `src/services/context/`, `src/services/search/`, `src/services/application/`, `src/app/createApplication.ts`：领域与数据服务。
- `src/features/`, `src/stores/`, `src/components/`, `src/App.tsx`, `src/styles.css`, `src/services/layout/`：界面与布局。
- `src/services/llm/`, `server/`：模型与本机 HTTP 边界。

## 延后

账号、云同步、协作、RAG、向量库、自动语义关系、移动端、插件及 Agent 均不在 MVP。文档实体是预留能力，不展示不可用的上传按钮。
