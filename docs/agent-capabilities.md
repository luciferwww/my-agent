# my-agent 能力清单

> 整理日期：2026-08-27  
> 整理范围：能力主体依据现有设计文档；“多客户端用户消息广播”和“用户主动中止”额外核对了实际代码与测试。

## 1. 状态说明

- **已实现（文档确认）**：实施文档或后续规格明确说明能力已经落地，但本次未逐项扫描源码。
- **已实现（代码核验）**：本次沿实际入口、核心处理路径和测试进行了核对。
- **规划中**：只有设计、规格或类型预留，不能作为当前可用能力。
- `docs/architecture/current/` 是 2026-05 的架构快照。后续功能可能已经落地，但尚未同步回该目录；遇到冲突时，本清单优先采用更新的实施文档和本次代码核验结果。

## 2. 产品定位

- 可嵌入的 AI Agent 执行框架。
- 提供完整的 LLM 对话循环、工具执行、上下文压缩、会话持久化和长期记忆能力。
- 支持 CLI、WebSocket 和直接库调用三种使用方式。
- LLM、Channel、MemoryStore 和日志输出均采用接口与实现分离设计，允许替换具体实现。
- 通过工作区内的 `.agent/` 目录保存 Agent 身份、行为规则、工具说明、配置、会话和记忆。

参考：[架构总览](architecture/current/overview.md)、[Runtime 设计](architecture/current/runtime.md)

## 3. Agent 执行引擎

- **完整 Tool Use 循环**：执行“调用 LLM → 接收工具请求 → 执行工具 → 回传工具结果 → 继续调用 LLM”，直到正常结束或达到调用上限。
- **流式回复**：通过 `text_delta` 事件实时输出模型生成内容。
- **LLM 调用配额**：可限制单次 Run 的最大 LLM 调用次数。
- **工具错误回传**：工具不存在或执行异常时转换成带错误标记的 `tool_result`，交给 LLM 决定如何继续。
- **运行期 Hook**：支持 `before_tool_call`、`after_tool_call`、`before_compaction`、`after_compaction`。
- **工具调用拦截**：`before_tool_call` 可以修改输入或拒绝执行。
- **软 Steering**：运行期间到达的新文本可在工具执行轮次后注入当前 Turn；不会立即中断正在执行的 LLM 调用或工具。
- **执行事件流**：覆盖 Run 开始/结束、LLM 调用、文本增量、工具调用、工具结果、上下文压缩、错误和会话修复等事件。

参考：[Agent Runner](architecture/current/core_runner.md)、[Runner Hooks](architecture/core-runner-hooks-design.md)

## 4. 内置工具

### 4.1 文件与搜索

- `list_dir`：列出目录内容。
- `read_file`：读取文件，支持分页。
- `write_file`：写入或覆盖文件。
- `edit_file`：按唯一字符串进行替换。
- `apply_patch`：应用 Unified Diff Patch。
- `file_search`：按 Glob 模式搜索工作区文件。
- `grep_search`：使用正则搜索文件内容，并支持文件过滤。
- 文件工具默认限制在工作区内；可通过配置调整路径策略。

### 4.2 Web 与命令执行

- `web_fetch`：获取 HTTP(S) 页面内容，支持超时和长度截断。
- `exec`：支持前台、Yield 和后台三种命令执行模式。
- `process`：支持列出后台进程、查询状态、读取日志和终止进程树。
- Unix 使用进程组终止子进程树；Windows 使用 `taskkill /T /F`。
- 后台进程通过 `runId` 管理，前台内部进程不会污染后台进程列表。

### 4.3 工具扩展

- 自定义工具统一实现 `Tool` 接口，包括名称、描述、JSON Schema 和异步执行函数。
- 工具执行异常统一转换为 `ToolResult`，避免单个工具异常直接破坏 Agent 循环。
- Runtime 从同一份工具集合生成执行器、LLM Tool Definition 和 Prompt Tool Definition，避免工具面不一致。

参考：[Builtin Tools](architecture/current/core_tools_builtin.md)、[Tools 框架](architecture/current/core_tools.md)

## 5. Prompt 与工作区上下文

- System Prompt 支持 `full`、`minimal`、`none` 三种模式。
- System Prompt 可组合 Agent 身份、当前时间、行为规则、安全约束、记忆说明和项目上下文。
- User Prompt 支持 Context Hook，在原始用户输入前动态追加上下文。
- 工作区首次初始化时创建 `.agent/`、会话目录、记忆目录和默认模板。
- 上下文文件包括 `IDENTITY.md`、`SOUL.md`、`AGENTS.md`、`TOOLS.md`。
- `minimal` 模式只加载 `IDENTITY.md` 和 `SOUL.md`。
- 支持单文件和总体字符预算；超长文件保留头尾并截断中间部分。
- Runtime 缓存上下文文件，并支持显式重新加载。

参考：[Prompt](architecture/current/core_prompt.md)、[Workspace](architecture/current/core_workspace.md)

## 6. 长上下文管理

- **Layer 1**：裁剪单个历史 Tool Result。
- **Layer 1.5**：按聚合预算裁剪全部 Tool Result。
- **Layer 2**：在调用 LLM 前估算 Token 并进行预算路由。
- **Layer 3**：调用 LLM 生成历史摘要，持久化压缩记录后重试当前请求。
- 可从预判超限、运行中达到阈值和 LLM API 上下文溢出三条路径触发压缩。
- 压缩事件提供触发原因、压缩前后 Token 和丢弃消息数量。
- 新 Turn 会清理上次失败遗留的孤立尾部 User Message，同时保留原始 JSONL 记录以供审计。

参考：[Agent Runner](architecture/current/core_runner.md)、[Turn Flow](architecture/core-runner-turn-flow-spec.md)

## 7. 会话与持久化

- 用户消息、助手回复、Tool Result 和压缩记录会立即追加到 JSONL。
- 存储采用 Append-only 设计，进程异常退出后仍可恢复已有历史。
- Transcript 通过 `parentId` 形成消息树，当前 Leaf 表示活跃分支。
- 外部使用逻辑 `sessionKey`，内部使用 UUID `sessionId`。
- `sessions.json` 保存会话元数据，避免查找会话时扫描全部 Transcript。
- 文件锁用于防御并发追加乱序。
- 同一 Session 串行执行，不同 Session 可以并发执行。
- Tool Result 可以在写入磁盘前执行头尾保留式截断。

参考：[Session](architecture/current/core_session.md)、[Runtime 设计](architecture/current/runtime.md)

## 8. 长期记忆

- 索引工作区 `.agent/*.md` Markdown 记忆文件。
- 使用本地 Embedding 模型生成向量，并存储到 SQLite。
- 组合向量相似度与 BM25 关键词搜索进行混合召回。
- 根据文件 Hash 和修改时间进行增量索引。
- `memory_search`：搜索记忆。
- `memory_get`：读取指定记忆文件。
- `memory_write`：写入记忆并立即重新索引。
- Embedding 初始化失败时可降级为纯关键词搜索。
- Memory 模块整体初始化失败时，Runtime 继续启动但不注册 Memory 工具。
- Recall Tracker 异步记录查询和命中结果，不阻塞搜索请求。

参考：[Memory](architecture/current/core_memory.md)

## 9. Subagent

**状态：v1 已实现（文档确认）。**

- 父 Agent 可以通过 `task` 工具委派独立任务。
- 同时提供 `RuntimeApp.runSubagentTurn(...)` 库调用入口。
- 支持内置 `general-purpose` 和用户配置的具名 Subagent Profile。
- 子 Agent 拥有独立 Session、System Prompt、工具集和 LLM 调用预算。
- 子 Agent 只把最终文本作为 Tool Result 返回父 Agent，避免中间上下文污染父会话。
- 可在 `.agent/subagents/<id>/` 中配置 `IDENTITY.md`、`SOUL.md` 等角色文件。
- 子 Agent 的 Deny 规则叠加主 Agent 限制，Allow 规则可独立收窄免审批范围。
- 子 Agent 的敏感工具请求复用父 Turn 的 Channel 审批通路。
- 通过 Session Key 编码深度；默认最大深度为 1，子 Agent 默认不能继续创建子 Agent。
- 提供 `subagent_start`、`subagent_end` 以及子 Agent 内部完整事件流。
- 子 Agent 完成后清理其临时 Session。

当前限制：

- 同一轮多个 Subagent 的并发执行属于 v2 Spec；该文档尚未明确标记实现完成。
- 不支持 Detached/后台 Subagent。
- 不支持 Fork 父会话历史、Worktree/远程隔离或跨 Agent 通信。
- v1 子 Agent Prompt 不携带图片附件。

参考：[Subagent v1](architecture/core-subagent-spec.md)、[Subagent 实施](architecture/core-subagent-impl.md)、[Subagent v2](architecture/core-subagent-v2-spec.md)

## 10. 图片附件

**状态：服务端 Phase 1 已实现（文档确认）；浏览器客户端有实施文档，但该文档未明确标记已合入。**

- 用户消息支持纯文本或结构化 Content Block 数组。
- Phase 1 支持 PNG、JPEG、WebP、GIF 图片。
- 单条消息默认最多 20 个附件，解码后附件总量默认不超过 10 MB。
- 2 MB 以下图片直接内联；2–10 MB 图片由服务端缩放并转为 JPEG 后内联。
- 校验 MIME 白名单、Magic Bytes、图片尺寸、单文件大小和总量。
- 单个附件处理失败时只丢弃该附件，不阻断整条消息。
- 图片尺寸用于估算视觉 Token；压缩历史时图片会临时转换为文本占位交给摘要模型。
- 图片原始内容持久化到 Session JSONL，发送给 LLM 前剥离内部尺寸字段。
- Steering 当前只接收文本，图片会被剥离。

当前限制：

- 不支持 PDF、Document 或文本文件附件。
- 不支持 CLI 附件输入。
- 不提供跨 Turn 附件库或附件重新引用。

参考：[附件 Spec](architecture/attachments-support-spec.md)、[服务端实施](architecture/attachments-server-implementation.md)、[客户端实施](architecture/attachments-client-implementation.md)

## 11. Channel 与多客户端

- 支持直接库调用、CLI Channel 和 WebSocket Channel。
- CLI 支持流式文本、工具调用提示、工具结果预览、压缩状态和可选的 Y/N 工具审批。
- WebSocket 支持多 Client、多 Session、同 Session 事件广播和按 Origin Client 定向审批。
- 相同 `clientId` 重连时，新连接接管旧连接。
- Runtime 对同一 Session 的普通消息排队执行；运行中消息可按配置进入 Steering Inbox。
- 工具审批支持 Allow、Deny、Prompt 三档策略，Deny 优先。
- 审批请求只发送给发起 Turn 的 Channel/Client，不广播给其他客户端。
- 审批请求超时后自动按拒绝处理。

参考：[Channel](architecture/current/adapter_channel.md)

### 11.1 多客户端用户消息广播

**状态：已实现（代码核验）。**

- Runtime 在消息完成附件处理和输入装配后、Queued/Steering 路由分流前，发送一次 `user_message` Agent Event。
- `user_message` 广播给同一 Session 的所有 WebSocket Client，包含消息发送者本人，可作为服务端已接收的隐式确认。
- 事件包含独立 `messageId`、文本内容、`originClientId`、`deliveryMode` 和时间戳。
- Queued 消息启动 Turn 后，`run_start.originMessageId` 反向关联原始 `user_message.messageId`。
- Steering 消息也会广播，并通过 `deliveryMode: 'steering'` 标识。
- 图片原始 Base64 不进入广播事件，只广播附件类型、MIME 和字节数等摘要。
- CLI 与 WebSocket 共用 Fanout；CLI 可以显示来自 WebSocket Client 的用户消息，并避免回显本地 CLI 输入。
- Transcript 仍由 Runner 在消费消息时写入，广播不会造成重复持久化。

代码核验入口：

- `src/runtime/RuntimeApp.ts`：组装输入、生成 `user_message`、Fanout、透传 `originMessageId`。
- `src/core/runner/types.ts`：`user_message` 和 `run_start.originMessageId` 事件类型。
- `src/adapters/channel/WebSocketChannel.ts`：按 Session Audience 广播事件。
- `src/adapters/channel/CliChannel.ts`：渲染跨 Channel 用户消息。
- 对应测试覆盖 Runtime 入站、WebSocket 全员广播、CLI 渲染和事件关联。

参考：[多客户端用户消息 Spec](architecture/channel-multi-client-user-message-spec.md)

## 12. 用户主动中止

**状态：已实现（代码核验）。**

- CLI 可通过 `Ctrl+C` 请求中止当前 Session 的活动 Turn。
- WebSocket Client 可发送 `{ type: 'abort_turn', sessionKey }`。
- 库调用方可直接调用 `RuntimeApp.abortTurn(sessionKey)`。
- Runtime 为每个活动 Session 创建独立 `AbortController`，中止不同 Session 时互不影响。
- 中止信号传入 Agent Runner、LLM Stream、Tool Context 和 Subagent 调用链。
- Agent Runner 将中止作为正常结果返回，`stopReason` 为 `aborted`，不会把用户中止作为普通执行错误抛给调用方。
- LLM 流式输出中已经产生的 Partial Assistant 内容可以保留并持久化。
- 中止时清空同一 Session 尚未执行的普通消息队列，并发送 `messages_dropped` Runtime Event。
- 下一轮运行前会修复没有对应 Tool Result 的孤立 Tool Use，保证历史仍满足 LLM 协议。
- Runtime 关闭时会先中止所有活动 Turn，再等待运行任务收尾。
- 父 Turn 的 AbortSignal 会传给正在运行的 Subagent，实现级联中止。

当前限制：

- Tool 是否立即停止取决于工具是否响应 `AbortSignal`；框架保证不再启动后续工具，但不保证所有正在执行的第三方工具瞬时停止。
- WebSocket 当前采用单信任域假设，没有校验 Client 是否有权中止目标 Session。
- `abort_turn` 没有单独 Ack，客户端通过 `run_end.result.stopReason === 'aborted'` 感知完成。
- Pending Steering 的丢弃只记录日志，不计入 `messages_dropped` 数量。

代码核验入口：

- `src/runtime/RuntimeApp.ts`：`activeAborts`、`abortTurn()`、队列清理、Channel Abort Hook 和 Shutdown 中止。
- `src/core/runner/AgentRunner.ts`：循环中止检查、LLM Stream 中止处理、Partial 内容和 `aborted` 结果。
- `src/adapters/channel/CliChannel.ts`：`Ctrl+C` 中止入口。
- `src/adapters/channel/WebSocketChannel.ts`：`abort_turn` 协议入口。
- 对应测试覆盖活动 Turn、中止队列、跨 Session 隔离、CLI 和 WebSocket 入口。

参考：[Abort Spec](architecture/core-abort-spec.md)

## 13. LLM、配置与日志

### 13.1 LLM Adapter

- 定义可替换的 `LLMClient` 接口，包含流式和非流式调用。
- 当前文档中的具体实现为 `AnthropicClient`。
- 支持通过 `baseURL` 接入 LiteLLM Proxy 等兼容代理。
- Adapter 负责把 Anthropic 分片 Tool Use JSON 组装成完整工具输入。
- Context Overflow 会转换为框架内部错误，交由 Runner 的统一压缩重试流程处理。

### 13.2 配置

- 支持默认配置、工作区配置、Agent 覆盖、环境变量和调用参数覆盖。
- 支持模型、Token 上限、上下文窗口、Runner、Memory、Prompt、Tools、Workspace、Compaction 和 Logger 等配置域。
- 提供交互式 Config Wizard，并尽量只写入与默认值不同的字段。
- 工具权限支持精确名称和 Glob；旧架构快照中的工具组语法与后续配置重构文档存在冲突，使用时应以后续配置文档为准。

### 13.3 日志与生命周期

- 全局命名 Logger 支持 Debug、Info、Warn、Error。
- Console 和 File Adapter 可以独立配置最低日志级别。
- 文件日志使用异步队列并按日期滚动。
- Logger 完成配置前的启动日志会先缓冲，配置后回放。
- Runtime 提供启动、Turn、上下文重载、警告、错误和关闭事件。
- Runtime 关闭流程幂等，并使用 `Promise.allSettled` 尽量释放全部资源。

参考：[LLM Adapter](architecture/current/adapter_llm.md)、[Config](architecture/current/platform_config.md)、[配置重构实施](architecture/platform-config-restructure-impl.md)、[Logger](architecture/current/platform_logger.md)

## 14. 尚未确认实现或明确规划中的能力

- Subagent 同一轮并发执行和并发 Gate。
- Detached/后台 Subagent，以及父 Turn 返回后的异步结果通知。
- HTTP/REST/SSE Channel。
- Channel 鉴权、多租户和细粒度 Session 权限。
- Slack、Discord 等外部平台 Channel。
- WebSocket 断线事件补发、Replay Buffer 和 Pending Interaction 重投递。
- `select` 通用交互在 CLI/WebSocket 中的实际实现。
- 模型失败后的自动 Fallback。
- 硬 Steering：立即打断当前 LLM/Tool 并切换指令。
- 消息队列容量上限、过期时间和跨 Session 全局并发上限。
- PDF/Document 附件、CLI 附件和跨 Turn 附件库。
- Per-agent 配置列表的完整运行时启用。
- 配置文件 JSON Schema 校验。

## 15. 结论

my-agent 当前已经形成较完整的单进程 Agent Runtime：能够装配 LLM、Prompt、Workspace、Session、Memory 和 Tools，执行可观测的 Tool Use 循环，并通过 CLI、WebSocket 或库 API 对外提供服务。它已经具备长期会话、上下文压缩、记忆检索、图片输入、Subagent 委派、多客户端消息可见性和用户主动中止等关键能力；尚未完成的方向主要集中在分布式接入、鉴权、断线恢复、Subagent 并发/后台化和更丰富的附件类型。