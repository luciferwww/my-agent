# Tool Use 可读性设计草稿

> Status: Non-authoritative design draft
> Authorization: 仅用于讨论，不授权实现，不覆盖 Accepted Decisions、Specifications 或源代码
> Date: 2026-11-06
> Scope: Tool use group display title 与 single tool use display title
> Discussion update: 2026-11-06，已确认 Group 中性计数、三类上限及去除重复数量徽标；Single Tool 模板、范围、回退及统一宽度规则已确认。仍不授权实现。
> Follow-up: [Tool Use Readability Change](../changes/archive/tool-use-readability/plan.md) 已于 2026-11-06 完成人工验收并归档；交付证据留在归档中，可复用规则以 [Channel Specification](../specifications/channel.md#bundled-websocket-tool-readability) 为准，本文仅保留讨论来源。

## 1. 背景与目标

当前工具组使用 `LLM call N` 作为标题，体现内部模型调用边界，却没有告诉用户本组做了什么。单个工具卡直接显示 `web_fetch` 等工具名称，同类工具连续出现时，需要阅读参数才能区分操作对象。

希望提供两个层次的可读标题，第一阶段只处理 Group：

| 层次 | 用户需要了解 | 候选示例 |
|---|---|---|
| Tool use group | 本组包含哪些操作、各有多少项 | `5 file reads, 1 command, 2 searches` |
| Single tool use | 这一项操作针对什么对象 | `Read conversation.ts, lines 340–430` |

第一版 UI 文案使用英文。标题从已有工具事实确定性生成，不额外调用模型。

## 2. 当前实现与边界

- [MessageItem.vue](../../extensions/websocket-channel/client/src/components/MessageItem.vue) 显示 `LLM call N`、工具数量，以及单个工具与递归 Child 内容。
- [conversation.ts](../../extensions/websocket-channel/client/src/client/conversation.ts) 定义工具 segment 与 group，保留工具名称、输入和调用身份。
- [history.ts](../../extensions/websocket-channel/client/src/client/history.ts) 还原历史展示并与实时内容合并。
- 分组边界和折叠规则以 [Session Execution Presentation Specification](../changes/active/session-execution-presentation/specification.md) 为准；本草稿不修改它们。

### 2.1 已有工具清单

2026-11-06 核对源码及注册入口，共有 **14 个内置工具定义**：Environment 10 个、Memory 3 个、Task 1 个。这是源码支持的清单，不表示每个运行中 Agent 都启用了全部工具。

注册依据：[Environment contribution](../../src/builtins/tools/environment/contribution.ts:27)、[Memory contribution](../../src/builtins/tools/memory/contribution.ts:12)、[Task contribution](../../src/builtins/tools/task/contribution.ts:9)。Environment 的 `web_fetch`、`exec`、`process` 受各自开关控制；当前仓库内两个 bundled extensions 没有额外注册 Tool。

下表区分真实输入契约和候选展示分类；分类仍待讨论。输入字段中 `?` 表示可选。

| Tool / 定义来源 | 实际用途 | 输入字段 | Group 候选类型 |
|---|---|---|---|
| [read_file](../../src/builtins/tools/environment/filesystem/read-file-tool.ts:48) | 读取文件全文或行范围，不读取目录 | `path`, `startLine?`, `endLine?` | File reads |
| [list_dir](../../src/builtins/tools/environment/filesystem/list-dir-tool.ts:20) | 列出目录直接子项 | `path` | Directory listings |
| [file_search](../../src/builtins/tools/environment/search/file-search-tool.ts:27) | 按文件名或 glob-like 路径模式找文件 | `query`, `path?`, `maxResults?` | Searches |
| [grep_search](../../src/builtins/tools/environment/search/grep-search-tool.ts:48) | 搜索文件内的文本或正则 | `query`, `isRegexp`, `path?`, `includePattern?`, `maxResults?` | Searches |
| [write_file](../../src/builtins/tools/environment/filesystem/write-file-tool.ts:17) | 新建文件或完整覆盖现有文件 | `path`, `content` | File changes |
| [edit_file](../../src/builtins/tools/environment/filesystem/edit-file-tool.ts:29) | 单个文件内一次精确文本替换 | `path`, `oldText`, `newText` | File changes |
| [apply_patch](../../src/builtins/tools/environment/filesystem/apply-patch-tool.ts:229) | 补丁修改，支持新增、删除、移动及多文件 | `input`（完整补丁文本） | File changes |
| [web_fetch](../../src/builtins/tools/environment/web/web-fetch-tool.ts:80) | 获取 HTTP(S) URL 并提取可读内容 | `url`, `extractMode?`, `maxChars?` | Web fetches |
| [exec](../../src/builtins/tools/environment/process/exec-tool.ts:204) | 执行 shell 命令，支持转后台或直接后台执行 | `command`, `timeout?`, `cwd?`, `env?`, `yieldMs?`, `background?` | Commands |
| [process](../../src/builtins/tools/environment/process/process-tool.ts:71) | 管理 exec 启动的后台进程 | `action`（`list/status/log/kill`）, `runId?`, `tailLines?` | Process operations |
| [memory_search](../../src/builtins/tools/memory/memory-tools.ts:19) | 语义与关键词搜索记忆 | `query`, `maxResults?`, `minScore?` | Searches |
| [memory_get](../../src/builtins/tools/memory/memory-tools.ts:63) | 读取记忆文件，可指定起始行和行数 | `path`, `from?`, `lines?` | File reads |
| [memory_write](../../src/builtins/tools/memory/memory-tools.ts:100) | 追加或覆盖记忆文件 | `path`, `content`, `mode?`（`append/overwrite`） | File changes |
| [task](../../src/builtins/tools/task/task-tool.ts:74) | 委派隔离上下文中的 Subagent 子任务 | `description`, `prompt`, `subagent_type?` | Subagent tasks |

### 2.2 从清单得到的约束

- 不同工具的读取范围参数不同，标题生成需遵循各自契约：`read_file` 使用 `startLine/endLine`；`memory_get` 使用 `from/lines`，显示起止范围时需按起始行和行数换算。
- `read_file` 与 `list_dir` 是两个工具，不能将读文件输入模式猜成目录列表。
- `process` 的状态查询、日志读取和停止操作不是新的命令执行，不能累加到 `Commands`。
- `file_search`、`grep_search`、`memory_search` 可以汇总为 Searches，但展开时仍区分文件名、内容和记忆搜索。
- 文件新建、覆盖、补丁和记忆写入先统称 File changes，比把所有操作叫作 edits 更准确；数量仍是调用次数，不是修改文件数。
- `task` 可以有明确的 Subagent tasks 分类，不必一律降为 other；Child 内部操作仍不纳入父组计数。
- 未核对的外部扩展工具保持 `other operations`；本阶段不引入注册契约来要求扩展提供分类。

这里的“按操作类型分组”仅指标题内的汇总，不是重新组织工具卡：

- 不跨现有 Group 合并工具。
- 不按类型重排展开后的工具、正文、Thinking 或 Child。
- 不修改自动收起、手动展开、状态及 Approval 行为。
- 不向 Transcript 写入标题，不新增事件或协议字段。
- Root、递归 Child、实时和 History 使用同一标题规则。

## 3. Group 标题：本次讨论重点

### 3.1 方案

以现有 Group 中的 Tool Calls 为输入：

1. 将已知工具映射到操作类型；不同工具可以属于同一类型。
2. 统计各类型的调用数量。
3. 按各类型首次出现的顺序生成短语。
4. 用逗号连接为标题，替换 `LLM call N`。

示意：

```text
5 file reads, 1 command, 2 searches, 2 other operations ▾
  展开后仍显示原始调用顺序和各项详情
```

标题只表达调用类型与数量，不表示已经执行或成功完成所有操作。

### 3.2 分类建议

依据第 2.1 节的源码清单提出以下候选分类。工具语义已经核对，但展示名称与归类仍待确认；不按名称子串猜用途。

| 操作类型 | 英文中性计数短语示例 | 说明 |
|---|---|---|
| 文件读取 | `5 file reads` | 读取全文及行范围均属于读取 |
| 搜索 | `2 searches` | 可汇总不同的明确搜索工具 |
| 命令执行 | `1 command` | 不根据命令文本推断进一步用途 |
| 文件变更 | `2 file changes` | 覆盖写入、补丁、编辑和记忆写入；不声称修改了多少文件 |
| 网页获取 | `4 web fetches` | 不把获取网页归为搜索 |
| 目录列表 | `2 directory listings` | 与读取文件区分 |
| 进程操作 | `2 process operations` | 包括查询、日志与停止，不重复计作命令 |
| Subagent 委派 | `2 subagent tasks` | 不包含 Child 内部操作计数 |
| 其他 | `2 other operations` | 未识别的工具，不猜操作类型 |

先用已核对的内置工具明确映射，不增加工具分类注册框架、插件契约或用户配置。是否进一步压缩上述分类，留待讨论。

### 3.3 计数含义

建议按 Tool Call 计数，而不是参数项数、输出数量或去重后的资源数：

- 同一文件读取两次算两次读取；不能推断是两个不同文件。
- 一个搜索调用返回多个命中，仍算一次搜索。
- 一个命令工具运行复合命令，仍算一次调用。
- 一个编辑调用涉及多个文件，仍算一次编辑操作。
- 不将 Child 内部的 Tool Calls 累加到父 Group；它们属于 Child 自己的 Group。
- 汇总展示中的每项调用恰好一次，不把实时／History 双路径当作两个调用。

使用 `N file reads`，避免将重复读取说成 N 个不同文件。

### 3.4 执行中与完成后的文案

标题由调用生成，不能把“请求执行”说成“执行成功”。成功、失败和等待审批继续由现有状态展示表达。

讨论已确认统一使用中性计数短语，例如 `5 file reads, 1 command, 2 searches`。执行中和完成后使用相同文案，不进行 `fetching/fetched`、`listing/listed` 等时态切换，不增加状态驱动的标题逻辑。

### 3.5 长度与增量更新

- 新的 Tool Call 到达时，更新本组统计；不等待整个 Group 完成。
- 标题保持在展开和收起两种状态下可见。
- 单复数正确，例如 `1 search` / `2 searches`。
- 最多显示按首次出现顺序排列的三种已知操作类型；剩余类型及未知工具调用合并为一个 `N other operations` 短语。N 是调用数，不是类型数；没有剩余项时不显示该短语，只有未知工具时仅显示该短语。
- 去掉重复的总工具数量徽标（`N tools`），保留既有审批提示和展开／收起控件；所有分类数量与 other 数量之和等于本组总调用数。
- 仅标题可随新调用更新，不改变 Group 身份或用户折叠选择。

## 4. Single Tool 标题

方向是“工具语义 + 关键参数模式”，不只是把原始名称转换成友好名称：

| 已知输入模式 | 英文标题示例 |
|---|---|
| 文件路径 | `Read conversation.ts` |
| 文件路径与行范围 | `Read conversation.ts, lines 340–430` |
| 搜索表达式 | `Search for "subagentExpanded"` |
| 网页 URL | `Fetch huggingface.co/docs/...` |
| 命令 | `Run npm test` |

同一工具的不同输入模式可以生成不同标题。实际格式应基于工具定义确认，不能从名称猜测输入字段。

标题使用固定动作词，不随执行状态切换时态。标题仅使用适合直接展示的关键参数，不复制整份输入；显示内容按普通文本处理。未知工具保留原始 tool name，状态徽标保持独立。

### 4.1 Task 的特殊展示

讨论已确认：Task 的任务描述作为主标题，Agent 类型单独显示为标签，不将 `Delegate:`、类型和描述拼成一串长标题。

```text
[Researcher] 请帮我从 Bing 网站搜索… [Running]
```

- 主标题使用 `description` 原文，不翻译、重写或展示完整 `prompt`。
- 类型标签体现所选 Agent 类型，例如 General purpose、Researcher、Explorer、Reviewer。
- 状态继续独立显示，不放入描述标题。
- 类型的实际可用名称及缺省／回退展示应遵循已有 Subagent 契约，不因展示功能更改执行行为。

### 4.2 按工具语义提炼标题

讨论已确认：先按工具语义选择最有辨识度的信息，再以宽度省略兜底；不是将原始参数统一截取前 N 个字符。

| 操作 | 标题提炼规则 |
|---|---|
| 文件操作及记忆文件读写 | 只显示文件名，不显示完整路径；读取时保留必要行范围 |
| 目录列表 | 显示目录名，完整路径放详情 |
| 搜索 | 显示搜索表达式，不拼接全部过滤参数 |
| 网页获取 | 显示域名和简短路径，省略协议、查询参数等；完整 URL 放详情 |
| 命令执行 | 显示命令文本，不拼接 cwd、环境变量等 |
| Task | 描述作为主标题，Agent 类型独立标签 |

不调用模型改写标题，不因此修改原始输入。`apply_patch` 等没有单一对象的工具按各自模板处理，不强行从正文提取文件名。

### 4.3 所有 Single Tool 统一的宽度兜底

标题始终是简短摘要，与展开状态无关。上述语义提炼后仍然过长的标题，采用统一的宽度处理：

- 标题区域同时受容器可用宽度和统一最大宽度限制，不随长内容无限撑宽卡片。
- 标题保持单行，超出时以省略号显示；按实际宽度截断，不按固定字符数截断。
- 标题区域允许收缩；独立的类型标签、状态徽标和展开／收起控件不被长标题挤出。
- 窄窗口及递归 Child 中也不得产生标题造成的横向溢出。
- 截断仅影响视觉，不修改原始描述或参数；详情仍可查看完整描述及参数。
- 折叠和展开使用相同标题内容及宽度上限；展开只显示详情，不恢复为完整路径或扩大标题宽度。

具体最大宽度在实施时结合现有卡片样式确认，本草稿不先指定未经界面验证的像素值。

### 4.4 Single Tool 模板建议

以下模板及第 4.5–4.6 节的范围与回退规则已于本轮讨论确认。对象文本先按第 4.2 节提炼，再应用宽度约束。

| 工具 | 标题模板 |
|---|---|
| `read_file` | `Read <filename>`，有显式范围时附加下节的范围短语 |
| `list_dir` | `List <directory name>`；根目录保留可辨识的根标识 |
| `file_search` | `Find files matching "<query>"` |
| `grep_search` | `Search for "<query>"` |
| `write_file` | `Write <filename>`，不从输入推断新建还是覆盖 |
| `edit_file` | `Edit <filename>` |
| `apply_patch` | `Apply patch`，不为标题解析补丁正文 |
| `web_fetch` | `Fetch <host><short path>`，不显示 URL 用户信息、查询参数或 fragment |
| `exec` | `Run <command>`，不另行推断“构建／测试”等动作 |
| `process`, `action=list` | `List background processes` |
| `process`, `action=status` | `Check process status · <runId>` |
| `process`, `action=log` | `Read process logs · <runId>` |
| `process`, `action=kill` | `Stop process · <runId>` |
| `memory_search` | `Search memory for "<query>"` |
| `memory_get` | `Read memory <filename>`，范围见下节 |
| `memory_write`, `mode=append` 或缺省 | `Append to memory <filename>` |
| `memory_write`, `mode=overwrite` | `Write memory <filename>` |
| `task` | `description` 为主标题，Agent 类型独立标签，沿用第 4.1 节 |

### 4.5 读取范围：表达请求，不假装知道实际文件长度

依据 [read_file](../../src/builtins/tools/environment/filesystem/read-file-tool.ts:98)：

| 输入 | 标题示例 |
|---|---|
| 未提供范围 | `Read a.ts` |
| `startLine=10, endLine=20` | `Read a.ts, lines 10–20` |
| 仅 `startLine=10` | `Read a.ts, from line 10` |
| 仅 `endLine=20` | `Read a.ts, lines 1–20` |
| 起止相同，例如 `10/10` | `Read a.ts, line 10` |

无范围时，当前工具默认最多读取前 200 行，不应将标题写成“全文读取”。实际行数可能被 EOF 裁剪；标题表达输入范围，不从结果重新计算，也不引入前后状态切换。

依据 [MemoryManager.readFile](../../src/core/memory/MemoryManager.ts:135)：

- `from=10, lines=5` → `Read memory MEMORY.md, lines 10–14`。
- 仅 `from=10` → `Read memory MEMORY.md, from line 10`。
- 未提供 `from` → `Read memory MEMORY.md`。当前实现即使传了 `lines` 也不应用行数限制，标题不能虚构 `lines 1–N`。
- 正整数范围才生成范围短语；不改变现有工具的参数校验或读取行为。

### 4.6 缺失及异常输入的展示回退

- 输入不是可用对象、生成标题所需字段缺失／类型不符／空字符串，或已提供范围不是有效正整数、起止颠倒时，回退为原始 tool name。
- 已知枚举出现未知值时也回退，例如未知 `process.action` 或 `memory_write.mode`；不猜默认动作。
- `process` 的非 list 动作需要非空 `runId` 才生成上述标题。
- URL 无法作为 HTTP(S) URL 解析时，回退为 `web_fetch`，不原样拼接异常 URL。
- 只有可选参数缺省时，遵循对应工具现有缺省语义；不为工具补造输入。
- 回退只是标题展示策略，不将调用标记成功、不抹去原始参数或执行错误，也不代替工具本身的校验。
- 未知工具显示原始 tool name；其原始输入及结果仍按已有详情展示。

本阶段不实现 Single Tool 标题，不扩展为模型生成摘要、通用模板系统或工具元数据体系。

## 5. Group 验收建议

设计确认后，实施时验证：

- 单种、多种、未知及混合操作的标题与计数。
- 单复数、类型首次出现顺序及确认后的长度上限。
- 同资源重复调用、复合命令不会产生虚构的资源计数。
- 请求中、审批中、成功和失败均不会通过标题误报成功。
- Root、Child、实时和 History 相同事实生成相同标题。
- 增量更新及 History 合并不重复统计，不改变顺序和折叠选择。
- 缺少分组归属的旧工具不被本功能强行分组。

Single Tool 后续验收还应覆盖各类型的语义提炼，以及超长 Task 描述、文件名、URL 和命令在折叠、展开、窄容器及递归 Child 中不撑宽标题。展开前后标题内容及宽度上限一致，类型、状态和折叠控件可见，完整内容仍可查看。

## 6. 讨论进展与剩余细节

- Group 方向已认可，统一中性计数短语，不做时态切换。
- Group 已确认最多显示三种已知类型，其余调用计入 other operations；去掉重复总数量徽标，保留审批提示与折叠控件。
- Single Tool 已确认 Task 使用“类型标签 + 描述主标题 + 状态”；不同工具先按语义提炼标题，再统一限制宽度并单行省略，折叠与展开保持同一简短标题。
- Single Tool 完整模板、范围和回退规则已确认；注意 memory_get 在缺省 from 时不会应用 lines，标题遵循实际行为。
- 本草稿不授权实现；展示细节确认不等同于开始修改产品代码。
