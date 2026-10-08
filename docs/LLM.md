# LLM 与本地代理

## 启动与配置

`bun run dev` 同时启动 Vite（127.0.0.1:5173）和 Node 代理（127.0.0.1:8787）。首次运行且没有 API key 时 `/api/config` 返回 Mock 模式，浏览器使用明确标注为预设内容的 `MockLLMProvider`，不访问外部模型。软件设置支持单个 OpenAI-compatible 提供方与 Mock 切换；Mock 可以保留已配置密钥，方便以后切回真实模式。

复制 `.env.example` 为 `.env` 后设置：

```dotenv
MESHNOTE_LLM_BASE_URL=https://api.openai.com/v1
MESHNOTE_LLM_API_KEY=你的密钥
MESHNOTE_LLM_MODEL=gpt-4o-mini
```

base URL 是包含 `/v1` 等供应商前缀的地址，不包含 `/chat/completions`。代理在其后追加该路径。`.env` 只在尚无配置文件时提供初始 LLM 配置；此时修改环境配置需重启服务。已有配置文件后，以文件中的 LLM 配置为准，端口仍由环境变量控制。不要使用 `VITE_` 前缀，Vite 前缀变量会进入浏览器包。密钥不返回任何配置接口，不保存在 IndexedDB，不记录在日志中。

### 软件设置 API 与持久化

- `GET /api/settings/llm` 返回 `{mode:"mock"|"openai-compatible",baseUrl:string,model:string,hasApiKey:boolean,timeoutMs:number}`，不返回 `apiKey`。
- `PUT /api/settings/llm` 接受 `{mode,baseUrl,model,timeoutMs,apiKey?:string,clearApiKey?:boolean}`，成功返回同 GET。省略 `apiKey` 保留当前密钥；设置非空字符串替换密钥；仅 `clearApiKey:true` 删除。空字符串密钥、同时设置和删除、真实模式没有密钥均返回 400。模型名称限 200 字符，密钥限 8192 字符，超时为 1000–600000 毫秒整数，URL 不接受内嵌凭据、查询或片段。拒绝未知字段。
- `POST /api/settings/llm/test` 接受同样的**草稿**，省略密钥使用当前密钥，不保存或切换运行配置。真实模式发一次非流式 `chat/completions` 请求（`Reply OK.`，`max_tokens:1`；测试允许因一 token 限制出现 `length`），验证返回文本后丢弃，返回 `{ok:true,message:string}`。Mock 明确说明不访问外部模型。失败为非 2xx + `{error:string}`，不会回显供应商原始错误或文本。
- `GET /api/config` 保持 `{mode,model}` 原格式，Mock 的 `model` 为 `null`。保存后后续 chat/title/summarize 立即使用新配置；在途请求保留旧 provider 快照。串行保存按接收顺序提交，省略密钥相对于上次成功提交解析，失败不改变当前配置。

启动入口 `server/index.ts` 从**当前工作目录**的 `.meshnote/llm-settings.json` 加载配置，首次保存才创建文件。目录权限 0700、文件权限 0600，密钥为服务端明文；文件经私有临时文件写入、fsync 后原子替换，`.meshnote/` 已被 Git 忽略。文件损坏或不可读时拒绝启动，不静默退回环境或覆写密钥。普通 `createMeshNoteServer` 不访问磁盘；只有显式传入 `settingsFile` 才持久化，便于测试隔离。

E2E 可为启动入口设置 `MESHNOTE_SETTINGS_FILE=.meshnote/e2e/llm-settings.json`（或 `test-results/.meshnote/llm-settings.json`）。显式覆盖后只加载/保存该路径，默认配置文件不再被访问；覆盖文件不存在时仍使用环境初始配置。相对路径以当前工作目录解析，绝对路径也必须位于当前工作目录内，拒绝 `..` 越出工作区。请使用专属子目录，因为设置文件所在目录会收紧为 0700。测试时令 `MESHNOTE_LLM_API_KEY` 为空以获得 Mock 初始模式，并在运行前清理**测试专属**配置。

不要提交、共享或公开备份该目录。当前串行保证针对**单个服务进程**，不支持多个进程共同写入同一配置文件；运行中的外部文件修改不会自动加载。原子替换避免半写文件，但没有目录 fsync，不保证突然断电后的最后一次保存耐久性。

生产本机运行：`bun run build && bun run start`，打开 http://127.0.0.1:8787。Node 安全托管 `dist` 和 SPA 路由；缺少构建时返回明确提示。`MESHNOTE_PORT` 默认 8787；开发 Vite 的固定代理端口也是 8787，改端口需同步调整 Vite 配置。

## 契约与流

- `LLMProvider.chat(messages, signal)` 返回 `AsyncIterable<string>`。
- `generateTitle` 使用单独短中文标题 prompt；输出清洗并限制 24 个 Unicode 字符；调用失败由 ApplicationService 采用问题截断 fallback。
- `summarize` 是未来摘要能力的适配边界，MVP 不额外展示 UI。
- `OpenAICompatibleProvider` 仅存在于 `server/`，不进入 Web bundle。
- 浏览器 `ProxyLLMProvider` 只访问同源 `/api`。代理响应为 NDJSON：`delta/text`、`done`、或 `error/message`；未收到 done 的 EOF 一律报错。
- 上游 SSE 支持跨字节 UTF-8、LF/CRLF/CR、注释、多 data 行及末尾未加空行的事件。必须有 `[DONE]`；HTTP 结束不代表回答成功。`length`、`content_filter`、工具调用等非 stop 结束均报告不完整，不假装 completed。
- AbortSignal、断开连接及超时会取消上游请求；默认总超时 120 秒（允许配置 1–600 秒），浏览器按服务端设置超时再增加 5 秒保护（默认 125 秒）。过长或未知协议输出会报错。

## 安全与已知边界

本项目是**个人本机 MVP，不是公网 API 网关**。服务强制绑定 127.0.0.1，只接受本机 Host，允许本机 5173 / API 端口 Origin，拒绝跨站请求，不开放 CORS。配置写入与测试进一步要求浏览器 Origin 与原始 Host 完全匹配，Fetch Metadata（若存在）必须为 `same-origin` 且带 Origin；Vite 默认保留浏览器 Host 的同源代理可正常使用。无 Origin、无 Fetch Metadata 的本机 CLI 调用允许；这不是针对恶意本机进程的认证。

上游地址从环境初始配置或服务端设置文件读取，仅设置 API 可更改；chat/title/summarize 仍忽略客户端模型、key、URL 字段。禁用上游 HTTP 重定向，避免凭据随重定向外泄。测试会向草稿 URL 发送草稿/当前密钥，请只测试可信地址。请求体最多 1 MiB，消息数最多 1000，单消息最多 20 万字符，模型响应最多 200 万字符。

不要用反向代理将此无认证服务暴露到公网。HTTP base URL 仅建议可信本机模型；远程 API 使用 HTTPS。恶意本机程序和同端口恶意前端不属于本 MVP 安全边界。

错误消息经过清洗，不把上游原始响应、错误体或密钥展示给用户。模型服务不可用时不会静默换成 Mock，避免将演示回答误认为真实模型输出。当前支持文本 chat completions，不支持工具调用、多模态、Responses API 或未遵循 SSE `[DONE]` 协议的私有网关。

自动测试使用本机模拟上游检查协议与错误路径；没有真实供应商密钥时不能证明外网供应商兼容性。
