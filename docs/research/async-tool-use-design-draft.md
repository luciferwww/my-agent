# Turn 内统一异步 Tool Use 设计草稿

> Status: Non-authoritative design draft
> Date: 2026-09-30
> Authorization: 仅记录设计讨论，不授权实现，不覆盖 Accepted ADR、Stable Specifications 或当前实现
> Scope: 所有 Tool Use 的 Turn 内异步执行、活动观测、期限、独立取消、steering 与结果交付边界
> Related: [Subagent 专项设计来源](subagent-identity-event-routing-design-draft.md)、[Tool Result 状态与审批研究来源](tool-result-outcome-persistence-design-draft.md)
> Formalization: 已完成并归档的 [Plan](../changes/archive/async-tool-use/plan.md)、[implemented Specification](../changes/archive/async-tool-use/specification.md) 与 [Accepted ADR-018](../decisions/adr-018-unified-async-tool-execution-and-completion-delivery.md) 已承接“统一 Async Tool Execution Framework 替换 Runner direct-await”方向；accepted + Host completion 是其 Provider/Model 交付机制，不是独立后台特例。本文件保留研究来源，不再作为实施权威

## 1. 问题与目标

无人值守任务可能因为一个长时间不返回的 Tool 调用持续等待。问题不限于 builtin exec，也包括 Extension、MCP、远端操作和 Subagent；某个内置工具有超时不意味着整个执行系统有统一保证。

目标是让 Tool 执行期间主 Agent 的控制流程持续保有控制权，可以检查活动、处理期限、接收 steering 和执行取消，而不是只有 Tool Promise 返回才能继续。这里的主 Agent 控制流程不是持续调用 LLM，也不是另外新增一个监督 Agent。

采用唯一一套受监督异步 Tool Use，不保留 sync/async 两种运行路径。短调用也走同一条路径，只是更快返回。异步表达控制流程与具体执行分离，不自动意味着多个 Tool 并发、后台常驻或 detached execution。

## 2. 已确认方向与仍待设计事项

### 2.1 本轮讨论已确认的方向

- 面向所有 Tool Use，而不是从 Subagent 或 exec/process 单独扩展一套机制。
- 执行由所属 Turn 拥有，必须在 Turn 生命周期内完成或处理取消收敛，不允许默默遗留执行。
- 一次 Tool Use 是统一监督、活动计时和取消的单位。
- 每次调用有独立的取消边界；取消调用不等于取消整个 Turn，Turn Abort 仍向下传播。
- 用 `lastActiveAt` 作粗粒度无活动判断，不依赖日志语义分析、逐阶段诊断或模型持续评估。
- Subagent delta 内容不注入 Parent 历史；只消费事件发生这一事实。
- 一次 task 内任意 Child 的活动刷新同一次 Tool Use；Parent 不需要知道哪个 Child 报告活动。
- 并行 Child 的成功、失败、取消和缺失由最终聚合结果明确表达，不能只返回成功部分。
- 总执行期限由宿主控制，Tool/Extension 不能覆盖、关闭、延长或通过活动重置它。
- steering 不自动取消执行：提醒、进度询问等兼容输入由 Parent 处理并保留 Tool；明确改变路线的输入由 Parent 请求取消该调用，收敛后继续同一 Turn。

这些方向不等于正式 Spec Accepted 或 Delivery approval。

### 2.2 历史候选与正式收敛

早期候选包含 Tool 顶层 `idleTimeoutMs`；该字段已被正式 Draft 否决。当前方向只保留 `context.reportActivity()`，期限使用 Host 固定常量：idle 5 分钟、total 1 小时、cancellation grace 10 秒，Tool/Extension/Model 均不可覆盖。

Tool Call 闭合、结果交付、quarantine、并发、slots 和期限均已转入正式 Draft；本文保留研究过程，不再作为 API 或实施权威。

## 3. 当前实现证据

| 环节 | 当前事实 | 证据 |
|---|---|---|
| Tool API | `execute` 已返回 Promise；没有统一活动回调或监督期限元数据。单纯添加 async 关键字不能解决问题 | [Tool types](../../src/core/tools/types.ts) |
| Runner | Tool Calls 顺序执行，等待工具后才推进既有 Tool round / steering safe point | [AgentRunner](../../src/core/runner/AgentRunner.ts)、[Runner Turn Flow](../specifications/runner-turn-flow.md) |
| Subagent | task 等一个 Child terminal；委派层直接传递 Parent signal，没有独立 Tool Use 取消域 | [task Tool](../../src/builtins/tools/task/task-tool.ts)、[委派层](../../src/runtime/subagent-orchestration.ts)、[Subagent](../specifications/subagent.md) |
| 活动事件 | Child 复用 Runner，并以自己的 Session/Turn identity 发出 text_delta；事件存在不等于进入 Parent Context | [AgentRunner](../../src/core/runner/AgentRunner.ts)、[SubagentExecutor](../../src/core/subagent/SubagentExecutor.ts) |
| 命令工具 | exec 有 foreground、yield、background；process 提供查询和 kill。这是局部能力，不是通用 Tool 执行契约 | [exec](../../src/builtins/tools/environment/process/exec-tool.ts)、[process](../../src/builtins/tools/environment/process/process-tool.ts) |
| Abort | 当前稳定契约不承诺固定墙钟时间内停止；底层工具响应决定收敛时间 | [Abort](../specifications/abort.md) |

本草稿提出的独立取消、Tool 执行期间 steering 和统一监督会改变现有 [Tools and Hooks](../specifications/tools-and-hooks.md)、Runner 和 Abort 契约。后续需正式 Change 和适用的 ADR/Spec 接受，不能仅凭 Research 修改生产代码。

## 4. 最小责任划分

| 层 | 职责 |
|---|---|
| 宿主执行策略 | 提供默认期限、校验工具建议、决定有效上限和取消收敛政策 |
| Runtime / Runner 协作的控制流程 | 登记调用、维护活动与期限、监听完成/steering/Abort、串行化控制决策、交付结果 |
| Tool 与适配层 | 执行业务操作、报告真实活动、响应取消、提供终态或清理失败事实 |
| 模型 | 在合法消息边界根据结果和用户意图决策，不承担计时器或持续轮询职责 |

沿用 Runtime 管 admission/queue/route，Runner 管 Turn/Tool/模型循环的当前边界；执行记录具体放在哪个 owner 尚需正式接口设计，不新增一个平行的执行权威。

执行关联至少能定位 Session、Turn 和原 Tool Call。优先复用已有身份，不因异步概念自动新增 executionId、attemptId 或 durable store。

## 5. Turn 内控制流程

```text
校验、授权并登记一次 Tool Use
  -> 启动具体执行
  -> 控制流程保持响应
       <- 真实活动：更新 lastActiveAt
       <- 完成：选择一次真实终态并准备交付
       <- 时间条件满足：触发期限处理
       <- steering：进入控制流程，按合法协议处理
       <- 单调用取消：取消该调用内部工作
       <- Turn Abort：取消该 Turn 拥有的执行
  -> 执行与必要清理收敛
  -> 结果/steering 驱动 Turn 后续流程
```

使用事件和定时条件，不忙轮询，不因每条 delta 调用模型。保持一个 Parent 模型决策流；异步不授权在同一 Parent 上并发开始多个模型调用。

“控制循环可随时检查 steering”不等于“未闭合 Tool Call 可以直接插入新模型消息”。接收、检查、claim、持久化与模型消费需分别定义，保留 FIFO、at-most-once claim、权限和 Model-call budget 约束。

Turn 正常结束前不得存在未处理的所属执行。若不能确认停止，不能将 Turn 宣称为已正常完成并无声丢弃执行记录；失败收敛方案见第 8、12 节。

### 5.1 Steering 不等于取消

判断标准是当前执行是否仍与用户的新意图兼容。语义判断由 Parent 模型负责，Runtime 不通过关键词猜测意图；控制流程负责及时接收消息、提供已知状态和执行明确的取消动作。

| 输入 | 行为 |
|---|---|
| “记得执行完提示我查看 xxx 数据” | 作为 Parent 后续要求记录，可回复确认，保留当前 Tool 执行 |
| “现在下载了多少文件了？” | 根据实际可用信息回答，保留当前 Tool 执行 |
| “文档已经说明 xxxx，不需要再调研了，继续下一步” | 请求取消不再需要的 Tool Use，收敛后在同一 Turn 继续 |
| “放弃这个方式，改用 xxxxx” | 请求取消当前路线对应的 Tool Use，收敛后执行新路线 |

补充条件若只影响后续步骤，不必取消当前执行；意图不明确且决定影响显著时由 Parent 澄清，不盲目取消。普通 steering 不自动注入 Child，不引入向运行中 Child 修改输入的能力。

进度回答只能基于已有事实。lastActiveAt 不能推导下载数量或完成百分比；工具未提供计数或查询能力时，应明确无法获知具体数量，不为回答进度而强制新增所有工具的细粒度进度接口。

### 5.2 取消、继续与竞态

```text
steering 到达并由 Parent 处理
  -> 与当前执行兼容：记录要求/回复，执行保持运行
  -> 明确替换当前执行：请求取消该 Tool Use
       -> 等待收敛并保留已完成结果
       -> Parent 在同一 Turn 继续新路线
```

回复用户不意味着 Turn 结束。处理 steering 期间，执行监督、期限检查和 Turn Abort 仍保持响应，不被 Parent 模型调用占住。

新路线中可能与旧执行冲突的操作不得在旧执行尚未停止时开始。取消未收敛时显式报告；不能把请求取消表述为已经停止，也不能假设既有副作用已回滚。

Parent 决策期间 Tool 可能已经完成。执行取消动作时须重新检查状态，保留已完成的真实结果，由 Parent 判断是否使用，不将其改写为 aborted。

## 6. 通用活动接口

### 6.1 时间由宿主记录

候选执行记录包含 `startedAt`、`lastActiveAt` 和必要的生命周期状态；时间戳不由扩展上传。开始执行时初始化两者；同一次执行中的活动只更新 lastActiveAt，不重置 startedAt。

初始化只读取一次宿主时钟：

```ts
const now = clock.now();
startedAt = now;
lastActiveAt = now;
```

Tool 可以从不调用 reportActivity。此时 lastActiveAt 保持 startedAt，无活动期限自然成为从执行开始计算的期限，与总执行期限中较早到达的一项触发处理；无需无进度工具特例。具体执行计时起点仍按 D2 决定。

超时比较使用宿主单调时钟；若 UI 需要日期时间，另提供展示用时间。时间和消息内容无需写入 Parent Model Context。

候选回调：

```ts
interface ToolActivityContext {
  reportActivity(): void;
}
```

这是拟扩展 ToolExecutionContext 的片段，不是另一个 Tool execute API。回调由宿主绑定到本次调用，不接受调用 ID、时间戳或消息正文。

reportActivity 能力只交给该次 Tool 执行及其内部适配/委派链。Parent 控制流程读取执行记录，不持有用于替该调用报告活动的接口。steering 接收和 Parent 回复因此自然不刷新该调用的活动时间，不另设 steering 特例。

### 6.2 活动接入

| 执行方 | 可用信号 |
|---|---|
| Subagent | 对应 Child 的 text delta、实际执行边界事件；未来已有契约支持的其他模型活动事件 |
| exec | 该执行的真实 stdout/stderr 数据 |
| MCP | 对应请求的 progress 通知 |
| Extension | 执行实际推进时调用绑定的 reportActivity |
| 无进度接口的 Tool | 不合成活动；lastActiveAt 保持启动时间，直到结束 |

不依赖尚未实现的 thinking 事件，也不要求提供原始推理内容。Tool 实现内的细节不同，但控制流程统一消费 reportActivity。

UI 重绘、查询状态返回“仍运行”、宿主定时心跳都不刷新活动时间。扩展可能错误或恶意报告活动，因此该指标不证明实际进展，也不能规避总执行期限。

完成或已进入取消处理的调用不因迟到活动恢复运行；回调关联必须在委派前建立，并随调用生命周期清理。高频活动只更新状态，不必逐条向 UI fanout。

### 6.3 多个 task 调用的 activity

```text
task A → Child A event → task A reportActivity
task B → Child B event → task B reportActivity
```

当前 `task` 一次调用只委派一个 Child。task 可把本次调用绑定的回调交给委派层；委派层将 Child 事件送回所属 task execution。不能要求 Parent 监听全局 Child 事件并按名称或时间猜测归属。

监督粒度是本次 Tool invocation，不是工具名。多个并发 task 调用各自持有 activity clock、AbortSignal 和 deadline，不能互相刷新。

## 7. 期限来源与语义

### 7.1 已否决的 Tool timeout hint

```ts
readonly idleTimeoutMs?: number;
```

该候选未被采用。Tool 定义不新增 idle/total/grace hint，也不通过 description 或 Provider-visible schema 隐式声明期限。

### 7.2 宿主策略

| 项目 | 候选来源与限制 |
|---|---|
| 无活动期限 | Host 固定 5 分钟；真实 activity 可刷新 |
| 单次 Tool Use 总执行期限 | Host 固定 1 小时；Tool 和 activity 不能关闭或延长 |
| Turn / 用户任务预算 | 若配置，属于外层预算，不等同于某个 Tool 的期限 |
| 取消收敛等待 | Host 固定 10 秒；不能因新活动延期 |

模型、Tool、Extension 和配置文件均不填写或覆盖这些 timeout。未来如需调优，必须通过新的已接受 Change。

本次生效期限在启动时解析固定。候选判断为：

```text
无活动：now - lastActiveAt >= effectiveIdleTimeout
总执行：now - startedAt >= effectiveExecutionTimeout
```

二者独立，任一达到都会进入定义好的处理流程。它们是工程策略，不是死锁诊断；合法但静默的任务可能误判，持续输出但无进展的任务可能逃过 idle 检查。

Tool 内部连接/HTTP/命令超时可以保留，用于尽早结束局部操作，但不替代或扩大宿主总期限。审批、before hook、执行启动、用户交互分别是否计入这两个计时器，及到期后自动取消还是先通知模型，仍是明确的待决行为。

## 8. 独立取消与收敛

候选取消关系：

```text
Turn cancellation
  -> Tool Use cancellation
       -> 本次操作及其内部工作
       -> task 的所有未结束 Child 与 descendants
```

每次 Tool Use 有独立取消域，Turn Abort 向下联动；取消 Tool Use 不反向取消 Parent 或无关调用。对于并行 task，第一期处理整个 scope，保留已完成 Child 的真实结果。

取消请求、确认停止和停止情况未知必须区分。真实完成与取消竞态只选择一次结果，不因晚到 Abort 覆盖已经完成的事实，遵守 [ADR-001](../decisions/adr-001-tool-result-closure-and-recovery.md)。

```text
请求取消
  -> 有限收敛等待
       -> 确认停止：交付对应结果
       -> 未收敛：显式失败/残留处置，不伪造已停止
```

“停止等待 Promise”不是执行已停止。执行方可以协作响应 signal，受控进程可采用其终止能力；任意同进程同步死循环会阻塞控制循环，远端调用也可能不响应取消。没有额外隔离或进程外监督，无法保证所有扩展有限时间内停止。

本草稿不预先引入通用 Process/Remote backend；是否需要隔离、何时拒绝不可取消能力、取消失败是否升级宿主终止，是进入实施前的决策项。强保证不能靠设置账本 terminal、释放 generation pin 或删除记录来伪造。

迟到结果不能重复写入或恢复 sealed outcome。取消后不得自动重放有副作用操作；进程终止不意味着文件/远端副作用回滚。

### 8.1 D4 取证：现有机制能保证什么

2026-09-30 只读源码核验及既有测试结果：

| 证据 | 可以确认的事实 | 不能推导的保证 |
|---|---|---|
| [ToolExecutionContext.signal](../../src/core/tools/types.ts) | 当前契约明确工具是否响应 signal 由实现决定 | 任意工具都能在有限时间内停止 |
| [Registry snapshot 构造](../../src/runtime/registry-builder.ts) | ResolvedTool 直接保留 `execute: tool.execute`；当前注册边界没有为每次执行提供 worker/process 隔离 | 为 Promise 增加超时即可强制终止 Extension |
| [web_fetch](../../src/builtins/tools/environment/web/web-fetch-tool.ts) | 请求使用工具自建 Controller 和计时器，不联动传入的 Tool signal | 加入上层 Tool Use Controller 后所有 builtin 会自动响应 |
| [runCommand](../../src/builtins/tools/environment/process/run-command.ts)、[killProcessTree](../../src/builtins/tools/environment/process/kill-process-tree.ts) | 命令可请求进程树终止/升级信号；completion 仍依赖实际 error/close。终止 helper 的返回值未在 runCommand 中用来生成独立的取消失败结果 | 调用 abort 就已证明整个执行树和所有远端副作用停止 |
| [Observer settlement](../../src/core/runner/hooks/runner.ts) | 可以借鉴本地 Controller、监听清理和有界逻辑结算 | Promise.race 本身可停止工具；observer 结算规则不能直接当作 Tool 的副作用隔离 |
| [Runtime shutdown](../../src/runtime/RuntimeApp.ts)、[RequestCompletionGate](../../src/runtime/request-completion-gate.ts) | 当前 shutdown 可以密封非收敛请求为失败、报告 residual，并保留仍被执行引用的 generation | 返回失败报告代表 worker 已停止，或可以立即释放资源后安全重试 |
| [RuntimeDeadlineBudget](../../src/runtime/runtime-deadline.ts) | 已有单调时钟、总 deadline 下阶段预算和可注入 driver | 现有 shutdown 数值就是新 Tool Use 的默认期限 |

已有测试 [nonresponsive Root](../../src/runtime/RuntimeApp.test.ts) 明确使用未返回的 Runner 替身，验证 shutdown 报告 `deadline-exhausted`、保留 pin、不停止受保护实例，随后人工释放 Promise；它证明“显式失败与保留资源”，不是强杀。

本轮执行上述 nonresponsive Root 测试及 [deadline tests](../../src/runtime/runtime-deadline.test.ts) 的默认配置、阶段总上限两个用例，3/3 通过。未编写新执行原型，未运行不合作扩展或真实进程强杀实验；不能把这些基线测试称为新 async 机制的验收。

### 8.2 D4 候选处置及推荐边界

需要区分三类执行：

1. **可协作执行**：每次 Tool Use 独立 signal，工具真正结束并释放所属工作后交付结果；Parent 可以继续。
2. **事件循环仍响应，但执行不协作**：计时器能结束等待，却不能证明操作停止；必须保留残留记录，不继续可能冲突的路线、不重放。
3. **同进程同步阻塞**：计时器、steering 检查、报告回调都可能无法运行；处理保证需要进程外控制，不能靠同一个 Runner 的循环解决。

设计选项及最终选择：

| 选项 | 能力与成本 |
|---|---|
| **Runtime quarantine（已选择）** | Abort grace 后仍不 settle 时持久化 outcome_unknown，把现有 execution entry 连同 Promise/slot/pin 转入 Runtime quarantine，并禁用对应 Tool registration；Turn 可结束但不声称实现停止。晚结果不能写状态或再次交付 |
| 为需要强保证的执行设置可回收边界 | 可借助 worker/进程的独立控制处理宿主事件循环阻塞；必须另外设计资源所有权、通信、终止确认与扩展兼容，远端副作用仍不保证撤销 |
| 用 Promise.race 标成 aborted 然后继续 | 不采用：没有终止执行，违背 Turn-owned 和副作用安全边界 |

项目所有者于 2026-10-01 选择 Runtime Quarantine。该选择允许“Turn registry 已空”而不是伪造“实现已停止”：Runtime 继续监督故障 Promise，晚回调不能写 Session、发布事件或再次交付，对应 Tool registration 停止新 admission。随后确认一次 LLM call 输出的 1–N 个 Tool Uses 默认并发但不建立额外 group 实体；每个执行独立接纳、占 slot、取消、quarantine 和交付，一个 execution 的 quarantine 不取消同次调用的其它独立 Tool。同步阻塞 event loop 或直接 Node/native/远端副作用仍无法由本机制强制终止。

失败原则是显式报告取消未收敛、持久化 outcome_unknown、保留现有 entry/slot/pin，并阻止同一故障 Tool registration 在当前 Host 继续 admission；这不是给仍运行的工具制造正常终态。Quarantine 继续占用固定八个全局 slots，因此无需第二个 quarantine 上限。

## 9. Tool Call 闭合与结果交付

这是尚未解决的跨 Provider 契约，不因采用 async 就自然成立。

- 同一个模型 Tool Call 不能收到两次终态 Tool Result。
- 不能在仍未合法闭合的调用后，直接插入不被 Provider 支持的 steering/模型消息。
- 内部异步执行不必等于立即对模型返回 accepted 或 runId；若选择先返回 accepted，必须定义后续真实结果的关联、投递、去重和恢复行为。
- 若选择保留待完成 Tool Call，则须证明如何处理 steering；不能把“消息排队成功”当作“父模型已处理消息”。
- 协议必须支持 Parent 在 Tool 仍运行时处理兼容 steering 并回复，同时保留执行；“所有 steering 都先取消 Tool 再调用模型”不满足第 5 节行为要求。
- Parent 回复用户不等于所属执行已完成，Turn terminal 必须受执行收敛约束。
- 活动通知、执行管理状态和最终 Tool Result 是不同表面；不把 running、cancelling 等强塞进结果四态。

`success | error | denied | aborted` 的实时/持久化一致性与 Inline Approval 已并入统一 Async Tool Execution Framework Change。accepted receipt 不是第五种终态；Provider 闭合与 Host completion wire 由同一 Change 一并评审，状态字段和 Approval UI 状态本身不进入 Provider wire。

### 9.1 D1 取证：控制流程响应不等于模型可续调

2026-09-30 独立只读调查核对源码、已有测试和官方协议文档，未执行原型或真实 Provider 请求：

- [Runner](../../src/core/runner/AgentRunner.ts) 当前先保存 assistant，再按顺序等全部 Tool，保存结果后才 claim steering。把单个 await 改为事件竞争只能恢复控制流程响应，不能自动产生合法的模型输入。
- [当前消息类型](../../src/core/model-invocation/types.ts)、[Session 类型](../../src/core/session/types.ts) 没有独立的执行通知或控制对话合并契约。[History 投影与尾部修复](../../src/core/runner/AgentRunner.ts) 依赖线性消息和相邻 Tool Use/Result；中间插入 steering/回复需要重新定义投影和恢复。
- [Runtime FIFO claim](../../src/runtime/RuntimeApp.ts) 取最大连续兼容前缀。现有 Runner 一次空 claim 会关闭该 Turn steering；运行中的临时空队列检查不能复用这个最终结束含义。
- [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) 要求结果紧随对应 Tool Use，不在其间插入其他消息；[多工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) 要求下一条 user 消息包含该 assistant 所有调用的结果，但不强制执行并发。
- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling) 描述了按 call_id 返回结果再续调的流程；本次材料不足以证明允许在未闭合调用之间插入 steering，不以未找到限制推断支持。Relay 也需验证其实际上游行为。
- 四个本地编码器仅编码已有消息，不负责异步执行配对和去重：[Anthropic](../../src/builtins/providers/builtin/AnthropicMessagesClient.ts)、[Chat Completions](../../src/builtins/providers/builtin/OpenAIChatCompletionsClient.ts)、[Responses](../../src/builtins/providers/builtin/OpenAIResponsesClient.ts)、[Relay](../../extensions/copilot-relay-provider/responses-client.ts)。mock 编码成功不能证明服务器接受该消息序列。

已有 [Runner 测试](../../src/core/runner/AgentRunner.test.ts) 中 interruptible task/wait 示例是首个 Tool 已返回 running 文本后续调模型，并非未闭合 Tool Call 期间的续调证据。不能把此类 mock 当作 D1 已解决。

另有紧耦合风险：ADR-001 要求不向 Provider 发送损坏配对，而当前 repair 失败有记录 warning 后继续的路径。新设计必须验证请求前的合法性闸门，不能将现有“继续执行”的测试当作协议正确性保证；本轮不修复该实现。

### 9.2 D1 候选协议比较

| 方案 | 保留的性质 | 代价与待证内容 |
|---|---|---|
| A. 原调用保留 pending，steering 使用独立控制投影 | 原 callId 最后仍对应一次真实执行结果；不把启动成功当执行成功 | 控制请求仅使用已闭合历史前缀、宿主状态与 steering，不携带 pending 调用组。需要明确控制记录、回复可见性、持久化/恢复/compaction 与主历史的合并，不能假装现有线性 Transcript 已支持 |
| B. 统一提交操作，后续有界 wait/collect | 使用普通模型 Tool Call/Result 配对；控制模型可以在提交闭合后继续 | 原调用的含义改为提交/接受，真实执行结果由新 collect callId 返回；必须区分提交与执行状态、Hook 和 UI，记录已接受但尚未交付的结果。wait 也必须可被 steering 打断，否则只是把卡住移到 wait |
| C. 提交接受后，通过宿主通知交付终态 | 模型无需轮询取终态 | 新增可信宿主通知来源、持久化/投影和去重协议，不能将工具输出伪装为用户指令；不能给原 callId 再回第二个结果 |

这些是候选方案，不是要同时保留的三条生产路径。A 的控制投影也不是另一个 Subagent 或第二套普通工具执行器，但确实增加一种模型上下文投影，必须计入设计成本。

推荐验证顺序（尚未接受）：若坚持原 Tool Use 对应完整真实执行结果，优先验证 A；若优先保持简单线性消息结构，则评审 B 是否值得改变调用含义；C 暂不优先。不能把 A 宣称为最少代码，也不能把 B 的 accepted 标记成实际操作已完成。不存在已证实的“所有语义不变且不改 history/repair”的零成本方案。

### 9.2.1 当前收敛方向：统一 accepted + HostTaskCompletion

项目所有者于 2026-09-30 要求选择统一机制，避免为 Chat、Responses、Messages 在 `runAttempt` 中引入协议分支。结合实测，当前设计方向将 B 的 accepted 提交与 C 的宿主完成通知组合为**一条统一核心路径**；不要求模型主动 collect：

```text
模型 Tool Call
→ 宿主 admission 成功并创建 executionId
→ 原 callId 返回 accepted，模型调用闭合
→ 宿主持有执行 Promise，等待 execution / steering / abort / deadline 事件
→ steering 可重复进入正常模型上下文，执行默认继续
→ 执行终态持久化
→ 追加可信 HostTaskCompletion 普通上下文通知
→ 宿主自动续调模型
→ 无 pending execution / undelivered completion 后 Turn 才可结束
```

统一边界：

- Core 只认识 `ExecutionAccepted`、`SteeringReceived`、`ExecutionTerminal`、`HostTaskCompletionDelivered` 等事实，不认识 Chat/Responses/Messages wire。
- Provider adapter 只编码 canonical messages。Messages 需要把紧随 tool_use 的 accepted tool_result 与首次 steering/completion text 合并为同一 user message；这是投影规则，不是 Runner 控制流分支。
- 原 callId 只收到一次 accepted result；最终 `success | failed | aborted` 属于 executionId，通过 HostTaskCompletion 交付，不能回写成原 callId 的第二个结果。
- accepted 只表示 admission/ownership 已建立，不表示实现已成功、已开始产生副作用或最终完成。
- HostTaskCompletion 是宿主可信来源，不是用户文本。即使 wire 以 user role 发送，持久化必须保留内部 origin/type，加载时不得把任意用户输入识别成宿主通知。
- 业务 UI 可以按 executionId 把 accepted、running 与终态显示为同一任务卡片；模型实际收到过的 accepted 历史不得原地改写为 success。

落点应是独立的 Turn execution coordinator / projection，而不是将事件竞争和各协议消息拼装继续堆入 `runAttempt`。当前 [Runner](../../src/core/runner/AgentRunner.ts) 在工具循环中直接 `await executeCanonicalToolCall`，随后立即生成最终 tool_result；正式设计需要将这一段替换为“submit accepted + coordinator 等待事件”，但 `callLLMStream` 和 Provider clients 不应拥有执行生命周期。

### 9.2.2 外部完整链路：Gemini CLI

只读调研固定在 Gemini CLI commit [`38700b4b38bf387dafded6c97c3f190d084b49e9`](https://github.com/google-gemini/gemini-cli/commit/38700b4b38bf387dafded6c97c3f190d084b49e9)，得到一条端到端源码链路，支持上述分层但不替代本项目实测：

1. `ExecutionHandle` 同时持有 PID 和最终 Promise；后台化解析当前 handle 为 `backgrounded:true`，但 execution 仍留在 active registry 等待真实完成。[lifecycle handle/background](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/core/src/services/executionLifecycleService.ts#L510-L551)
2. shell Tool Result 把“后台运行 + PID”转换成原 call ID 的 `functionResponse`，闭合模型 Tool Call 并触发父模型 continuation；真正完成不会再次回答原 call ID。[shell result](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/core/src/tools/shell.ts#L804-L820)、[function response](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/core/src/scheduler/tool-executor.ts#L480-L507)
3. 后台执行真正完成时，lifecycle 向 `InjectionService` 写入来源为 `background_completion` 的完成内容，然后发 UI/exit 事件并删除 active execution。[settlement](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/core/src/services/executionLifecycleService.ts#L409-L465)
4. 父侧将 `user_steering` 与 `background_completion` 放入同一个 pending queue。它们可搭下一批 tool continuation 进入模型；若无 continuation，主流 Idle、MCP ready、无待确认工具且 model steering 开启时，effect 自动 `submitQuery`，触发父模型普通 user turn。[queue](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/cli/src/ui/AppContainer.tsx#L1148-L1173)、[continuation](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/cli/src/ui/hooks/useGeminiStream.ts#L2149-L2195)、[idle trigger](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/cli/src/ui/AppContainer.tsx#L2323-L2350)
5. 最终进入模型的 completion 是普通 user content，不是第二个 function response；父模型调用继续走 `sendMessageStream` / MAIN role。[model message](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/core/src/core/geminiChat.ts#L511-L573)、[main call](https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/core/src/core/client.ts#L779-L821)

该外部实现证明的是“后台句柄先闭合原调用 + 完成时普通消息注入 + 条件满足后自动父模型调用”的真实生产模式。边界也必须保留：

- Gemini 的 idle 路径把 completion 作为新的普通 user turn；不能据此宣称它与本项目“同一 Turn 必须收敛”的语义完全相同。
- steering 入队不会 abort 当前模型 stream；最早在下一 continuation 或 Idle 时处理。
- 自动触发受 `modelSteering` 等 UI 条件控制，`silent` completion behavior 不注入。
- 其外部 agent lifecycle 测试从 `createExecution('remote_agent', ...)` 开始，不独立证明每个生产外部-agent adapter 的初始 Tool Result 形状；shell 链路则完整证明 PID 句柄闭合。

因此本项目借鉴其**分层与交付模式**，不照搬 UI effect、Turn 边界或 shell 专项行为。

### 9.3 所有候选都需要的控制规则

1. 一次 LLM call 产生的 1–N 个 Tool Uses 默认并发，但不建立额外 group lifecycle。每个调用独立接纳并在 accepted 持久化后启动，不 await 前一个 Promise。存在结果/副作用依赖时，System Prompt 要求 Model 只发 prerequisite，等待 HostTaskCompletion 后在后续 LLM call 调用 dependent Tool。Framework 不猜测隐藏依赖。
2. steering 检查、claim、持久化和模型消费分开；保留 FIFO、连续兼容前缀、at-most-once、Abort 与模型预算约束。已 claim 输入不能仅存易失缓冲；临时无消息不关闭未来 steering。
3. cancel 是宿主控制动作，不能排在正在等待的普通 Tool 后面。若对模型暴露为控制工具，它自身也需合法闭合并验证执行归属；取消请求接受不等于原调用停止。这不授权新增 sync 普通 Tool 路径。
4. 同一执行由唯一 owner 仲裁完成/取消、交付至多一次；晚结果不能再次写盘。进程崩溃下只承诺明确未知与去重边界，不声称外部副作用跨崩溃 exactly-once。
5. Parent 无工具回复、模型预算耗尽或模型失败仍必须经过所属执行收敛闸门，不能只覆盖正常 end_turn。
6. Parent 不消费 Child 原始 delta；状态摘要只包含宿主可确认的事实。结构化活动记录不等于新增进度百分比。

### 9.4 进入实施前的验证

项目所有者最初于 2026-09-30 授权执行 [方案 A Spike](../changes/archive/async-tool-use/spike-specification.md)，当时不等于接受方案为生产设计。该阶段先验证连续 steering、控制取消、多 call、竞态、JSON 重载及实际请求编码；claim/预算、真实持久化失败和 compaction 等完整场景随后由正式 Delivery 设计与验证。

后续按新增有界授权验证 Chat Completions、Responses、Messages-compatible 和 Relay 请求形态。运行证据以归档的 [Spike Results](../changes/archive/async-tool-use/spike-results.md) 为准。D1 选择的统一 accepted + HostTaskCompletion 方向已由 ADR-018、Stable Specifications 和 2026-10-02 owner-accepted Delivery 实现；当前事实以 Current Architecture 为准。

2026-09-30 实验进展：Relay 的 gpt-5.4 在 Chat/Responses 上，以及 SiliconFlow 的 DeepSeek-V4-Flash 在 Messages/Chat 上，均完成 pending 工具期间两次 steering 回复及完成配对续调；本地四项取消/竞态测试通过。SiliconFlow 回答未准确报告业务结果，但项目所有者明确该回答质量不属于本轮机制验收目标，不作为 D1 结构阻塞项。Messages 未拒绝缺少 tool_result 的负例，故不能用其宽松接受证明官方 Anthropic 合规。原始回答质量观察保留，不据此自动切换方案。

随后按用户指定以 GLM-5.3 复测 SiliconFlow 两协议，8 次生成均完成现有编码/解码及 pending/完成续调机制。其期间回复理解运行状态，最终回复却仍复述旧的 pending 状态；这是需保留的上下文理解观察，不代表真实工具未完成或 API 拒绝。原因未做对照归因，机制证据不等于最新状态语义保证，详见 Results。

另按用户授权实测“不移除原始未配对调用、直接追加 steering”：Relay gpt-5.4 的 Chat/Responses 均在启动成功后的 steering 请求返回 400；SiliconFlow GLM Messages 接受 steering，随后按原时序追加工具结果也成功。因此直接追加不能作为已验证可移植路径；此结论不同于方案 A 的控制投影可用性，也不等于官方 Anthropic 允许未配对调用。原始请求、Chat 启动参数修正和证据边界见 Results。

用户质疑参数后补做 Relay 单变量对照：清除 Chat padding、Responses 不透明 item ID 等响应专用字段，保留规范调用；两个协议在 fixture pending 时直接追加 NOTE 均 400，仅增加真实匹配结果则均 200。因而可将这组请求的差异定位于缺失结果的历史形态，而不是共同参数；不得以此外推官方直连所有模型。

进一步实测候选“提交返回 accepted+taskId，后台完成后普通宿主通知”：Relay gpt-5.4 的 Chat/Responses 均能在 accepted 闭合后处理 steering；宿主随后追加 user-role、带可信来源标记的 task completion 普通消息并主动续调，两协议均返回完成回复并保留提醒。这证明所测编码形态可用，不证明通知安全边界、持久化/去重、恢复、compaction 或其它 Provider；不再需要以宿主伪造 tool_use/result 对作为唯一无 collect 交付候选。详情见 Results。

SiliconFlow GLM-5.3 Messages 随后通过同一 accepted/steering/HostTaskCompletion 三步。Messages 把 accepted tool_result 与首次 steering 放在紧随 tool_use 的同一 user message 中；完成通知仍使用与 Relay 相同的宿主消息形状并自动续调。三类协议的 Core 事件顺序一致，wire 差异可限制在 history projection / Provider encoder，支持上述统一方向。

## 10. Subagent 的专有责任

[Subagent 草案](subagent-identity-event-routing-design-draft.md) 中以下内容仍是有效的后续设计输入，不因通用 async 方案而删除：

- Parent/Child context firewall、隔离的 transient Transcript；
- Child identity、路由、generation 和深度能力；
- 并行资格、共享写入冲突、固定并发限制、按输入顺序汇合；
- 有界结果、Usage、诊断和 artifact 引用；
- 交互归属、事件可见性和清理顺序。

上述并行、嵌套和交互能力仍是候选，不因本草稿而一并获准实现。

task 的候选最终聚合结果须保留每项成功、失败、取消或未获得结果的信息及原因；具体 schema、partial 与顶层四态映射待定义。一个 Child 失败不应伪造其他 Child 失败；全部结束只说明批次收敛，不等于用户目标完成。

卡住的 Child 不会自动给出失败结果，需要执行管理处理后报告事实。Parent 依据聚合结果决定补做、换方案、部分交付或明确未完成，而不是自动假设可以重试。

## 11. 非目标与已有能力迁移风险

- 不保留 sync/async 模式开关或长期双执行路径。
- 不新增自动重试、日志内容诊断、动态超时学习或逐 Child 监督。
- 不默认增加 Tool Calls 并发或同一 Parent 的并发模型调用。
- 不将 Child 原始 delta、thinking、工具日志灌入 Parent 历史。
- 不授权 detached、跨 Turn、durable queue 或重启后恢复执行。
- 不在本轮实现独立任务控制 UI、修改 Tool Result Change、Thinking Change 或稳定权威文档。

现有 exec 的 foreground、background、yield 和 process 管理已选择显式迁移边界：foreground 由 Framework 监督到退出；background 在 spawn/登记后、yield 在阈值胜出后把仍运行的进程交给 ProcessRegistry，并返回 `runId`。Handoff 后进程退出不产生第二个 Host completion；正常 Host shutdown 有界清理，crash/restart 不保证清理或恢复。通用 Tool Use 不使用 exec 的 process/runId 接口作为所有工具的强制协议。

## 12. 正式 Change 前的待决项

| ID | 决策 | 原因 |
|---|---|---|
| D1 | Provider-neutral Tool Call 闭合、steering safe point、最终结果交付协议 | 已选统一 accepted + HostTaskCompletion 方向；Relay Chat/Responses 与 SiliconFlow Messages 有界通过。可信 origin、持久化/恢复、compaction、事件竞态与 Turn 闸门未完成，尚不 Ready |
| D2 | idle、total、cancellation-grace 三项期限的配置 owner/API、默认值、范围、优先级、计时起点和暂停规则 | 已选择 Host 固定常量：idle 5 分钟、total 1 小时、cancellation grace 10 秒；均从实现启动/取消事件计时，不开放配置或 Tool hint，activity 只刷新 idle |
| D3 | idle 到期与总期限到期分别如何触发取消/模型决策，超时的 canonical 分类与正文 | 不预先把所有超时归为 aborted，也不绕过当前 Tool Result 权威 |
| D4 | 取消收敛期限、残留处置、执行隔离能力与拒绝策略 | 已选择 Runtime Quarantine；监督责任和 implementation lifecycle 由 registry/handle/Promise callback 结构表达，不维护重复状态属性；outcome 与 delivery 由结构记录表达；每个 execution 独立 quarantine 与交付；详细契约已接受 |
| D5 | 活动回调在 Registry/Extension/委派层的传递、身份与清理 | 保持一次调用关联；foreground exec output、单 Child lifecycle、MCP progress 与 Extension 显式报告是 activity 来源，不合成 heartbeat |
| D6 | exec 后台模式等已有调用方的接入、长期服务边界和旧路径删除计划 | foreground 保持 Framework ownership；background/yield 原子 handoff 到 Session-owned ProcessRegistry；固定 8 active / 1 MiB output / 32 terminal 上限；fork 不继承，Session delete/Host shutdown 清理，crash/restart 不恢复 |
| D7 | Tool 并发 admission、Parent 调用与事件竞态顺序、部分聚合语义 | 已选择逐调用 admission/submit；同 Turn before-hook chains 按 call 顺序串行，之后 approval 独立；Runner 用 composite gate 组合 admission/pairing、Framework execution、steering 与 Model call；terminal/UI 独立，completion-only Model call 等 Turn registry 为空后批量交付；固定 8 个 Tool slots，不排队 |

当前工作分类为 Documentation。进入 Architecture Slice 前需建立正式 Plan 与所需 ADR/Spec，接受设计并批准 Delivery；不能将本草稿标为 Ready。

根据 [Development Workflow](../governance/development-workflow.md)，D1 的 Provider 协议和 D4 的 quarantine/late-settlement 实现仍需在 Delivery 中通过契约测试与故障注入验证。研究中的外部案例不能替代本项目协议和收敛证据。

## 13. 候选验证集合

1. 短调用、长调用、builtin、Extension 均走单一执行路径，不需要模型提供 async 参数。
2. Tool Promise 未完成时，控制流程可接收 steering、检查期限和处理 Turn Abort；不忙轮询或逐 delta 调模型。提醒和进度询问可被 Parent 实际处理并回复，Tool 不被取消；未知进度不编造。明确转向时取消对应调用，收敛后在同一 Turn 继续；取消与自然完成竞态保留真实结果。Parent 模型处理期间监督仍保持响应。
3. 原调用闭合与 steering/结果交付在各 Provider 上合法；终态至多一次，无重复 call ID 结果。
4. 假时钟验证 idle/总期限分别触发；活动只刷新 idle，Tool 建议不能覆盖总期限，系统墙钟跳变不影响比较。
5. reportActivity 仅由本次 Tool 内部执行链持有，Parent 读取活动记录而不代报；多次同名调用活动互不干扰；每个 task 的单一 Child 只刷新所属 execution。
6. 无活动接口的 Tool 不产生虚假心跳；完成/取消后迟到事件不能恢复执行或重复交付。
7. 单调用取消不终止 Parent；Root Abort 到达所有所属执行；真实成功与 Abort 竞态保留真实结果。
8. Child delta 正文不进入 Parent Transcript；每个 task 独立返回所属 Child 的成功/失败/取消结果。
9. 无用户操作时，模拟不返回、等待输入、持续输出无进展等任务，验证有限处理而非只显示运行中。
10. 用受控隔离环境验证忽略 signal、取消失败和阻塞执行，明确哪些保证依赖进程外能力；不使用悬挂的生产进程作测试。
11. Turn 结束、shutdown、generation retirement、late event 和 cleanup 竞态不遗留无主执行；未收敛显式失败而非伪造完成。
12. 一个共享 completion-call reserve 覆盖多个 active executions；无 steering 时等 Turn registry 为空后一次批量调用，Root Abort 不再调用 Model。
13. pending admission/Provider pairing 持有共享 reserve 并通过 Runner composite gate 阻止 Turn terminal；Framework predicate 只覆盖 execution work；同 Turn before-hook chains 不跨 call 重叠，Approval 可独立等待。
14. ProcessRegistry 验证 8 active、1 MiB tail、32 terminal、Session 隔离、fork 不继承、Session deletion 与 Host shutdown cleanup。
15. max_llm_calls 最后一个 Assistant Tool Call record 带 durable stop reason；reload 只补缺失的 unavailable batch，不执行 Tool、不自动续调或重复结果，下一用户 Turn 对 Chat/Responses/Messages 保持合法配对。
16. 现有权限、Hook、FIFO claim、History、fork、模型预算和 exec foreground/background/yield ProcessRegistry handoff 按 Draft 方案回归。

本轮没有执行以上产品验证，不借用此前 Tool Result 或 Thinking 实验的测试成绩。文档检查不构成执行保证。

## 14. 外部参考与证据边界

以下公开资料用于比较机制，不作为本项目契约或所有工具可强制取消的证明：

- [MCP Lifecycle / Timeouts](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)：请求期限与 progress 可刷新期限不同，建议保留最大等待界限。
- [MCP Cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)：取消通知不保证接收方停止执行。
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)：实验性的接受、查询和延后结果模型；cancelled 状态也不必然代表底层执行停止，TTL 不是执行期限。
- [OpenAI Agents SDK Tool timeouts](https://openai.github.io/openai-agents-python/tools/#function-tool-timeouts)：异步函数工具的超时可作为模型可见错误或抛出异常，不代表任意同步代码可抢占。
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)：前后台、结果通知与独立任务控制；不直接套用其 detached 生命周期。
- [Codex 有界等待源码快照](https://github.com/openai/codex/blob/bcd6d9ab6b9f26f85d76d0c680b3f88b367bffa0/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L172-L218)：等待超时与终止 Child 是不同操作。

核验背景为 2026-09-30 的官方文档/源码研究；在线文档会变化，源码快照不等于全部已发布版本。本轮没有对其他产品执行故障注入或强制取消测试。
