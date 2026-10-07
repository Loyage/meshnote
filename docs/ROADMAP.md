# MeshNote Roadmap

## v0.1 · 当前 MVP

- [x] Graph-first 三栏工作台、Transformer Demo
- [x] Mesh CRUD、root 与历史节点 branch
- [x] ELK 左→右布局与稳定增量位置、拖动坐标持久化
- [x] 平移/缩放/fit/定位/MiniMap、祖先路径高亮
- [x] 独立 ContextBuilder，不带入兄弟分支
- [x] pending → streaming → completed/error、取消与中断恢复
- [x] Mock、OpenAI-compatible 本地代理、短标题 fallback
- [x] Repository 抽象、IndexedDB 事务、关键词搜索定位
- [x] Document / Chunk / Reference 数据结构
- [x] 单元、适配器协议与 Chromium 用户流程测试

## 下一阶段 · 数据可靠性与大图体验

1. 导入/导出、备份与 schema migration；跨标签页写锁或版本冲突检测。
2. 千节点基准测试：初始加载、选择、输入、布局、搜索与存储耗时。
3. 按实体增量存储，替换当前单记录原子 snapshot，减少长回答/大 Mesh 的全量复制。
4. ELK Web Worker、子图布局、分支折叠、视图历史、用户布局固定与可调面板。
5. Markdown 公式与代码体验、无障碍/对比度完整审计、Firefox/Safari 验证。
6. 更丰富模型兼容性与上下文预算策略；在超长路径上明确提示截断/摘要，不静默丢弃上下文。

## 文档理解

文档导入、PDF 阅读器、page/chunk 定位、可追溯引用；在领域服务层组合文档 context/retrieval，不把 RAG 写入组件。

## 知识探索能力

语义检索、pinned nodes、分支/subtree 总结、backlink、跨 Mesh 引用；允许多入边时先设计显式 context route，再开放图合并，不用“随便选一个父节点”代替产品决策。

## Runtime

提取 `packages/core` / `packages/web` / `packages/electron`，Electron main-process 模型调用与 SQLite repository adapter。已有 Web MVP 不等于已提供桌面包。

## 不自动扩展的范围

账号、权限、云同步、团队协作、Agent、插件平台、移动端必须另立需求；不以增加功能为代价破坏 Graph UX。
