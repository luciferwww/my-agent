# Tool Use Readability Plan

> Status: Accepted
> Date: 2026-11-06
> Owner: Project owner
> Classification: Small Change
> Archived: 2026-11-06，owner 人工验收通过后归档
> Authorization: 2026-11-06 owner 确认 go，按 Group、Single 两步进入 Delivery；不自动 commit/push
> Input: [Tool Use 可读性设计草稿](../../../research/tool-use-readability-design-draft.md)
> Stable authority: [Channel Specification: Tool readability](../../../specifications/channel.md#bundled-websocket-tool-readability)
> Related: [Session Execution Presentation Specification](../../active/session-execution-presentation/specification.md)

## 1. Outcome and scope

只改 bundled WebSocket client 的工具展示标题及标题宽度：

- Group 用英文操作类型计数摘要替换 `LLM call N`。
- Single Tool 用工具语义及关键参数生成简短标题。
- Task 使用独立 Agent 类型标签、描述主标题和状态徽标。
- 标题在折叠和展开时保持一致，长内容不能撑宽卡片。

本 Change 记录已确认的展示要求、两步交付及验收证据，不新增 ADR、Spike 或单独 Specification。研究草稿保留工具清单和讨论来源。归档后，以下要求作为交付时快照保留，不是长期规范权威；可复用规则已提升至现有 Channel Specification。

## 2. Confirmed requirements

### 2.1 Group

以现有 Group 的 Tool Calls 确定性生成摘要，不额外调用模型：

| 工具名称 | 计数单位（单数 / 复数） |
|---|---|
| `read_file`, `memory_get` | `file read` / `file reads` |
| `file_search`, `grep_search`, `memory_search` | `search` / `searches` |
| `exec` | `command` / `commands` |
| `write_file`, `edit_file`, `apply_patch`, `memory_write` | `file change` / `file changes` |
| `web_fetch` | `web fetch` / `web fetches` |
| `list_dir` | `directory listing` / `directory listings` |
| `process` | `process operation` / `process operations` |
| `task` | `subagent task` / `subagent tasks` |
| 未知工具及超过展示上限的类型 | `other operation` / `other operations` |

- 每项调用计数一次，不统计返回结果数、不同资源数或 Child 内部调用数。
- 按类型首次出现顺序，最多显示三种已知类型，其余及未知工具合为一个 `N other operations`；没有剩余项不显示该短语。
- 例：`5 file reads, 1 command, 2 searches, 2 other operations`。
- 使用中性计数，不随请求、审批、运行或终态切换时态，不表示执行成功。
- 去掉重复的总工具数量徽标（`N tools`），保留既有审批提示和展开／收起控件。
- 增量到达时更新摘要，但不改变 Group 身份、分组边界、调用顺序或手动折叠选择。

### 2.2 Single Tool

标题使用固定动作词及可辨识对象；文件／目录只显示名称，完整路径留在详情。搜索只取表达式；URL 只取域名和简短路径，省略协议、用户信息、查询参数和 fragment；命令不拼接 cwd 或环境变量。长内容在语义提炼后再做视觉省略。

| Tool / 模式 | 标题 |
|---|---|
| `read_file` | `Read <filename>`，可附行范围 |
| `list_dir` | `List <directory name>`，根目录保留可辨识的根标识 |
| `file_search` | `Find files matching "<query>"` |
| `grep_search` | `Search for "<query>"` |
| `write_file` | `Write <filename>`，不推断新建还是覆盖 |
| `edit_file` | `Edit <filename>` |
| `apply_patch` | `Apply patch`，不解析补丁正文 |
| `web_fetch` | `Fetch <host><short path>` |
| `exec` | `Run <command>` |
| `process:list` | `List background processes` |
| `process:status` | `Check process status · <runId>` |
| `process:log` | `Read process logs · <runId>` |
| `process:kill` | `Stop process · <runId>` |
| `memory_search` | `Search memory for "<query>"` |
| `memory_get` | `Read memory <filename>`，可附行范围 |
| `memory_write:append` 或缺省 mode | `Append to memory <filename>` |
| `memory_write:overwrite` | `Write memory <filename>` |
| `task` | `description` 原文作为主标题，Agent 类型独立标签，状态继续独立显示 |

Task 类型沿用现有实际 Subagent 契约及缺省／回退行为，不增加新类型或更改执行行为。标题不翻译、重写 description，不展示完整 prompt。

### 2.3 Range and fallback

- `read_file`：起止均提供显示 `lines 10–20`；仅起始显示 `from line 10`；仅结束显示 `lines 1–20`；相同行显示 `line 10`；均未提供时不附范围，也不声称全文读取。
- `memory_get`：`from=10, lines=5` 显示 `lines 10–14`；仅 from 显示 `from line 10`；未提供 from 时不附范围，因为现有读取行为此时不应用 lines。
- 范围仅表达有效输入请求，不从执行结果推断 EOF 或实际读取长度。
- 生成标题所需输入缺失、类型错误、空字符串、范围非正整数或起止颠倒时回退为原始 tool name。
- 未知枚举也回退，不猜动作；process 的 status/log/kill 需要非空 runId。
- 不能解析为 HTTP(S) URL 时回退为 `web_fetch`；未知工具保留原始名称。
- 仅可选字段缺省时遵循现有工具语义；展示回退不代替执行校验，不隐藏原始参数、执行错误或状态。

### 2.4 Layout

- Single Tool 标题在折叠与展开时内容相同，使用同一最大宽度及单行省略。
- 标题宽度同时受容器和统一最大宽度约束，允许收缩；类型标签、状态和折叠控件保持可见。
- 最大宽度在实际界面验证中确定，不预设未经验证的像素值；窄窗口及递归 Child 不因标题产生横向溢出。
- 只截断视觉展示，不修改原始输入；完整描述和参数仍可在详情查看。
- Root、递归 Child、实时与 History 复用相同标题规则，按普通文本显示。

## 3. Non-goals and compatibility

不修改工具接口、工具注册、执行或审批权限、事件协议、Transcript、持久化、实时／History 归属合并、分组边界或自动折叠规则。不新增模型摘要、分类注册框架、通用模板系统、工具元数据协议或用户配置。

保留展开后的调用顺序、完整输入及结果。旧记录缺少分组信息时不强行分组；缺少标题参数时使用原始工具名称。原始名称继续保留在事实数据中，不用 display title 替代调用身份。

Group 新标题及移除重复数量徽标是本次有意的展示变化；交付时同步相关现有展示说明，不改变 Session Execution Presentation 的执行和折叠契约。

## 4. Delivery

| Item | Status | Work | Exit condition |
|---|---|---|---|
| TUR-1 Group | Completed | 客户端分类计数、Group 标题替换、移除重复数量徽标及对应测试 | 相关回归及受控页面检查通过；2026-11-06 owner 人工验收通过 |
| TUR-2 Single Tool | Completed | 标题模板、Task 标签／描述、范围及回退、统一宽度样式与测试 | 14 个内置工具及未知工具、读取范围及异常回退有覆盖；受控宽窄容器检查及 2026-11-06 owner 人工验收通过 |

交付顺序先 TUR-1、再 TUR-2，以便局部验证和验收；Single 标题计算本身不依赖 Group 计数实现。不将两步拆成通用展示框架。

## 5. Validation and acceptance

- Group：全部分类、未知工具、混合及超过三类、单复数、首次出现顺序、调用数守恒；同文件重复读取、多文件补丁和 Child 不产生虚构资源数量。
- Single：完整模板、范围各组合、非法／缺失输入、未知枚举／工具、URL 显示裁剪及原始输入保留。
- 行为回归：Root、递归 Child、实时、History、增量合并、审批提示、自动折叠及手动展开选择。
- 实际挂载页面验证：超长文件名、目录名、表达式、URL、命令、Task description；宽窄容器与递归 Child；折叠／展开标题一致、无横向溢出、状态及控件可见、完整参数可查看。
- 运行最小相关测试、客户端类型检查和构建；仅在发现影响范围扩大时升级验证。具体命令及结果在本节记录，不在执行前宣称通过。
- owner 确认可读性与宽度表现后才能标记完成或归档。

### Evidence

2026-11-06 已完成两步局部实现：

- [tool-presentation.ts](../../../../extensions/websocket-channel/client/src/client/tool-presentation.ts) 集中放置确定性 Group 计数及 Single 标题格式化；没有工具注册、协议或执行状态改动。
- [MessageItem.vue](../../../../extensions/websocket-channel/client/src/components/MessageItem.vue) 复用相同展示函数处理实时／历史及递归 Child。Task 优先使用已有 scope 中的实际类型，缺省沿用请求类型或 General purpose。
- Single 标题上限为 `32ch`，Task 类型标签上限 `14ch`，均单行省略。为使窄容器及递归 Child 中标题、状态和按钮可见，限制组容器宽度并将工具卡横向内边距从 20px 收紧为 12px。
- URL 标题保留 host 及前两段非空路径，存在更多路径时附 `/...`；原始 URL 不变。

检查记录：

| Check | Result |
|---|---|
| 首次 Group 聚焦测试：`npm test -- extensions/websocket-channel/client/src/client/tool-presentation.test.ts extensions/websocket-channel/client/src/components/MessageItem.test.ts` | 23 passed（Single 实现前） |
| 综合相关回归：`npm test -- extensions/websocket-channel/client/src/client extensions/websocket-channel/client/src/components/MessageItem.test.ts` | 162 passed，8 files；包括 74 个标题测试和 7 个组件测试 |
| `npm run lint:client --workspace @my-agent/websocket-channel` | passed |
| `npm run prepare:websocket-client` | build passed，62 个发布资源校验通过 |

综合回归中发现的 memory 范围极值计算已修正：先计算 `lines - 1` 再加起始行，避免不安全的中间整数产生误导标题。最终测试通过。

浏览器验证使用临时 Vite 页面挂载真实 MessageItem 和现有 CSS，提供合成的文件／目录、搜索、网页、命令、Task 和递归 Child 调用，不运行真实工具：

- Classic／Botanical、760／360／280px 容器、折叠／展开，共 12 组组合。
- 各组合中的 7 张工具卡没有标题造成的横向溢出，标题不超过上限，展开前后标题文本一致，状态、按钮和 Researcher 类型标签可见。
- 桌面长标题约 258px；280px 容器中的 Task 标签约 53px，描述可用区域约 24px，保持省略而不挤掉标签或状态。
- Group 折叠后卡片数为 0、标题不变，重新展开恢复 7 张卡片；未修改既有折叠处理。
- 验证中暴露的组容器撑宽及 Task 类型被压缩问题已在本次样式内修正。临时页面已删除，临时服务已停止。

限制：页面检查是实际组件的受控挂载，不是完整 Runtime／Provider 端到端验收。普通 Vite 首页缺少 Host 注入配置，不能直接作为完整 App 验证入口，因此使用独立临时挂载页。当前 Node 为 20.16.0，Vite 提示要求 20.19+ 或 22.12+；本次构建及资源校验仍成功，未升级环境、未安装依赖。以上自动化证据的范围不因 owner 人工验收通过而扩大。

### Aborted badge follow-up

2026-11-06 owner 指出 Aborted 与 Succeeded 同为绿色，容易误读。仅给 Tool／Subagent 徽标绑定已有状态，并将 aborted 显示为琥珀色；成功态及其他既有样式不变。不修改执行事实、History 状态、关闭流程或折叠逻辑。

- 组件聚焦回归 9 项通过，客户端类型检查、重新构建及 62 项发布资源校验通过；Node 版本提示与前述相同，未调整环境。
- 实际挂载历史工具卡，Classic／Botanical 下确认 Succeeded 保持绿色，Aborted 为 `rgb(140, 77, 36)` 文字及琥珀色背景；两者计算样式不同。
- 临时验证页面已删除，服务已停止。

## 6. Owner acceptance

2026-11-06 16:57（UTC+8），owner 确认：“可以了，我人工测试觉得可以。”

本次 Group／Single Tool 可读性改动及 Aborted 徽标颜色修正已完成人工验收，两项交付标记 Completed。2026-11-06 根据 owner 确认继续收尾，将规则提升至现有 Channel Specification 并归档本 Change。未自动 commit/push。

## 7. Commit scope

本次产品改动范围：

- 新增客户端 `tool-presentation.ts` 和 `tool-presentation.test.ts`：分类计数、标题格式化及相关单元测试。
- `MessageItem.vue`：Group／Single 标题、Task 类型标签及 aborted 徽标状态绑定。
- `MessageItem.test.ts`：本次标题及状态徽标的组件断言，不包括既有 Group／Approval 的前序实现。
- `style.css`：标题宽度、组容器宽度、窄容器工具卡布局及 aborted 琥珀色。
- 文档：本归档记录、Change／Research／Specification 索引、研究草稿承接链接、Channel 稳定规范及架构概述、Session Execution Presentation Spec 中的标题规则链接。

2026-11-06 owner 授权按功能提交，并确认 Session Execution Presentation 已经过多轮人工测试、人工审核通过。本批按依赖顺序拆为展示留存／路由基础、客户端递归展示／工具分组／审批卡组、Subagent 终态折叠修复、Aborted 徽标和工具可读性五个提交。共享文件使用独立暂存快照验证，不将无关治理／fitness 调整或原始 message／模型 User prompt 分离改动混入，也不撤销工作区内容或推送。

提交前以实际暂存集合导出独立快照，使用已缓存的 Node 22.23.3 验证：39 个相关测试文件、775 项测试通过；`npm run lint`、`npm run prepare:websocket-client` 及 62 项构建资源校验通过，234 个相关文档本地链接均有效。各中间功能提交也分别在对应暂存快照通过聚焦回归和类型检查，不以包含未提交依赖的工作区测试代替提交验证。未安装依赖、未切换全局 Node、未执行线上 Provider E2E。
