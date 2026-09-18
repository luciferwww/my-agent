# Agent Session 管理对比调研

> Status: Non-authoritative research
> Scope: Claude Code、GitHub Copilot CLI、OpenAI Codex CLI、OpenCode 的 Session 身份与管理模型
> Evidence: 本轮调研访问的官方文档，链接见文末

## 1. 结论摘要

四个产品的共同方向不是“让用户自定义一个字符串并把它当主键”，而是：

1. 系统生成稳定且不可变的 Session ID；
2. 名称或标题是可选、可变、允许自动生成的展示元数据；
3. 新建、恢复、切换、分叉是不同操作；
4. 停止运行、从常用列表移除、归档和永久删除具有不同语义；
5. Session 列表通常先按当前目录或项目过滤，再允许扩大到仓库、全部本地项目或远端；
6. 用户 Session 与 Subagent/后台任务的执行关系不会仅靠拼接用户可见 Session 名称表达。

因此，本项目若希望提供类似体验，最值得借鉴的是“稳定 ID + 可变标题 + 显式生命周期 + 独立执行树”，而不是照搬某个产品的命令或界面。

## 2. 差异对比

| 维度 | Claude Code | GitHub Copilot CLI | OpenAI Codex CLI | OpenCode |
|---|---|---|---|---|
| 稳定身份 | Session UUID；可按 ID 恢复 | Session UUID；支持精确 ID、ID 前缀或名称恢复 | Session UUID；ID 优先于名称 | Session ID；HTTP API 路径均以 ID 寻址 |
| 展示名称 | 用户名称、AI 生成标题、默认运行展示名彼此有明确差异 | 可显式命名或自动生成名称 | 可创建时命名或后续重命名 | `title` 是独立可更新字段 |
| 新建 | 新进程、`/clear`/`/new` | `/new`、侧栏或 Sessions 页 | `/new`、`/clear` | TUI 新建或 `POST /session` |
| 恢复/切换 | `--continue`、`--resume`、`/resume` picker | `--continue`、`--resume`、`/resume`、侧栏、Sessions 页 | `resume`、`/resume`、`--last` | Session selector；API 可直接按 ID 获取并发送消息 |
| 作用域 | 默认当前 worktree；可扩大到仓库所有 worktree 或本机所有项目 | 以当前工作目录相关性排序；Sessions 页可筛选本地/远端/全部 | 默认当前工作目录；`--all` 扩大范围 | Server/API 以当前实例和项目为上下文 |
| 多活能力 | 后台 Session 与 Agent View；同一 Session 不建议被两个终端同时写入 | 同一 CLI 进程可保留多个运行 Session，并显示 busy、idle、等待权限等状态 | 支持多个 Chat、后台终端和 Agent thread；官方资料未展示 Copilot 式同屏多活看板 | Client/Server 架构、异步消息和全 Session 状态 API 支持多客户端；本轮资料未确认同一 TUI 的多活语义 |
| 停止/隐藏 | 结束进程不删除 Transcript；后台 Session 可停止 | close/exit 会停止并保存，且不等于删除 | archive 从活动列表移除但保留 Transcript | TUI 可切换 Session；Server 提供 abort 与 delete |
| 永久删除 | 主要提供保留期清理和 project purge；删除后台条目也不删除 Transcript | picker 或 `/session delete` 可永久删除 | `delete` 永久删除；与 `archive` 明确分离 | `DELETE /session/:id` 删除 Session 及其数据 |
| 分叉 | `/branch` 或 `--fork-session` 产生新 ID；原 Session 保留 | `/fork`/`/branch` 产生新 Session | `/fork` 或 `codex fork` 产生新 ID | `POST /session/:id/fork`，可指定消息位置 |
| 父子关系 | 分支有独立 ID；Subagent 和后台 Session 是不同运行概念 | Session、Task/Subagent tree 分离；可进入 Subagent 视图 | Session fork 与 Agent thread 分离；删除可处理后代 | Session 原生支持 `parentID`、children 和 fork |
| 编程接口 | CLI、结构化输出、Agent SDK；不建议解析内部 JSONL | CLI、程序化模式、Session 数据索引 | CLI、SDK、App Server thread/turn API | OpenAPI Server 与生成式 SDK 是一等接口 |

## 3. 各产品值得借鉴的点

### 3.1 Claude Code

- 将 UUID、用户命名、AI 标题和运行展示名区分开，避免展示名承担主键职责。
- Session picker 默认局部、按需扩大范围，兼顾常用路径和跨项目找回。
- `/branch` 会复制历史并生成新 Session ID；消息树内回退与 Session 级分叉不是同一概念。
- 同一个 Session 被两个终端同时恢复时会向同一 Transcript 交错写入。这说明稳定 ID 本身不能替代单写者或并发控制。
- 单 Session 永久删除不是主要交互，更多依赖保留期和项目级清理；这一点不适合直接照搬到需要显式 CRUD 的服务端产品。

### 3.2 GitHub Copilot CLI

- 多 Session 是运行时一等能力：同一进程可让多个 Session 保持 active，并在侧栏展示 idle、busy、等待权限或等待用户。
- 侧栏负责“最近和正在运行的快速切换”，Sessions 页负责“完整历史、搜索和本地/远端范围”，职责区分清楚。
- close 只停止并保存；delete 才永久删除。用户不会因为整理运行列表而误删历史。
- Session ID 可直接复制；名称用于查找，但系统仍以 ID 提供精确寻址。
- Session 与 Subagent task tree 分离，后者有独立的父子、深度、并发和交互模型。

### 3.3 OpenAI Codex CLI

- archive/unarchive 与 delete 分离，且命令行删除要求更强确认。
- `resume` 默认限制在当前工作目录，`--all` 才跨目录，避免全局历史淹没常用结果。
- fork 明确生成新 Chat 和新 ID，原 Transcript 不变。
- `/agent` 切换 Agent thread，`/side` 创建临时侧聊，避免把所有执行上下文都伪装成顶层用户 Session。
- 永久删除父 Session 时会删除 spawned descendants，说明父子删除策略必须成为显式契约。

### 3.4 OpenCode

- Session CRUD、状态、children、fork、abort、消息和分享均有明确 HTTP 资源接口。
- `Session { id, title, parentID? }` 的建模最接近服务端产品：ID 是资源身份，标题只是属性，父子关系是结构化字段。
- TUI 是 Server 的客户端，业务能力不被终端界面私有化，便于 Web、IDE 和自动化客户端复用。
- 直接 delete 的 API 简洁，但如果面向最终用户，仍需要由产品层补充确认、归档或软删除策略。

## 4. 共同模式与分歧

### 4.1 高置信共同模式

- **稳定身份与展示名称分离。** 四者都不依赖可变标题作为唯一底层身份。
- **恢复优先按 ID 精确寻址。** 名称主要服务于人类查找，重名或模糊匹配需要额外规则。
- **分叉创建新身份。** 分叉不是移动当前指针，也不是重命名原 Session。
- **目录/项目是筛选维度，不是 Session 身份本身。** 默认局部搜索，必要时扩大范围。
- **运行状态与持久化历史不同。** idle、busy、waiting、stopped 等状态不应全部写成永久 Session 状态。
- **Subagent 关系需要结构化身份。** 运行树与用户 Session 列表相关，但不是同一个概念。

### 4.2 产品间尚无统一答案

- 是否必须提供 archive：Codex 明确提供，Copilot 以 close/历史列表形成近似体验，Claude Code 偏保留期清理，OpenCode 原生 API 主要是 delete。
- 是否允许同一 Session 多写者：Claude Code 会交错写入；这更像已知行为，不是值得复制的并发模型。
- 工作区边界是目录、Git 仓库、worktree 还是用户全局：各产品因形态不同而不同。
- Child Session 是否进入普通 Session 列表：OpenCode 暴露 children，Copilot/Codex 更强调独立的 Agent task/thread 视图。

## 5. 对本项目的直接启示

本项目当前已经同时保存 `sessionId` 和 `sessionKey`，因此并不缺少稳定 ID。主要差距是：

- `sessionId` 仍是内部 UUID；新建 Session 按惯例用它生成 Transcript 文件名，但当前更新接口尚未强制该字段不可变；
- `sessionKey` 同时承担调用方标签、持久化索引、并发键、Abort 键、WebSocket audience 和 Subagent 路由编码；
- 没有面向用户的 create/list/get/rename/archive/delete/fork 管理面；
- CLI 默认固定为单个 `main` Session；
- Subagent 已有 `runId`、`turnId`、若干 `parent*` 字段和持久化 `spawnedBy`，但 Child-to-root 路由与 depth 仍依赖字符串 key 编码。

这意味着采用新模型是可行的；但公共协议、Runtime map key、WebSocket 路由和 Subagent 身份是跨模块变更，不能被当作单纯 Store 字段重命名。本设计不要求读取或转换当前 Session 数据。

具体建议见 [新 Session 模型设计草稿](session-model-design-draft.md)。

## 6. 官方资料

### Claude Code

- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/commands

### GitHub Copilot CLI

- https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/work-with-multiple-sessions
- https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/chronicle
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference

### OpenAI Codex CLI

- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/developer-commands?surface=cli

### OpenCode

- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/tui/
- https://opencode.ai/docs/sdk/
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/keybinds/

## 7. 证据边界

本调研只依据公开官方文档描述外部行为，不推断未公开的内部数据库 Schema。产品命令和能力会随版本变化；这里提取的是可借鉴的身份与生命周期模式，不是兼容性承诺。