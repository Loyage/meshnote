# LLM 与本地代理

## 启动与配置

`bun run dev` 同时启动 Vite（127.0.0.1:5173）和 Node 代理（127.0.0.1:8787）。没有 API key 时 `/api/config` 返回 Mock 模式，浏览器使用明确标注为预设内容的 `MockLLMProvider`，不访问外部模型。

复制 `.env.example` 为 `.env` 后设置：

```dotenv
MESHNOTE_LLM_BASE_URL=https://api.openai.com/v1
MESHNOTE_LLM_API_KEY=你的密钥
MESHNOTE_LLM_MODEL=gpt-4o-mini
```

base URL 是包含 `/v1` 等供应商前缀的地址，不包含 `/chat/completions`。代理在其后追加该路径。修改环境配置后重启开发服务。不要使用 `VITE_` 前缀，Vite 前缀变量会进入浏览器包。密钥不返回 `/api/config`，不保存在 IndexedDB，不记录在日志中。

生产本机运行：`bun run build && bun run start`，打开 http://127.0.0.1:8787。Node 安全托管 `dist` 和 SPA 路由；缺少构建时返回明确提示。`MESHNOTE_PORT` 默认 8787；开发 Vite 的固定代理端口也是 8787，改端口需同步调整 Vite 配置。

## 契约与流

- `LLMProvider.chat(messages, signal)` 返回 `AsyncIterable<string>`。
- `generateTitle` 使用单独短中文标题 prompt；输出清洗并限制 24 个 Unicode 字符；调用失败由 ApplicationService 采用问题截断 fallback。
- `summarize` 是未来摘要能力的适配边界，MVP 不额外展示 UI。
- `OpenAICompatibleProvider` 仅存在于 `server/`，不进入 Web bundle。
- 浏览器 `ProxyLLMProvider` 只访问同源 `/api`。代理响应为 NDJSON：`delta/text`、`done`、或 `error/message`；未收到 done 的 EOF 一律报错。
- 上游 SSE 支持跨字节 UTF-8、LF/CRLF/CR、注释、多 data 行及末尾未加空行的事件。必须有 `[DONE]`；HTTP 结束不代表回答成功。`length`、`content_filter`、工具调用等非 stop 结束均报告不完整，不假装 completed。
- AbortSignal、断开连接及超时会取消上游请求；默认总超时 120 秒（允许配置 1–600 秒），浏览器 125 秒保护。过长或未知协议输出会报错。

## 安全与已知边界

本项目是**个人本机 MVP，不是公网 API 网关**。服务强制绑定 127.0.0.1，只接受本机 Host，允许本机 5173 / API 端口 Origin，拒绝跨站请求，不开放 CORS。上游地址只从服务端环境读取，忽略客户端模型、key、URL 字段；禁用上游 HTTP 重定向，避免凭据随重定向外泄。请求体最多 1 MiB，消息数最多 1000，单消息最多 20 万字符，模型响应最多 200 万字符。

不要用反向代理将此无认证服务暴露到公网。HTTP base URL 仅建议可信本机模型；远程 API 使用 HTTPS。恶意本机程序和同端口恶意前端不属于本 MVP 安全边界。

错误消息经过清洗，不把上游原始响应、错误体或密钥展示给用户。模型服务不可用时不会静默换成 Mock，避免将演示回答误认为真实模型输出。当前支持文本 chat completions，不支持工具调用、多模态、Responses API 或未遵循 SSE `[DONE]` 协议的私有网关。

自动测试使用本机模拟上游检查协议与错误路径；没有真实供应商密钥时不能证明外网供应商兼容性。
