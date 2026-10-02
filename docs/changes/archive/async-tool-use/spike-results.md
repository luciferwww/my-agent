# Async Tool Use Steering Projection Spike Results

> Status: Completed and Archived — bounded Provisional Pass accepted
> Executed: 2026-09-30；统一 accepted + Host completion 在 Relay Chat/Responses 与 Messages-compatible endpoint 有界通过；原方案 A 完整矩阵未完成且不再是首选方向
> Accepted: 2026-10-02
> Archived: 2026-10-02
> Environment: Node v20.16.0 / Windows；项目要求 Node 22，目标版本未验证
> Owner: Project owner
> Authority: Evidence only
> Specification: [Accepted scope / executing Spike](spike-specification.md)

## Question and hypothesis

按方案 A 保留原调用直到真实终态，在期间构造合法控制上下文处理 steering，完成后合并完整配对与期间对话。问题、假设与 AP-1 至 AP-9 以关联 Spec 为准。

范围澄清（项目所有者 2026-09-30 指出）：本轮核心验证是工具 pending 时能否通过控制投影取得模型回复，以及完成后能否通过配对投影续调；不是评测模型能否准确理解合成业务意图。先前将报数/提醒质量作为协议实验成败依据属于范围偏移。保留所有原始响应及质量观察，但它们不构成本轮机制失败判据，也不抹去恢复等尚未验证项。

## Method actually executed

早期后台任务未交回报告，后已确认取消。接手检查发现其留下 `projection.ts` 和一个未验证的测试；下述后续验证直接使用并验证这些文件，不将后台 running 状态算作成果。不改生产路径。

项目所有者随后授权通过免 Key 的 `http://127.0.0.1:5000/v1/models` Relay 验证两个 OpenAI 协议，并选定均用 `gpt-5.4`。模型目录已实际读取：该模型宣告 `/chat/completions` 和 `/responses`，policy enabled，支持 tool calls。

### 最小实网 smoke：2026-09-30 16:49:28–16:49:44（UTC+8）

完整原型阶段迟迟未返回可核实结果，因而先执行更窄的 raw HTTP 检查。会话附件保留 `steering-relay-smoke.mjs` 与 `steering-relay-smoke-results.json`，包含合成请求、原始响应、HTTP 状态及时间；不使用真实任务数据。

实际命令为 `node <session-files>\steering-relay-smoke.mjs`，退出码 0。脚本使用 Node 内置 fetch，无新增依赖；每请求最多 60 秒，全局期限 210 秒，生成请求上限 6，无重试。本次共 6 次 POST，无 Authorization header。

每个协议各三次请求：

1. 强制选择 `fixture_task`，由真实模型生成一个工具调用和关联 ID。
2. 启动一次计数的受控 deferred fixture，不释放结果。临时控制上下文移除未闭合调用，提供宿主 pending/未知进度状态，发送一条同时包含 NOTE 和进度询问的 steering。检查模型回复到达时 fixture 仍 pending。
3. 释放合成结果“完成 7 个 fixture 文件”，用原始模型调用和原关联 ID 配对一个结果，再追加带执行期间时序注解的 steering/回复，要求最终续调。

这是手工构造的最小投影与 raw HTTP，不经过仓库生产编码器或尚未交付的完整原型。它不是 AP-10 规定的两个独立 steering 回合，也没有验证真实 AgentRunner 控制循环、取消动作或最终结果去重机制。

### 既有 Provider + 两次 steering：16:56:24–16:56:38（UTC+8）

直接运行 [live-steering.ts](../../../../scripts/spikes/async-tool-use/live-steering.ts)，使用现有 `OpenAIChatCompletionsClient` 和 `OpenAIResponsesClient` 的 `chat()`，实际经过各自请求编码器与 SSE 解码器。未修改客户端，未安装依赖。

为保持此前合计 12 次生成请求的上限，本轮复用上一轮每个协议真实模型生成的 `fixture_task` 调用 ID、参数和合成用户前缀，重建隔离 fixture；不再次调用模型启动工具，不重放真实业务副作用。每协议新增 NOTE、进度询问、完成后三次续调，共新增 6 次；两轮累计 12 次，均 HTTP 200。当前模型接口未携带 reasoning 项，因此不据此宣称 thinking/reasoning 重放已经验证。

命令（`<session-files>` 指本会话产物目录）：

```powershell
.\node_modules\.bin\tsc.cmd -p .\scripts\spikes\async-tool-use\tsconfig.json
.\node_modules\.bin\tsx.cmd .\scripts\spikes\async-tool-use\live-steering.ts --live <session-files>\steering-relay-smoke-results.json <session-files>\steering-provider-results.json
```

原型实际执行异步 fixture，两个独立 `steer()` 调用均完成后才释放结果；两次回复后均断言：执行次数为 1、Tool/Root signal 未 abort、没有终态结果、最终投影闸门仍关闭。释放后断言一条真实结果、两条输入、两条回复，投影不修改事实顺序，再通过真实客户端续调。原始请求体、客户端归一化响应、状态码、事实快照和最终投影保存在会话附件 `steering-provider-results.json`。

模型在两个协议下均记住 NOTE；第二次询问均拒绝编造未知数量；最终均报告 7 个 fixture 文件并提醒查看 xxx 数据。另观察到：进度回复偶尔原样复述 `[control reply ... observed_through_fact ...]` 和 call ID。这是当前提示形态下的输出质量观察项，不单独阻塞 D1，不据此断言架构必须调整。

### 聚焦本地取消及竞态

通过 [projection.test.ts](../../../../scripts/spikes/async-tool-use/projection.test.ts) 验证四个场景：

1. 两条 steering 在真实受控 Promise 未释放前回复；结果前禁止最终续调。
2. scripted model 返回 cancel：当前调用收到独立 signal，Root 不 abort；清理完成前没有伪结果且闸门关闭，清理后当前调用 cancelled，排队调用 not_executed，后者未执行。
3. 不合作 Promise 收到取消仍 pending：不得伪造 cancelled 或打开闸门；测试最后释放真实 success，保留该真实结果。
4. 控制回复生成期间 Tool 完成：先等待控制回复，稍后的 cancel 不覆盖 success；相同结果重复交付不追加第二条结果。

本地取消动作由 scripted model 决定，不是实网模型的意图分类证据；未证明任意扩展能强制停止，也未实现真实新路线调度。

验证结果：指定测试文件运行 **4 passed / 0 failed**；聚焦 `tsc -p scripts\spikes\async-tool-use\tsconfig.json` 退出码 0。首次类型检查发现 fetch 包装器的可选 `init` 未缩窄，补充运行时断言后重跑通过。

### SiliconFlow Messages / Chat 对照：17:10:45–17:12:06（UTC+8）

官方 [Create a Message](https://docs.siliconflow.cn/docs/api/messages-post) 文档列出 `/v1/messages`、Bearer 认证、tools/input_schema、示例模型 `deepseek-ai/DeepSeek-V4-Flash`；另有 [Chat Completions](https://docs.siliconflow.cn/docs/api/chat-completions-post)。文档支持接口存在，不等于遵守全部 Anthropic 官方约束。

用户批准同模型最多 9 次生成、60 秒/请求，并提供仓库外临时 Key 文件。运行 [siliconflow-steering.ts](../../../../scripts/spikes/async-tool-use/siliconflow-steering.ts)：先一次 GET models 确认模型，然后 Messages 启动/NOTE/进度/最终/负例五次，Chat 启动/NOTE/进度/最终四次。没有重试，共 9 次生成，全部 HTTP 200；总耗时约 81 秒，其中 Messages NOTE 约 59 秒。没有发送源码或真实会话。

使用现有 Anthropic/Chat 客户端和相同 `ProjectionTurn`，transport 仅添加该服务要求的 Bearer 认证、禁止重定向并记录响应，不修补请求正文或 SSE。原型最终投影中的 assistant 调用消息替换为该次客户端真实 `launch.content`，保留其伴随正文，不丢弃初始 assistant 文本。临时 Key 只用于指定域认证，不存入请求头日志或证据；测试后已提示撤销。

| 观察 | Messages | Chat Completions |
|---|---|---|
| 真实启动工具调用 | 通过，规范化为一个 fixture_task | 通过，规范化为一个 fixture_task |
| NOTE / 进度的 HTTP 与 SSE 解码 | 通过，end_turn | 通过，end_turn |
| 控制回复语义 | 知道任务 pending，保留 NOTE，不编造进度 | 输出文本型 DSML 调用标记，声称要再次启动工具；第二次输出不存在的 request_fixture_status 调用标记 |
| 最终真实结果为 7 且有 NOTE | 回复 `That's all I can honestly provide right now.`，未报告 7 或提醒 | 仅回复 `8`，错误数量且没有提醒 |
| 回答质量观察（非本轮机制验收） | 未达到实验提示预期 | 未达到实验提示预期 |

控制请求没有开放工具，客户端解析出的正式 toolCalls 为空；DSML 是正文，不是实际第二次执行。受控执行次数仍为 1，工具保持 pending 直到两个 steering 回合返回，最终配对请求可正常续调。这些是本轮机制证据；回答是否准确理解业务意图另列，不混为 API 或投影机制失败。

Messages 负例直接使用真实 assistant tool_use 后追加 user NOTE，故意完全省略对应 tool_result。服务返回 HTTP 200、end_turn，正文确认工具仍 pending。因此**该服务在这个负例上没有拒绝未配对历史**，其接受行为不能作为官方 Anthropic 严格配对兼容性的证明。

原始 Messages NOTE 流包含 thinking/signature 相关内容；当前客户端不投影这些字段，后续历史没有重放它们。对失败原因尚无归因：可能涉及提示、模型、服务兼容转换或信息保留，不能从同模型双协议失败直接判定方案 A 不成立，也不能一概归为模型理解偏差。未做官方 Anthropic 或 reasoning 重放对照。

运行命令：

```powershell
.\node_modules\.bin\tsc.cmd -p .\scripts\spikes\async-tool-use\tsconfig.json
.\node_modules\.bin\tsx.cmd .\scripts\spikes\async-tool-use\siliconflow-steering.ts --live <key-file> <session-files>\siliconflow-steering-results.json
```

保存原始合成请求、完整响应流、规范化响应和事实快照到会话附件 `siliconflow-steering-results.json`。首次脚本的退出码 0 / passed 只反映传输与生命周期断言，不是语义成功；实测后明确拆分 `transportAndLifecycle` 与人工 `semanticReview`，语义两项均 failed，原始请求/响应未改写。脚本随后增加最终数量和提醒缺失时的失败退出检查（只是必要条件，不足以自动证明语义通过），仅类型检查、未再发送收费请求。

### GLM-5.3 复测：17:18:06–约 17:19:03（UTC+8）

用户随后指定 `zai-org/GLM-5.3`，复用上述脚本、客户端、原型与临时认证来源。仅增加模型选择参数，取消把报数/提醒缺失当成机制失败退出；没有为新模型修改提示、投影、消息顺序或 transport。每协议启动/NOTE/进度/完成各四次，共 8 次生成，无重试、未重复配对负例。一次目录检查确认模型存在；8 次 POST 均 HTTP 200，客户端均成功解码。原始请求/响应及快照保存在会话附件 `siliconflow-glm-steering-results.json`。

```powershell
.\node_modules\.bin\tsc.cmd -p .\scripts\spikes\async-tool-use\tsconfig.json
.\node_modules\.bin\tsx.cmd .\scripts\spikes\async-tool-use\siliconflow-steering.ts --live <key-file> <session-files>\siliconflow-glm-steering-results.json zai-org/GLM-5.3
```

**本轮机制结果：两协议有界通过。** 真实模型产生一次 fixture_task 调用；工具 pending 期间完成两次控制回复，执行次数为 1、Tool/Root 未 abort、无提前结果；释放真实结果后最终配对请求也获得 end_turn 回复。没有生产接入或真实业务副作用。

**单列回答观察：** 两协议的 NOTE/进度回复均清楚理解工具已运行，不声称再次启动、不编造数量，保留提醒。最终请求已携带真实成功结果 7，但两个最终回复仍称工具 running、结果未返回，并复述先前控制回复的标记。这是旧状态回答，不是 API 拒绝或宿主工具仍 pending；保持事实记录与模型正文的区别。未做提示/消息顺序对照，不能确定是模型、提示、合并时序表示或服务端处理导致，不把此观察升级为本轮机制失败，也不隐瞒该现象。

**边界：** 这次验证支持“能够在 pending 时回复并在完成后继续请求模型”，不额外声称“最终模型正确理解了最新执行状态”。官方 Anthropic 合规、恢复和 compaction 仍未证明。临时 Key 不写入证据，脚本完成后不再使用；新增实网需要新授权。

### 直接追加未配对 steering：17:24:49–约 17:25:25（UTC+8）

按项目所有者新授权执行 [unpaired-steering.ts](../../../../scripts/spikes/async-tool-use/unpaired-steering.ts)。**不是方案 A**：不移除 tool call、不构造运行状态投影、不伪造 tool_result、不重排消息。三个协议分别新生成真实工具调用，宿主保留 pending fixture，再直接发送以下历史：

```text
User: 启动合成工具
Assistant: 原始工具调用（保留返回的正文和 reasoning/thinking 等内容）
User: 工具仍在运行，请确认 NOTE，完成后提醒查看 xxx 数据
```

如果中途请求成功，则释放真实 fixture 结果，并在同一历史末尾依次追加真实控制回复和关联原 call ID 的工具结果。没有把结果挪回原调用之后。使用 raw HTTP 非流式请求，不通过当前会丢弃部分 reasoning/thinking 信息的生产模型接口；仅合成数据，无生产修改。

| 端点 / 模型 | 新启动调用 | 未配对调用后追加 steering | 原时序追加晚到结果 |
|---|---|---|---|
| Copilot Relay `/v1/chat/completions`，gpt-5.4 | 200（修正输出上限参数后） | **400** `invalid_request_error / Upstream rejected the request.` | 未执行，前一步被拒绝 |
| Copilot Relay `/v1/responses`，gpt-5.4 | 200 | **400** `invalid_request_error / Upstream rejected the request.` | 未执行，前一步被拒绝 |
| SiliconFlow `/v1/messages`，GLM-5.3 | 200 | **200**，end_turn、确认 NOTE，fixture 仍 pending | **200**，end_turn，报告完成 7 并保留提醒 |

第一轮 Chat 启动使用 `max_tokens` 即返回 400，尚未进入 steering；不能把这次失败算作配对拒绝。对照此前成功的 raw Chat 请求，将该字段改为 `max_completion_tokens` 后，仅人工重跑 Chat，新启动成功但未配对 steering 被拒绝。该修正是单因素请求参数修正，服务未给更具体原因，不宣称已独立证明原始 400 的根因。总计 8 次生成（第一轮 6、Chat 修正后 2），仍在授权上限 9 内，无自动重试。

命令：

```powershell
.\node_modules\.bin\tsc.cmd -p .\scripts\spikes\async-tool-use\tsconfig.json
.\node_modules\.bin\tsx.cmd .\scripts\spikes\async-tool-use\unpaired-steering.ts --live <key-file> <session-files>\unpaired-steering-results.json
.\node_modules\.bin\tsx.cmd .\scripts\spikes\async-tool-use\unpaired-steering.ts --live <key-file> <session-files>\unpaired-chat-corrected-results.json chat/completions
```

两个运行均退出码 1，因为对照场景明确被拒绝；不是命令未执行或测试悬挂。原始请求与响应分别保存在上述两个附件。**结论：当前 Relay gpt-5.4 两协议拒绝了所测直接追加请求；SiliconFlow GLM Messages 接受了完整直接追加链路。** Relay 错误没有具体说明违规字段，不能进一步断言所有官方实现/模型必定如此。SiliconFlow 结果不能替代官方 Anthropic。

GLM 此次最终正确理解完成状态，与此前重排投影的旧状态回答不同；但两次同时改变了消息顺序、提示及 thinking 保留方式，不能单独归因于某一个因素。对通用设计而言，不能依赖兼容服务较宽松的直接追加行为覆盖 Relay 上已观察到的拒绝。

### Relay 单变量对照：17:28:30 起

用户质疑此前 400 是否来自脚本参数，并要求直接完成工具执行期间的 steering 验证。检查发现原 Chat 响应包含非标准 `padding`，原 Responses 输出带有不透明 item ID；前一轮将输出原样带回，因此单凭那一轮 400 不能排除请求构造干扰。

新增 [relay-steer-control.ts](../../../../scripts/spikes/async-tool-use/relay-steer-control.ts)，复用前一轮真实启动响应和 call ID 构造独立受控工具，不发送新的启动请求、不重放真实业务副作用。Chat 只保留规范 assistant 字段（无 padding）；Responses 使用 reasoning 的 summary/encrypted_content 和 function_call 的 call_id/name/arguments，不回传不透明 item ID。两个协议均使用前述正确输出上限参数，仅访问 `http://127.0.0.1:5000/v1` 的 gpt-5.4。

每协议两次请求：先在工具 Promise 实际未完成时保留调用并追加一条 NOTE；然后释放该 fixture 的真实结果，只在原调用和同一 NOTE 之间增加关联工具结果，其他请求字段完全不变。第一步之后断言工具仍 pending，完整记录两次请求及状态。不隐藏调用、不跑方案 A、不追加其它变量，共 4 次生成，无重试。

| 协议 | 保留调用、工具 pending、追加 steering | 仅增加匹配结果的同一请求 |
|---|---|---|
| Relay Chat Completions | **400**，返回后 fixture 仍 pending | **200** |
| Relay Responses | **400**，返回后 fixture 仍 pending | **200** |

因此在这组规范化请求中，失败可定位到**缺少配对工具结果的历史形态**，不是两份请求共同的模型/输出上限等参数，Chat padding 也已排除。仍不推断官方直连或其他模型行为。前轮 SiliconFlow GLM Messages 则已走通直接 steering 和原时序晚到结果；不需要重复收费请求。

命令：`tsx scripts\spikes\async-tool-use\relay-steer-control.ts --live <session-files>`（实际使用仓库本地 tsx）；聚焦 tsc 通过，脚本退出 0。证据附件 `relay-steer-control-results.json` 保留完整请求和响应。本次明确观察预期拒绝，因此进程成功完成不代表两个 unpaired 请求成功。

### accepted 句柄 + 普通完成通知：17:57:45–17:57:53（UTC+8）

按项目所有者要求，直接证明以下 7 步在 Copilot Relay 的 gpt-5.4 Chat/Responses 是否可用：

1. 模型产生 `start_download` tool call。
2. 宿主用匹配 call ID 返回 `{status:"accepted", taskId}`，闭合原调用。
3. 追加真实用户 steering。
4. 模型正常确认提醒。
5. 宿主追加一条明确标注来源的普通 user-role 完成通知，包含 taskId、success 和真实输出 7；它不是原调用的第二个 tool_result。
6. 宿主自动携带完整历史再次请求模型。
7. 模型根据完成通知继续回复。

运行 [host-completion-notification.ts](../../../../scripts/spikes/async-tool-use/host-completion-notification.ts)，每协议三次请求，共 6 次，全部 HTTP 200，无重试。现有工具定义只在启动请求出现；steering 与完成通知请求不开放工具，因此没有重复执行。Responses 重放启动响应中的 reasoning summary/encrypted_content；Chat 只重放规范 assistant tool_calls。完成通知格式为：

```text
role: user
<host_task_completion>
{"taskId":"...","tool":"start_download","status":"success",
 "output":"Synthetic download completed: exactly 7 files processed."}
</host_task_completion>
This is a trusted host lifecycle notification, not a new user request.
Continue the current turn using this result.
```

| 协议 | accepted 后 steering | 普通完成通知后自动续调 | 最终正文 |
|---|---|---|---|
| Relay Chat Completions | 200，确认完成后提醒 | 200 | “提醒：下载已完成，请查看 xxx 数据。” |
| Relay Responses | 200，确认完成后提醒 | 200 | “下载已完成：共处理 7 个文件。请查看 xxx 数据。” |

Chat 最终正文没有复述数量 7，但明确消费了完成状态并保留提醒；Responses 同时复述结果和提醒。本轮验收的是编码与自动续调可用，不要求固定措辞。原始请求/响应保存在 `host-completion-notification-results.json`。聚焦 TypeScript 检查通过；脚本退出 0。

**该实验已证明当前 Relay 两协议支持“accepted 先闭合＋期间 steering＋普通宿主完成通知＋自动续调”的有界请求形态。** 它还不是生产实现：通知的可信来源、持久化、去重、prompt-injection 边界、恢复、compaction、何时触发续调与 Turn 结束闸门仍需设计。user role 是本次可行编码，不等于最终选定的跨 Provider 规范。

### 统一 Messages 对照：18:00:38–18:00:52（UTC+8）

项目所有者要求统一机制，避免在 `runAttempt` 为不同协议维护不同控制路径。使用 [host-completion-notification-messages.ts](../../../../scripts/spikes/async-tool-use/host-completion-notification-messages.ts)，在 SiliconFlow GLM-5.3 Messages 上执行相同三步：

1. 真实 `start_download` tool_use。
2. 下一条 user message 先放匹配的 accepted tool_result，再放 steering text；模型确认 accepted/running 状态和提醒，不重复工具。
3. 宿主追加与 Relay 同形状的 user-role `<host_task_completion>` 普通通知并主动续调；模型报告成功、7 个文件并提醒查看 xxx 数据。

三次请求均 HTTP 200，无重试；完整 launch content（包括 thinking/signature）在后续消息中原样重放。临时认证仅用于指定 SiliconFlow HTTPS origin，未写入证据。原始证据保存在 `host-completion-notification-messages-results.json`。

Messages 的 wire 限制由投影/适配层处理：accepted tool_result 必须紧随原 assistant tool_use，因此与首次 steering text 放在同一条 user message 的内容块中。**这不要求 Runner 采用 Messages 专用状态机**。核心统一事实仍是：

```text
ToolRequested
→ ExecutionAccepted(executionId)
→ SteeringReceived / SteeringReplied（可重复）
→ ExecutionTerminal(success | failed | aborted)
→ HostTaskCompletionDelivered
→ LLM continued
```

Chat、Responses、Messages 均已对该核心流程取得有界实网证据。Provider 差异限制在 canonical history 到 wire 的编码；执行所有权、事件仲裁、通知去重和 Turn 闸门不得分散到各 Provider 或 `runAttempt` 分支。

## Evidence

| ID | Observation | Result |
|---|---|---|
| AP-1/2 | 两协议使用原型与现有编码器，两次 steering 后才释放真实 fixture 结果；保留两次输入/回复 | Bounded pass |
| AP-3/4 | 本地 scripted cancel，清理闸门、Root 不 abort、第二调用 not_executed；未验证真实模型分类和正常多调用实网 | Partial evidence |
| AP-5 | 完成期间控制回复、晚 cancel、重复相同结果通过；Root Abort 与重叠控制调用完整矩阵未验证 | Partial evidence |
| AP-6 | 不合作 Promise 不产生伪终态；最终由测试释放 | Bounded pass |
| AP-7 | 未实现快照加载验证或矛盾记录拒绝 | Not run |
| AP-8 | 现有 Chat/Responses 编码及 SSE 解码实网通过，保存实际请求体；独立 wire 负例校验及其他编码器未跑 | Partial evidence |
| AP-9 | 下文及 Findings 已记录模型回显、reasoning、生命周期与生产限制 | Recorded |
| AP-10 | 两协议两个独立 steering 回合及完成续调通过；启动 call 使用前轮真实响应，未重做启动调用 | Bounded pass |
| AP-11 | SiliconFlow 同模型 Messages/Chat 的 pending 期间两次回复及完成配对续调通过；回答质量另列；负例接受不证明官方合规 | Bounded mechanism pass / official conformance unverified |
| AP-11 GLM follow-up | GLM-5.3 双协议各四次请求通过，pending 回复及最终配对续调可执行；最终正文仍复述旧状态，单列观察 | Bounded mechanism pass / stale-state response observed |
| Direct-append follow-up | Relay Chat/Responses 未配对 steering 返回 400；SiliconFlow Messages 追加 steering 与晚到结果均成功 | Provider-dependent; not a portable replacement for A |
| Relay controlled follow-up | 清理输出专用字段后，两协议 pending steering 均 400；只添加匹配结果均 200 | Missing-result history isolated in tested requests |
| Host completion notification | Relay Chat/Responses 均通过 accepted 句柄、期间 steering、普通完成通知与宿主自动续调 | Bounded pass for tested encoding |
| Unified Messages notification | SiliconFlow Messages 通过同一 accepted/steering/completion 流程；仅 wire 合并规则不同 | Bounded pass for unified core contract |
| Smoke-Chat | launch / pending-steering / merged-result 均 HTTP 200，终态可用；回复时 fixture pending | Passed |
| Smoke-Responses | launch / pending-steering / merged-result 均 HTTP 200，status completed；回复时 fixture pending | Passed |

## Findings

以下符合提示预期的回复摘录仅属于 Relay 的 gpt-5.4，不代表 SiliconFlow 的回答质量。Relay 两个协议均在结果未释放时回复 NOTE 和进度询问，没有编造下载数量；最终回复均保留提醒、报告实际合成结果 7，并区分“之前未知”与“现在已完成”。

Chat 控制回复摘录：

> 关于“现在下载了多少文件？”：我这边还没有收到任何文件数进度更新，所以目前不能准确报告数量。

Chat 最终回复摘录：

> NOTE：任务已完成，请查看 xxx 数据。
> 现在任务结果已明确：本次合成下载已完成，共处理了 7 个 fixture 文件。

Responses 最终回复摘录：

> **之前**你问“现在下载了多少文件”时，任务还在进行中，**当时没有可用的进度数量**，所以无法确认。
> **现在**任务已完成，最终结果是：**共处理了 7 个 fixture 文件**。
> 另外，按你的 NOTE：**记得查看 xxx 数据。**

控制请求没有暴露业务工具，未产生第二次执行。这证明当前受限请求形态可获得合适回复，不证明模型在暴露全部业务工具时也能自主避免重复执行。

## Hypothesis assessment

完整 Spike 仍为 Inconclusive，不能标记全矩阵 Provisional Pass。最小 smoke 与随后既有客户端实验支持方案 A 的必要条件：当前 Relay 的 `gpt-5.4` 在两个协议上接受这种控制/最终投影，连续两次 steering 期间工具保持 pending，之后能保留提醒并消费真实结果。本地测试支持独立协作取消和结果闸门；这些证据足以继续讨论 D1 设计，但不能将其提升为生产设计已接受。

SiliconFlow 对照支持本轮机制目标：工具仍 pending 时可取得两次控制回复，工具完成后可用真实配对结果续调；未发现该路径的协议阻塞。错误最终回答是业务语义观察，不是该机制的反例，不作为 D1 结构设计阻塞项。官方 Anthropic 的严格合规仍未实测；跨模型回答质量亦未得到保证。

直接追加对照不是方案 A：它在 Relay 两协议上被拒绝，在 SiliconFlow Messages 上成功。前述“没有协议阻塞”仅指已闭合/隐藏 pending 调用的方案 A 投影，不能扩展成任意未配对历史也被接受。

## Limitations

真实 Provider 接受和模型时序理解不能由离线测试证明，需分别查看 AP-10/AP-11 实网观察。Anthropic 官方直连、OpenAI 官方直连、生产持久化/compaction、任意不合作扩展的强制终止不在当前实验可证明范围。

原型仅保存调用组，不是生产完整 assistant 输出存储；控制动作在实网阶段固定 keep，没有开放业务工具。它不实现 admission/budget、真实新路线调度、恢复验证、完整 Root Abort 生命周期或并发 steering 的归属验证。执行状态无进度数据，不能据此报告下载数量。Node 22 仍未验证。

## Decision impact

本结果将供 [统一 Async Tool Use 草稿](../../../research/async-tool-use-design-draft.md) D1 决策，不授权生产实现。

项目所有者确认已取得可行方案并要求继续。正式方向现由 [Proposed Plan](plan.md)、[Accepted Specification](specification.md) 和 [Accepted ADR-018](../../../decisions/adr-018-unified-async-tool-execution-and-completion-delivery.md) 承接：统一 accepted receipt、Async Tool Execution Framework、trusted Host completion 与自动 Model continuation。Provisional Pass 保留 Spike 证据状态；不授权 Plan/Delivery 或生产实现。

## Follow-up

停止新增实网请求：此前 Relay 12 次、SiliconFlow DeepSeek 9 次、GLM 8 次、直接追加对照 8 次、Relay 单变量对照 4 次及 host-notification 证明 6 次均已结束。依据已验证的机制证据继续收敛 D1，不为修正模型回答偏离当前任务。回答质量与内部标记回显均为单列观察项。报数/提醒检查及证据中的 semanticReview 仅属额外质量检查，不作为本轮机制验收判据。未覆盖矩阵特别是可信通知持久化/恢复、compaction 与自动续调仲裁不得隐式划为已通过；新增实网请求需重新确认预算和可用凭据。

Process authority: [Development Workflow](../../../governance/development-workflow.md).
