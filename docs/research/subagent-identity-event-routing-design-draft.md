# Subagent Structured Tool Execution 隔离设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不修改当前 Subagent 稳定契约
> Scope: Parent context isolation、foreground structured concurrency、execution observability、可选交互、身份、事件路由与 terminal result 边界
> Concurrency update: 已完成并归档的 [Unified Async Tool Execution Framework](../changes/archive/async-tool-use/plan.md) 选择同一 Assistant response 的 Tool Calls 由通用 Framework 并发执行。因此 `task` 保持一次调用一个 Child；多个独立 Child 由多个同批 `task` calls 表达。本草稿中的单次 `task` 多 Child/batch 聚合候选不再进入当前方案，隔离、身份、路由、深度、事件与清理部分仍作为专有输入。
> Input: [Agent Session 管理对比调研](agent-session-management-comparison.md)、[新 Session 模型设计草稿](session-model-design-draft.md)
> Follow-up: 2026-09-30 通用异步执行与监督方向已转入 [Turn 内统一异步 Tool Use 草稿](async-tool-use-design-draft.md)。本文保留 Subagent 专项分析及先前方案，不再单独推进一套 Subagent-only 异步机制。

## 0. 与统一 Async Tool Use 草稿的关系

最新讨论将执行管理单位收敛为一次 Tool Use，适用于 builtin、Extension、命令与 Subagent；不保留 sync/async 两套路径。独立取消、活动计时、期限和 steering 控制流程的后续设计由新草稿承载。

本文仍有价值：context firewall、Child identity/route、transient Transcript、并行资格、有界汇总、Usage 和清理问题是 Subagent 专有设计输入，不应因提取通用能力而删除。它们仍是非权威候选，不等于已批准的交付范围。

下文按先前 Subagent 专项方案保留供追溯。第 5、10、11、12 节及第 16、17 节相关条目中的异步控制、活动/超时、启动闭合和结果交付提案，不再作为一套并行的最新契约维护：

- 最新监督粒度是整个 Tool Use；同次调用内任意 Child 的活动刷新同一个 lastActiveAt，Parent 无需按 Child 做超时判断。
- delta 只作为活动信号，不将 Child 消息内容写入 Parent 历史；不以模型分析原始输出作为监督前提。
- Tool 只能提供无活动期限建议，总执行期限由宿主控制。
- 调用级取消涵盖该 task 的整个 Child scope；暂不要求单 Child 取消。
- 本文“先返回启动 accepted”的流程及“只增加一个 Tool Call 和一个 terminal Result”的验收表述，不代表消息协议已确定；闭合、steering 和延后结果必须在新草稿中统一决策。
- 本文仅支持 same-process 的候选限制，不能被解释为能够强制停止任意不响应取消的扩展。执行隔离和取消不收敛仍是新草稿的实施前决策项。

若未来正式迁移或拆分本文，先确认独有内容和入站引用，再清理被替代段落；本轮不删除研究来源，也不修改稳定 Subagent 契约。

## 1. 核心定位

对 Parent Agent 而言，Subagent 不是另一个对等 Agent 或 Conversation，而是由 Tool启动、由当前Parent Turn监督的异步执行作用域。该scope可以只运行一个Child，也可以在满足并行条件时启动多个相互隔离的Child：

```text
Parent model
  -> task tool call
       -> accept one or more isolated Child executions
  -> Parent Turn supervises active scope
       -> Child terminal wakes Parent
       -> Parent steering wakes Parent
       -> optional Child interaction bypasses Parent
  -> all Children terminal or cancelled
  -> Parent receives bounded aggregate result
  -> Parent Turn may complete
```

Subagent 的首要价值是建立上下文隔离边界。Child 可以读取大量文件、执行搜索、调用多个 Tool、运行测试、恢复错误或继续委派，但这些中间过程不得自动进入 Parent Model Context。

本草稿采用以下核心不变量：

> Child内部步骤、并发数量和执行体积不得线性暴露到Parent Model Context。Parent只接收启动关联、精简执行状态和有界terminal result；Child Transcript与中间事件始终留在隔离边界内。

这里的foreground是Turn ownership，不是同步调用栈阻塞：

- Tool仍然表达Parent Model的委派意图，但active scope由Parent Turn监督。
- Scope内部可以串行或并行调度 Child。
- Parent等待时可以被发给Parent的steering消息唤醒。
- Parent可回复用户并保留Child，也可以取消Child后改变当前Turn方向。
- Parent Turn完成前必须收敛所有已接受Child。
- 不允许 Child脱离 scope继续运行。

Runtime必须持续维护并向Root UI投影Child执行状态，使长时间等待可观察，并确保活跃Child不会因为Parent没有文本输出而被误判为挂起或失败。

## 2. 设计边界

当前实现基线：

- 每次 `task` 调用只启动一个 same-process、单 Turn Child。
- Parent `task` Tool 在 Child terminal 前保持 pending。
- Child 不继承 Parent conversation history。
- Child 继续复用 `AgentRunner`，使用独立的 transient Transcript。
- Child 继承 Parent Abort signal 和 Registry generation。
- 不把 Child 提升为可列举或可导航的普通 Session。

第一期候选目标允许一个Parent Tool invocation在同一个foreground structured scope内启动多个单Turn Child。Child异步运行；Parent Turn可以被新的Parent steering唤醒，但在所有已接受Child达到终态或被取消前不能完成。这不等于background或detached execution，Child不能跨越Parent Turn。

第一期同时要求：

- Root UI可看到scope和每个Child的结构化执行阶段、持续时间和最后活动时间。
- Child activity由Runtime事实驱动，不依赖Child自然语言自报进度。
- active Child使Parent request保持活跃，通用的“无Parent输出”检测不能将其判为停滞。
- terminal outcome自动交付并恢复Parent Runner，不依赖用户轮询。
- 用户消息继续进入Parent steering FIFO，不会被注入任何Child。
- Parent被steering唤醒后，根据消息与active scope摘要决定回复并继续等待，或取消整个active scope并转向。
- 不引入Child steering、Child follow-up或跨Turn execution handle。

为避免过度设计，第一期进一步收紧为：

- 只使用same-process async `AgentRunner`，不增加Process/Remote backend抽象。
- Scope只由当前Parent Turn拥有，不跨Turn，不持久化。
- 一个Parent Turn同一时间最多拥有一个active scope；该scope可以包含多个Child。
- Runtime只维护进程内active scope状态，不增加durable execution store。
- 使用collect-all和固定并发上限，不增加fail-fast、优先级或动态调度策略。
- Parent第一期只能取消整个active scope，不支持精确取消单个Child。
- Progress只投影粗粒度Runtime事实，不转发Child文本流或完整Transcript。
- Parent steering只唤醒Parent；不提供向Child发送消息的能力。

以下能力仍不属于候选目标：

- background 或 detached execution；
- resume、handoff、team 或 durable task queue；
- Child在Parent Turn结束后继续运行。

本草稿只记录候选设计。身份删除、公共事件变更、结果限制、交互协议和 Transcript 策略都需要正式 Change 接受后才能实施。

### 2.1 当前实现基线

当前路径全部已经实现：

```text
[已有] 用户消息进入Runtime per-Session FIFO
  -> [已有] Runtime启动Parent Turn并创建Root AbortController
  -> [已有] Parent AgentRunner调用Model
  -> [已有] Model产生`task` tool_use
  -> [已有] Runner顺序执行`task`
  -> [已有] task完成profile lookup与depth check
  -> [已有] Runtime验证active Parent并创建一个Child identity
  -> [已有] 创建transient Child Transcript与Child route
  -> [已有] SubagentExecutor prepare/resolve/execute
  -> [已有] 同一个AgentRunner执行Child Turn
  -> [已有] task等待Child terminal并返回最终Tool Result
  -> [已有] Parent Runner到达tool-round safe point
  -> [已有] Parent claim兼容steering前缀
  -> [已有] Parent继续或结束Turn
```

当前约束：

- 一个`task`调用只运行一个Child。
- `task.execute()`等待Child terminal。
- Parent只有在Child返回后才能claim steering。
- Root Abort与Child使用同一向下传播的signal。
- Child普通事件没有稳定的Root UI scope投影。

### 2.2 第一期复用、改造与新增

| 类别 | 能力 | 第一期处理 |
|---|---|---|
| 已有，直接复用 | per-Session FIFO、compatible-prefix claim、`user_message_bound` | 保持Parent steering入口不变 |
| 已有，直接复用 | `task` profile lookup、depth check、Parent correlation | 继续作为LLM-facing启动入口 |
| 已有，直接复用 | `SubagentExecutor` Prompt/Context/Tool policy组装 | 继续用于每个Child |
| 已有，直接复用 | Child Model Resolution、`AgentRunner.run()`、transient Transcript | 继续作为same-process执行内核 |
| 已有，直接复用 | AgentEvent fanout、Channel/WebSocket audience | 用作新状态投影的传输基础 |
| 需要改造 | `task`等待完整Child lifecycle | 启动被接受后让Runtime监督active scope；合法消息编码待定 |
| 需要改造 | 单一Root/Child Abort signal | 增加scope cancellation，Root Abort仍向下级联 |
| 需要改造 | Child route和terminal cleanup顺序 | route先于start，terminal delivery settle后cleanup |
| 需要改造 | Runner只在普通tool round后claim steering | active scope等待可被Parent steering唤醒 |
| 新增 | Runtime-owned active scope record | 只存当前Turn内一个scope及其Child状态 |
| 新增 | bounded sibling concurrency与collect-all汇合 | 多Child并行且结果按输入顺序聚合 |
| 新增 | coarse progress snapshot与稳定presentation identity | Root UI原地更新同一Task Card |
| 新增 | active Child阻止Parent Turn完成 | `end_turn`在scope active时只是terminal candidate |

### 2.3 第一期in-turn总流程

图例：

- `[已有]`：当前实现直接复用。
- `[改造]`：当前能力保留但改变边界或时序。
- `[新增]`：第一期新增的Subagent监督能力。

```text
[已有] 用户消息进入Runtime
  -> [已有] 启动Parent Turn / Parent AgentRunner
  -> [已有] Parent Model产生`task` tool_use
  -> [已有] task校验profile、depth与Parent correlation
  -> [新增] Runtime创建当前Turn唯一active Subagent Scope
  -> [新增] Scope接受一个或多个Child
  -> [已有] 每个Child独立prepare、resolve Model并创建transient Transcript
  -> [改造] Child通过same-process AgentRunner异步执行
  -> [新增] 固定并发上限调度，Sibling执行collect-all
  -> [改造] 启动Tool合法闭合并关联Scope；具体Provider消息编码待定
  -> [新增] Parent进入可被事件唤醒的scope监督等待
       ├─ Child状态变化 -> [新增] 更新Snapshot与Root UI Task Card
       ├─ Child交互请求 -> [已有+改造] 沿Child route直接请求用户
       ├─ Parent steering到达 -> 进入2.5节
       ├─ Root Abort -> [改造] 取消Scope及全部Child
       └─ 全部Child terminal -> [新增] 有界聚合结果
  -> [新增] 聚合结果合法进入Parent Context；具体Provider消息编码待定
  -> [已有] Parent Model继续并完成Turn
  -> [改造] terminal delivery settle后清理route、Transcript与active Scope
```

### 2.4 无steering的正常完成流程

```text
Parent创建Scope
  -> Child A/B/...在同一进程异步执行
  -> Runtime持续更新UI Snapshot，不写Root Transcript
  -> 每个Child选择一次terminal outcome
  -> 所有Child terminal
  -> Scope按输入顺序构造有界aggregate result
  -> Parent恢复并消费aggregate result
  -> Parent完成当前Turn
  -> Runtime清理Scope与transient资源
```

### 2.5 Parent steering到达流程

```text
Child仍在运行
  -> [已有] 新用户消息进入Parent Session FIFO
  -> [新增] active scope监督等待被唤醒
  -> [已有+改造] Parent在合法safe point claim消息
  -> [新增] Runtime向本次Parent Model调用提供compact active-scope snapshot
  -> Parent Model判断
       ├─ 消息不改变方向
       │    -> Parent回复用户
       │    -> Child不接收该消息并继续运行
       │    -> Parent重新进入scope监督等待
       └─ 消息改变方向
            -> Parent显式请求取消整个active Scope
            -> [新增] Scope Abort取消全部未terminal Child
            -> 等待Child收敛并保留已完成结果
            -> Parent在同一Turn进入新流程
```

第一期不允许Runtime根据用户文本自行选择分支；判断责任属于Parent Model。

### 2.6 用户可观测流程

```text
[新增] Scope accepted
  -> Root Chat创建一个稳定Task Card
  -> Child状态变化只更新Card内部Snapshot
  -> 用户可看到任务标签、Child计数、阶段、Tool名称、耗时和terminal状态
  -> 不追加progress Chat消息
  -> 不展示Child text delta、推理、原始Tool输入输出或Transcript
  -> Scope terminal后原地更新同一Card为completed/failed/aborted
```

页面重连时：

- active scope从Runtime内存Snapshot恢复Card；
- terminal scope从有界Root presentation恢复结果；
- 不重放Child完整事件流。

## 3. 三个观察面

Subagent 信息必须按观察面分离，不能因为 UI 或 telemetry 需要可观察性，就自动污染 Parent Model Context。

| 信息 | Parent Model Context | Root UI | Internal telemetry |
|---|---:|---:|---:|
| Parent `task` Tool Call | 是 | 是 | 是 |
| Child bounded terminal result | 是 | 是 | 是 |
| Scope/Child execution state | 否 | 是 | 是 |
| Child liveness/elapsed time | 否 | 是 | 是 |
| Parent steering message | 是 | 是 | 是 |
| Child interaction request | 否 | 是 | 是 |
| Child interaction response | 否 | 必要状态 | 是 |
| Child `text_delta` | 否 | 默认否 | 可选 |
| Child internal `tool_use/result` | 否 | 默认否 | 是 |
| Child `run_start/end` | 否 | 默认否 | 是 |
| Child Transcript | 否 | 默认否 | 可查 |
| Child Usage | 否 | 可选 | 是 |
| Child diagnostics/artifacts | 只传引用 | 可查看 | 是 |

未来即使 UI 提供可展开的 Child execution detail，也不得将 detail 自动 replay 或序列化进 Parent Model Context。

## 4. Context firewall

### 4.1 不穿过隔离边界的内容

以下内容只属于 Child execution：

- Child system prompt、messages 和 Transcript；
- Child 的文件读取、搜索结果和命令输出；
- Child internal Tool Call、Tool Result 和 repair/compaction 事件；
- Child 与 Grandchild 的中间输出；
- Child interaction 的用户原始回答；
- 原始 Usage、内部 ID、诊断和 trace。

Child Transcript 不得：

- 合并进 Parent Transcript；
- 在 Root Session 恢复时注入 Parent conversation；
- 作为 Parent Tool Result 的附件全文展开；
- 因 UI 展示需要而成为 Parent Model message。

### 4.2 允许穿过隔离边界的内容

只有以下内容可以进入Parent Model Context：

1. Parent生成的Subagent Tool Call及其启动关联。
2. 用户发给Parent的steering message。
3. Runtime提供的精简active scope摘要。
4. Scope terminal后的一次有界aggregate result。

可选交互通过 Runtime 路由到用户并直接恢复 Child，不经过 Parent Model。

## 5. Parent-facing result delivery

当前实现等待Child结束后将其`text`直接作为原始Tool content返回。候选模型中启动Tool不能在Child整个生命周期内保持普通未完成Tool Call，否则Provider协议无法在Child运行期间重新调用Parent Model处理steering。因此需要把“启动被接受”和“terminal result交付”分开，同时保持两者与原始`parentToolUseId`的结构化关联。

具体Provider消息编码仍需正式设计。无论采用Runtime-owned execution result、显式collect/wait操作或其他合法消息结构，都必须满足：

- 每个assistant `tool_use`先获得合法闭合结果，再允许新的Parent user message进入Model。
- Child terminal result不会伪装成第二个同call ID的Tool Result。
- active Child阻止Parent Turn真正terminal，但不阻止Parent处理steering。
- 所有Child terminal后，aggregate result至多一次进入Parent Context。
- Transcript恢复可以重建active scope关联，或明确第一期不支持进程重启恢复。

候选 LLM-visible 结构：

```ts
interface SubagentToolResult {
  status: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
  summary: string;
  findings?: string[];
  changedFiles?: string[];
  validation?: string[];
  unresolved?: string[];
  artifactReferences?: string[];
}
```

并行 scope的候选 LLM-visible 结构：

```ts
interface ParallelSubagentToolResult {
  status: 'ok' | 'partial' | 'error' | 'aborted';
  results: Array<{
    index: number;
    status: SubagentToolResult['status'];
    summary: string;
    unresolved?: string[];
    artifactReferences?: string[];
  }>;
  aggregateSummary?: string;
}
```

要求：

- 结果有明确大小预算。
- 并行结果按输入顺序返回，不按完成顺序返回。
- 每个 Child结果和整个聚合结果都受大小预算约束。
- 不包含 Child Transcript 或完整执行日志。
- 不复制大段源代码或测试输出。
- 只保留 Parent 下一步决策所需的事实。
- 超出预算的证据保存为 artifact，并只返回引用。
- 截断或归档必须显式呈现，不能静默丢失结果。

Usage 和执行身份通过非 LLM-visible metadata 传播：

```ts
interface SubagentExecutionMetadata {
  childTurnId: string;
  profile: string;
  depth: number;
  usage: TokenUsage;
  diagnostics?: DiagnosticReference[];
  artifacts?: ArtifactReference[];
}
```

具体 result schema、大小预算和 artifact 能力仍待正式设计决定。

## 6. 可选交互

交互属于 Child Tool execution，不属于 Parent conversation：

```text
Child Tool
  -> Runtime interaction gate
  -> Root Session audience
  -> user response
  -> Runtime interaction gate
  -> Child Tool resumes
```

交互期间：

- Parent Turn继续拥有active scope。
- Child interaction不会唤醒Parent Model。
- 用户回答不写成 Parent user message。
- 用户回答只进入 Child interaction/Transcript。
- Child terminal 后，Parent 只收到最终 Tool Result。
- 如果交互事实对 Parent 后续决策必要，Child 在 final summary 中压缩表达。

同一并行 scope内可以有多个 Child等待交互。每个交互必须携带独立的 Child和 Tool Call身份；一个 Child的响应不得恢复另一个 Child。未决交互的并发上限和 UI 排队策略需要在正式设计中明确。

候选交互路由身份：

```ts
interface SubagentInteractionIdentity {
  rootSessionId: string;
  parentTurnId: string;
  parentToolUseId: string;
  childTurnId: string;
  childToolUseId: string;
}
```

Runtime 使用结构化字段路由，不从复合 Session 字符串或展示名称推断 Parent。

## 7. 执行身份

当前一次单 Child delegation中，`runId`、Child `turnId` 和 transient Child `sessionId` 基本保持一对一。

在继续维持 scope内单 Turn Child的前提下，最小候选身份是：

```ts
interface SubagentExecutionIdentity {
  requestId: string;
  rootSessionId: string;
  childSessionId: string;
  childTurnId: string;
  parentTurnId: string;
  parentToolUseId: string;
  batchIndex?: number;
  depth: number;
  subagentType: string;
}
```

- `parentToolUseId` 是 Parent-visible delegation identity。
- 一个并行 Tool Call内，`parentToolUseId` 同时标识 structured execution scope。
- `childTurnId` 是单次 Child Runner execution identity。
- `childSessionId` 只标识 transient Transcript 容器。
- `batchIndex` 在并行 scope内提供稳定的输入和结果顺序。
- `rootSessionId` 只用于 interaction audience 和 ownership，不表示 Child 是普通 Root Session。
- 当前没有独立 `executionId` 的必要。
- 可以评估删除与 Child `turnId` 一对一的 `runId`。

如果未来接受 background、resume 或一个 execution 多 Turn，则必须新增稳定 `executionId`，不能继续以 `childTurnId` 代表整个 execution。

## 8. Structured concurrency 与并行汇合

候选语义是：一个由Parent Tool Call创建、由当前Parent Turn监督的执行作用域可以派发多个符合条件的Child execution；Parent可以在Child运行期间处理steering，但Turn只有在所有已接受Child达到终态或被取消后才能完成。

本草稿只描述行为，不预设具体方法名、调用语法、Tool schema或Runner接口。

### 8.1 Scope ownership

- 一个Parent Tool Call创建一个structured execution scope。
- 当前Parent Turn拥有并监督该scope的完整生命周期。
- Scope拥有零到多个已接受 Child。
- 每个 Child拥有独立 Turn、Transcript、Model resolution和 terminal outcome。
- 所有 Child共享 Parent Abort ancestry和捕获的 Registry generation。
- Parent Turn只有在全部已接受Child terminal或cancelled后才能完成。
- Parent Turn完成后不得存在orphan或detached Child。

### 8.2 Join与结果顺序

默认候选语义是 collect-all：

- 一个 Child失败不自动取消无关 sibling。
- Setup、Resolution、execution failure都成为该 index的 terminal result。
- Parent Abort取消全部未 terminal Child并等待它们收敛。
- 聚合结果始终按输入 index排序，与实际完成顺序无关。
- 是否增加显式 fail-fast模式延后决定。

### 8.3 并行资格

并行不是所有 Child的默认安全行为。至少需要同时满足：

- 子任务之间没有数据依赖。
- Runtime admission允许新的并发 Model执行。
- 并发数量不超过明确上限。
- Child不对同一共享资源执行无法协调的冲突写入。

第一阶段的安全候选是只并行：

- 只读/调研型 Child；或
- 在相互隔离 workspace中执行的 Child。

共享可写 workspace下的并行 coding Child需要额外的冲突、合并和失败恢复契约。在该契约被接受前，应串行执行或拒绝并行，而不是依赖 prompt约定。

### 8.4 Context isolation

并发不会改变 context firewall：

- Sibling之间默认看不到彼此 Transcript或中间结果。
- Parent看不到任一 Child的中间事件。
- 每个 Child只产生一个 bounded terminal result。
- Scope再将多个 Child结果组合成一个有界聚合 Tool Result。
- 聚合不能简单拼接所有原始 Child输出而绕过总大小预算。

## 9. 事件与路由

### 9.1 用户 Channel

用户 Channel只接收：

- Parent `task` Tool 状态；
- Runtime投影的scope/Child执行状态；
- Child interaction request 和必要响应状态；
- Parent-facing terminal Tool Result。

Child Runner 的普通事件默认不得进入用户 Channel。Runtime可以将生命周期和操作边界投影为低频、结构化状态，但不得转发Child `text_delta`、原始Tool输入输出或推理内容。`subagent_start/end` 可以保留为内部 lifecycle/telemetry，也可以映射为 Parent Tool 状态，但不应成为Root Chat中的独立Agent message。

### 9.2 内部 telemetry

Child 的完整 Runner 事件可以进入内部 telemetry sink，但必须携带结构化 Child identity。Telemetry visibility 不得隐式授予用户 Channel visibility。

### 9.3 Fail-closed

任何携带 Child `turnId` 的事件，如果无法找到明确 execution/telemetry route：

- 记录结构化诊断；
- 丢弃或按明确 late-event policy 处理；
- 不得回退到当前全部 Channel bindings；
- 不得猜测 root audience。

## 10. Parent steering while Children run

普通用户消息始终面向Parent，不面向Child：

```text
User
  -> Parent steering FIFO
  -> wake Parent supervision
  -> Parent Model receives:
       - user message
       - compact active scope snapshot
  -> Parent decides:
       - reply and keep Children running
       - cancel the active scope and redirect
       - continue waiting
```

Runtime不得根据消息文本自行判断用户意图，也不得自动把Parent steering复制到Child Transcript。

### 10.1 简单回复并继续等待

当消息不改变当前调研方向时，Parent可以直接回复用户并保留所有active Child。回复后：

- active scope继续由当前Parent Turn拥有；
- Child不接收该用户消息；
- Parent回复不会把Child标记为terminal；
- 如果仍有active Child，`end_turn`只能作为terminal candidate，不能完成Turn；
- Runtime重新进入等待，直到Child terminal、下一条Parent steering或Root Abort。

### 10.2 取消并转向

当消息改变当前方向时，由Parent显式请求取消整个active scope。Runtime负责：

- 使用独立于Root Turn的Child/scope cancellation；
- 等待被取消Child收敛为terminal outcome；
- 保留已经完成Child的结果；
- 更新active scope摘要；
- 允许Parent在同一Turn继续新的方向。

Root Turn Abort仍然取消整个execution tree和未claim消息；它不同于Parent决定取消active scope后继续当前Turn。

### 10.3 Claim与竞态

- Parent steering仍遵循Session FIFO和at-most-once claim。
- Child terminal与steering同时可见时，Runtime必须定义稳定线性化顺序。
- 已terminal Child不能被重新取消；其结果仍可由Parent决定使用或忽略。
- 已被Parent claim的消息不能因scope取消而丢弃或重新入队。
- Parent一次Model调用观察到的active scope摘要必须对应同一个确定快照。
- Steering唤醒本身不创建新的Root Turn；它继续当前active Parent Turn。

## 11. Foreground可观察性与长任务可靠性

### 11.1 Runtime状态模型

Runtime是Child execution state、liveness和terminal outcome的事实来源。候选状态：

```ts
type ChildExecutionState =
  | 'queued'
  | 'starting'
  | 'waiting_model'
  | 'running_tool'
  | 'waiting_interaction'
  | 'retrying'
  | 'finishing'
  | 'completed'
  | 'failed'
  | 'aborted';
```

每个active Child至少维护：

```ts
interface ChildExecutionSnapshot {
  childTurnId: string;
  batchIndex: number;
  state: ChildExecutionState;
  startedAt: number;
  updatedAt: number;
  activeOperationStartedAt?: number;
  llmCalls: number;
  activeToolName?: string;
}
```

Scope还维护：

- accepted/running/terminal Child计数；
- scope started time和最后活动时间；
- foreground Parent Turn identity；
- collect-all与Abort状态；
- 是否已选择并交付aggregate terminal result。

### 11.2 用户可见投影

Root UI显示低频结构化状态，例如：

```text
Subagent scope · 3 children · 1 completed
Child 1 · completed
Child 2 · waiting for model · 1m 12s
Child 3 · running tests · 38s
```

允许展示：

- Profile/任务短标签；
- 当前Runtime阶段；
- LLM call序号；
- 当前Tool名称；
- 当前阶段和总执行持续时间；
- 最后可观察活动时间；
- terminal outcome和简短失败类别。

不得展示：

- Chain-of-thought或内部推理；
- Child raw `text_delta`；
- 未清洗的Tool参数、输出或敏感数据；
- 伪造的完成百分比；
- 为了“看起来活跃”而生成的模型文本。

UI可根据时间自行更新elapsed display，Runtime不需要高频发送重复heartbeat事件。状态变化、操作边界和低频liveness信号必须与业务事件分开。

### 11.3 活跃等待与超时

foreground Parent没有文本输出并不表示执行停滞。只要scope中存在已接受且未terminal的Child，Runtime就必须把Parent request视为active。

要求：

- 通用Parent inactivity timeout不得仅因没有Parent `text_delta`而终止active scope。
- Model invocation、Tool execution和用户交互可以拥有各自明确的operation timeout。
- Operation timeout必须产生结构化failure并进入正常terminal收敛，不能让Tool Promise永久悬挂。
- 不响应Abort的同步CPU循环或第三方调用仍是same-process模型的已知限制，不能由heartbeat掩盖。
- Progress fanout失败只记录诊断，不改变Child outcome。
- Channel断开或页面重载不取消scope；重新连接后可以从Runtime active snapshot恢复当前状态。
- 用户取消foreground request时，Abort必须传播到所有未terminal Child并等待收敛。

UI可以在长时间没有可观察活动时提示“可能停滞”，但不得仅凭阈值自动宣告Child失败。提示必须同时显示当前已知operation和持续时间。

### 11.4 Terminal交付

Child和scope terminal不得依赖用户查询：

```text
each Child terminal
-> record immutable Child result
-> update scope counters
-> all accepted Children terminal
-> build bounded aggregate result
-> settle terminal fanout
-> resolve Parent Tool Call
-> Parent Runner continues
```

Terminal状态必须幂等且至多交付一次。Route、active snapshot和transient Transcript只能在必要terminal delivery settle后清理。

## 12. 生命周期顺序

候选 acceptance 和 cleanup 顺序：

```text
validate active Parent
-> allocate execution scope
-> admit and allocate Child identities
-> register tree memberships and interaction routes
-> register Children as active delegation Parents when depth allows
-> create transient Transcripts
-> accept Child executions
-> close the launching Tool Call with an accepted scope association
-> emit internal lifecycle events and Root UI state projection
-> prepare / resolve / execute Children, serially or concurrently
-> update Runtime snapshots at Model/Tool/interaction boundaries
-> wait for Child terminal, Parent steering, Child interaction, or Root Abort
-> wake Parent for steering without injecting the message into Children
-> preserve or cancel Children according to explicit Parent action
-> select one terminal result per Child
-> join all accepted Children
-> build one bounded aggregate Tool Result
-> settle terminal telemetry and Parent Tool Result
-> remove active Parent registrations and interaction routes
-> delete transient Transcripts
-> release tree memberships and scope
```

要求：

- 每个 `subagent_start` 之前，对应 Child所需 route必须可见。
- Launching Tool Call必须合法闭合后，Parent才能收到新的steering message。
- Setup/Resolution failure 也只产生一个 terminal result。
- Terminal fanout 必须可等待，不能在异步 delivery 完成前删除 route。
- Cleanup failure只记录诊断，不改变已选择的 terminal outcome。
- Parent Abort 必须到达 Child 和所有 descendants。
- Scope必须等待全部已接受 Child的terminal和必要cleanup，不能在第一个结果返回时遗留 sibling。

## 13. 嵌套 delegation

嵌套不改变模型：

```text
Root Agent
  -> task Tool Call A
       -> Child Agent
            -> task Tool Call B
                 -> Grandchild Agent
```

对 Child 而言，Grandchild仍只是一个 structured Tool execution scope。它可以包含一个 Grandchild，也可以在满足条件时并行多个 Grandchild。Grandchild 的执行细节压缩为 Child 的一个 bounded Tool Result；Child 再将整体结论压缩为 Root 的一个 bounded Tool Result。

因此 Root Context 大小应主要与直接 `task` 调用数相关，而不是与所有 descendant events 数量相关。

当 depth capability 不允许继续 delegation 时，`task` 必须从 Child 可见 Tool definitions 中移除。执行时的 depth check继续保留为防御，不能代替 schema-level capability。

## 14. Usage、诊断与 artifacts

这些信息不应通过 LLM-visible text 传播：

- Child 和 descendant Usage；
- terminal phase/failure diagnostics；
-完整日志、trace 和测试输出；
-可下载结果或大型证据。

如果接受 tree-inclusive Usage，`task` Tool canonical output需要承载非 LLM-visible metadata，由 Runner逐层累计。若不实现递归累计，则稳定契约必须明确 Usage 为 local-only，不能声明包含所有 descendants。

Artifact retention 独立于 Parent Context：

- Parent Tool Result只返回 artifact reference。
- Artifact内容不自动进入 Parent Transcript。
- Root deletion、权限、过期和 cleanup策略必须单独定义。

## 15. 当前实现与目标模型的主要差距

1. Child普通 Runner事件在 root generation lookup miss 后可能回退当前全部 Channel bindings。
2. `subagent_start` 先于 Child interaction route注册。
3. `onEvent` 类型为同步 `void`，实际异步 fanout无法被等待。
4. `subagent_end` 未纳入 terminal fanout tracking，cleanup可能早于 delivery settle。
5. 只有 Root Turn注册为 active Parent，配置上的 nested delegation不能完整工作。
6. Leaf Child仍可能看到 `task` schema，只在执行时被 depth check拒绝。
7. `SubagentTerminalResult.usage` 声称包含所有 descendants，但当前 Tool Result不会向上传递 Child usage metadata。
8. Child final `text` 直接成为 Parent Tool content，没有显式结果大小和结构约束。
9. `runId`、Child `turnId` 和 Child transient `sessionId` 在当前模型中存在一对一冗余。
10. 每个 `task` Tool Call只接受一个 Child，Runner同一响应中的 Tool Calls仍顺序执行，没有 structured parallel scope、join和ordered aggregate result。
11. 没有 Subagent group级 admission、并发上限、sibling cancellation或共享写冲突契约。
12. 没有面向Root UI的结构化scope/Child active snapshot和阶段投影。
13. 长时间foreground wait缺少“active Child保持Parent request活跃”、operation timeout、stalled hint和重连恢复的明确契约。
14. 当前`task.execute()`直到Child terminal才返回，Parent Runner无法在Child运行时claim steering。
15. 当前只有Root Turn Abort；缺少允许Parent取消Child/scope但继续同一Turn的独立cancellation domain。
16. 尚未定义启动Tool闭合后terminal aggregate result如何合法、至多一次地重新进入Parent Context。

## 16. 延后决策

以下能力不属于第一阶段：

1. Background或detached execution；structured scope内的有界并行不属于background。
2. 一个 Subagent execution 包含多个 Turn。
3. Resume、retry-across-turns 或进程重启恢复。
4. Child Transcript作为可导航 Session。
5. 完整 Child execution detail 的 Root UI。
6. Shared tree-wide LLM-call/token budget broker。
7. Durable task queue、handoff 或 agent team。
8. 并行能力应由哪个协议层表达，以及对应的Tool schema和Runner接口。
9. Collect-all之外是否支持显式fail-fast。
10. 共享可写workspace下并行Child的隔离、合并和冲突恢复。
11. 用户或Parent向运行中Child发送steering/follow-up消息；Parent steering不属于本项。
12. 启动accepted、等待唤醒和terminal aggregate result的具体Provider消息编码。

一旦接受 background、resume 或多 Turn，必须重新设计稳定 execution identity、independent Abort、result delivery、membership snapshot 和 recovery。

## 17. 候选验收集合

仅当本草稿被提升为正式 Change 后，才使用以下验收项：

- 一个 scope执行任意数量内部 Child/Model/Tool步骤，Parent Transcript只增加一个 Subagent Tool Call和一个terminal Tool Result。
- 满足并行条件时，多个Child并发执行；Parent可以被steering唤醒，但aggregate result只在所有已接受Child达到终态后生成。
- foreground scope运行期间，Root UI持续显示每个Child的结构化状态和持续时间。
- 用户新消息只进入Parent Context，不进入任何Child Transcript。
- Parent可以回复用户并保持active Child继续运行；回复后Turn不会在Child仍active时完成。
- Parent可以显式取消整个active scope，并在同一Turn转向新的流程。
- Steering唤醒继续当前Parent Turn，不创建新的Root Turn。
- Root Abort与scope cancellation语义不同；前者终止整棵树，后者允许Parent继续。
- 并行结果按输入顺序返回，不受完成顺序影响。
- 一个 Child失败默认不取消无关 sibling；Parent Abort取消全部 sibling并等待收敛。
- Parent Turn完成后不存在仍运行的orphan Child。
- 不满足共享写安全条件的Child不会被并行调度。
- Child Transcript、internal Tool Results 和 interaction回答不会进入 Parent Model Context。
- 每个 Child结果和聚合结果都满足明确的结构和大小预算；大型证据只以artifact reference返回。
- Child interaction回答直接恢复Child，不成为Parent steering，也不启动新的Root Turn。
- Runtime阶段投影可以发送到Root UI；Child raw `text_delta`、推理和未清洗Tool内容不会发送到用户Channel。
- 活跃Child不会仅因Parent长时间没有文本输出而触发通用inactivity failure。
- Model/Tool operation timeout通过正常terminal结果收敛，不会让active scope永久悬挂。
- 页面重连后可以恢复active scope和Child状态快照。
- 所有Child terminal后，aggregate result自动交付并恢复Parent Runner，不需要用户查询。
- Progress fanout失败不会改变Child或scope outcome。
- 未知 Child `turnId` 不会广播到无关 Channel 或 Session。
- Route在 Child acceptance/start 前登记，在 terminal delivery settle 后清理。
- Setup、Resolution、执行错误、Abort 和 LLM-call limit都只产生一个 terminal result。
- 嵌套 Child逐层压缩结果；Grandchild事件不会进入 Root Context。
- Leaf Child看不到 `task` Tool definition。
- Usage通过非 LLM-visible metadata正确累计，或契约明确限定为 local-only。
- 当前单 Child、单 Turn行为仍是structured scope的合法特例。
