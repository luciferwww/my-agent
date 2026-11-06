# Session 执行展示与 Transcript 设计草稿

> Status: Non-authoritative design draft
> Authorization: 仅用于讨论，不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> Date: 2026-11-02
> Discussion update: 2026-11-03，收敛祖先留存、现有身份复用与实施边界；仍不授权实现
> Follow-up: [Session Execution Presentation Change](../changes/active/session-execution-presentation/plan.md) 的 Plan／Spec 已接受并分阶段实施；消息关联基础已实现，后续阶段尚未交付。具体契约与进度以 Change 为准。
> Scope: Child 事件向 Parent 投递、父 Transcript 中的展示专用记录、Tool 分组与递归执行展示、实时与历史恢复边界

## 1. 背景与讨论方向

希望在聊天中展示一次执行的真实层级：同一次 LLM call 的 Tool Calls 组成一组；`task` 是特殊的 Tool Call，其下面可以包含 Child 的文本、Thinking、Tool 分组，以及递归 task。

只转发实时事件可以解决执行中的观察，但不能直接解决历史恢复：

- Child Session 是临时执行对象，结束后会失效，并在保留期后被清理。
- 父历史若只保存 Child Session 引用，不能长期独立恢复内部过程。
- 另外保存一套完整 UI 事件列表会引入新的存储与一致性边界。

当前候选方向：

> Session Transcript 不等于 Model Context。在父 Transcript 中留存必要的 Child 展示记录，同时将这些记录排除在父模型上下文之外；实时投递与持久化复用同一执行事实来源。

当前讨论方向已收敛为留存并恢复 Child 内部展示过程，而非历史仅保留 task in/out。这是草稿中的方案选择，不等于已接受的实施决策。

### 1.1 单文件可追踪性

将后代的展示投影留存在所属持久 Session Transcript 中，还有一个直接收益：排查问题时，可以在一个 Session 文件内查看父执行与 Subagent 的流程细节，不必在多个临时 Child 文件之间追踪，也不受 Child 清理影响。

因此，候选方案不仅服务于 UI 历史恢复，也服务于人工阅读、导出与离线诊断。记录需保留来源身份、调用关联和逻辑顺序；同文件的物理追加顺序不能代替并发执行的因果关系。

这里的“完整流程”指选定保留范围内的执行内容及关联，不代表保存所有流式 delta、模型私有载荷或未经裁剪的原始输出。按第 7 节的所有祖先留存规则，每个 Session 文件均可独立查看其后代过程，不只 Root 如此。

## 2. 当前实现事实

- Transcript 已包含消息、Compaction、工具执行接纳、工具终态等不同类型，不是模型消息的原样列表。见 [TranscriptEntry](../../src/core/session/types.ts)。
- Transcript 加载器只接受已知记录类型；增加展示记录需要同步类型与校验，而不是直接向 JSONL 写任意事件。见 [transcript.ts](../../src/core/session/transcript.ts)。
- 当前 `getHistory()` 从活动分支的消息生成分页结果，并投影工具执行信息；不会自动返回新增的展示记录。见 [SessionManager](../../src/core/session/SessionManager.ts)。
- Subagent Transcript 当前保留期为 24 小时；父历史不能将它视为永久依赖。
- 当前 Subagent start/end 可按 caller Session 投递；Child 普通内容事件仍按真实 Child Session 路由。
- Approval 属于独立 interaction 路径，不会仅因普通 AgentEvent 路由扩展就自动覆盖。
- 客户端已有扁平 segments、Tool 卡片、历史还原及 Child 详情入口；尚不是递归内嵌执行树。

上述事实只用于说明本次讨论的出发点，不代替对应源码和权威文档。

## 3. 展示目标

### 3.1 分组与层级

- 同一 Agent、同一次 LLM call 的 Tool Calls 为一组；不同 LLM call 不因属于同一 Turn 而合并。
- LLM call 工具分组是单独的展示改动，不是 Child 事件归位和内嵌展示的前置条件；文本分段与增量更新沿用现有机制。
- Tool 组默认展开，用户可手动折叠；完成时不自动折叠。
- 第一版不生成“读取 N 个文件”等工具专属智能摘要，只使用数量、工具名与状态。
- 普通文本不需要成为树节点，但必须留在所属 Agent 的展示层级内。
- task 的内部区域承载 Child 的完整展示序列，而不只是 Child Tool 列表。
- 递归 task 按真实关联继续嵌套，不按时间接近或工具名称猜测父级。
- Approval 在对应调用处醒目展示；观察范围与审批权限分别设计。

示意：

```text
Parent commentary
Tool group: LLM call A
  read_file
  task
    Child text / Thinking
    Tool group: Child LLM call A
      search
      task
        Grandchild presentation
Parent answer
```

### 3.2 实时与历史

实时内容和历史内容应尽量进入相同的客户端展示归约逻辑，而不是维护两套互不兼容的树。

展示树是派生结构；不要求将现有所有 conversation segments 改成持久树，也不保存组件状态。

#### 并发 Subagent 的独立展示 slot

同一次 LLM call 并发发起多个 task 时，每个调用拥有独立、稳定的展示 slot。slot 指客户端派生的内容归属区域，不是新增的持久化组件对象。

```text
Tool group: 同一次 LLM call，3 个工具调用
  task1 · 执行中
  | Child 1 文本
  | Child 1 工具组 …
  task2 · 执行中
  | Child 2 文本
  | Child 2 工具组 …
  task3 · 执行中
  | Child 3 文本 …
```

- 同组 task 按父模型返回的 Tool Calls 顺序排列，不因首次输出、后续活动或完成时间而重排。
- 并发 Child 事件可以交错到达，但按稳定调用关联进入各自 slot，不按到达顺序拼入父正文，也不为每个 delta 重建顶层 task 卡片。
- 每个 slot 内按对应 Child 的执行序列更新：文本／Thinking delta 更新所属内容块，Tool 事件更新所属工具卡，递归 task 建立自己的嵌套 slot。
- 复用 Child 唯一 ID 及创建时已有的 task／父子关联定位 slot；文本分段、增量追加与工具卡更新沿用现有主聊天及 Subagent 展示机制，不预设新的 ID 或关联体系。
- Transcript 允许交错追加并发记录；物理追加顺序不直接决定 UI 的顶层排列。历史还原与实时归约使用相同的调用归属，分页不完整时仍遵守第 8 节的局部展示规则。

### 3.3 独立 Child Chat 查看入口

若主聊天已经内嵌 Child 的实时文本、Thinking、Tool 与递归 task，并能从父 Transcript 恢复历史过程，现有“点击 Subagent 打开独立 Child chat／事件流窗口”的查看功能便与主聊天重复。

本轮将移除该独立查看入口作为客户端改造的候选范围，不要求长期维护两种展示方式：

- 实时观察直接在 task 内完成，不再为了查看过程单独订阅 Child。
- 历史过程从父 Transcript 读取，不依赖 Child Session 仍然存在。
- 递归执行保持在同一会话层级中，不要求逐层打开窗口。

取消独立查看窗口不等于取消 Child 身份、生命周期或交互路由。内嵌 Approval、取消等操作若纳入范围，仍须使用真实 Child／执行身份并遵守授权边界，不能误发给 Parent，也不能因可观察而自动获得控制权限。

未来若确有专注查看某个 Subagent 的需求，可以基于同一份展示数据增加过滤／聚焦视图；这不是首期要求，也不意味着恢复独立 Child 事件订阅。

## 4. 候选数据流与所有权

```text
Child 执行事实
  ├─ 现有 Child 自身 Transcript / Context 路径
  └─ Runtime 展示投影
       ├─ 展示记录分别留存到所有祖先 Transcript
       └─ 实时交给 Channel，发送给相关 Session 订阅者

Parent Transcript
  ├─ Context 投影：父消息与允许参与 Context 的记录
  └─ History / Display 投影：父消息 + 展示专用记录
```

- Runtime 知道执行归属与 Parent 关联；SessionManager 管理 Transcript 校验、写入与读取。
- WebSocket Channel 负责传输，不作为展示历史的持久化所有者。
- 无客户端连接时，持久化仍应工作；不能依赖是否存在订阅者来决定记录。
- 向 Parent 投递时保留真实来源 Session 身份，避免 Child 文本进入父正文。
- 一个连接同时观察 Parent 和 Child 时，应避免重复投递同一事实。
- 持久化与发送的先后、失败传播及刷新一致性还需明确，不在此承诺 exactly-once 或逐事件 fsync。

### 4.1 无开关的祖先观察语义

2026-11-03 讨论明确：不新增观察开关、执行树观察模式或逐 Child 自动订阅机制。订阅一个 Session，即应收到其 Child 及递归后代的 chat 事件；投递范围覆盖所有祖先订阅者，而不只直接 Parent。

- 事件保留真实来源 Session／Turn 与调用关联，不伪装成祖先事件。
- 一个连接同时订阅多个相关 Session 时，同一事实只投递一次；不修改其显式订阅集合。
- 不要求客户端逐个发现并订阅 Child 才能观察完整执行过程。
- 这属于订阅语义变更，不是用户可选功能；各事件消费者必须按真实来源处理，避免 Child 内容混入父正文。
- 扩大观察范围不扩大控制权限，不自动授予向 Child 发消息、审批或取消的能力，也不绕过现有访问授权。
- Approval 属于独立 interaction 路径，但已有 Root 受众投递与操作能力；复用该路径，仅调整 Child slot 匹配，见第 9 节。

实时投递和持久化是不同职责，但范围一致：实时投递给所有祖先订阅者，展示记录留存到所有祖先 Transcript，具体见第 7 节。

## 5. Transcript 中保存什么

增加明确区别于父模型消息的展示专用记录，不伪装成父 Assistant 消息。具体类型名、字段、版本兼容及写入路径在 Change 中结合现有实现确定，不作为本草稿的设计阻塞项。

### 5.1 所需事实

| 信息 | 用途 |
|---|---|
| 记录身份／来源事件身份 | 去重、实时与历史接管 |
| 所属父 Turn 与挂载的 task 调用 | 将内容放回正确的父历史位置 |
| 真实来源 Session、Turn、调用身份 | 保留执行身份，区分并发 Child |
| LLM call 边界（用于工具分组） | 单独支持同次调用的 Tool 分组，不作为 Child 归位前提 |
| 父工具关联链 | 恢复递归 task 层级 |
| 文本、可展示 Thinking、Tool 调用及结果 | 恢复内容 |
| 顺序与终态 | 避免乱序、重复和永久“执行中” |

这些是语义需求，不是预先规定的新字段。复用现有 Child 身份、task／父子关联及消息更新机制即可确定展示归属；Change 中核对字段复用与必要补充，不另造通用关联体系，也不预设新增 LLM invocation ID。

不要把 Transcript 的 `parentId` 消息分支关系直接当成 Tool 调用树父级；二者承担不同语义。

### 5.2 不保存什么

- 展开／折叠、滚动位置等组件状态。
- 可计算的工具数量、分组标题或专属参数摘要。
- 模型协议私有的 Thinking signature、不可展示内容或其他内部载荷。
- 仅用于保活的通知。
- 默认不逐 token 保存流式 delta。
- 不序列化当前 RuntimeEvent 对象作为未经筛选的永久契约。

Child 中需要长期展示的内容在所有祖先 Transcript 各留存一份。这是为了解除 Child 清理依赖，不应误称为完全无复制。

父 Session 中已经持久保存的普通 Tool 输入输出则优先关联复用，避免再次存一份等价展示副本。

### 5.3 内容落盘粒度

候选方式是保留有意义的边界：文本／Thinking 按内容块累积，Tool 保存调用与终态，关联与 LLM call 边界单独表达。

仅等 Child 结束后保存快照更简单，但崩溃时可能丢失整个过程；逐 delta 落盘恢复更细，却增加写入量。块完成时落盘或有界 checkpoint 是待评估的中间方案，不能未经验证承诺运行中刷新无损。

现有工具结果保留／裁剪策略也应纳入设计；历史不能暗示保存了实际已被省略的完整输出。

## 6. Context、分支与 Compaction 隔离

- 展示专用记录不参与父模型输入、token 预算、模型历史摘要或 steering。
- 写入展示记录不推进父消息的 active leaf。
- 展示记录需关联有效的消息分支；切分支、fork、截断或回滚后不能串入其他分支内容。
- Compaction 不应为了降低 Context 预算而顺带丢掉展示历史；存储保留政策应单独讨论。
- 父模型仍只消费既有 task 结果，不因保存 Child 展示过程而获得完整 Child Context。
- 旧历史缺少分组或层级事实时，只展示已知内容，不猜测补树。

## 7. Parent 范围与递归

当前讨论明确：后代展示记录留存到所有祖先 Transcript，使每个 Session 都能独立查看其自身及后代的执行过程。

```text
Root -> Child A -> Child B

B Transcript：B 自身记录
A Transcript：A 自身记录 + B 的展示记录
Root Transcript：Root 自身记录 + A、B 的展示记录
```

- 各 Child 自身 Transcript／Context 路径不变；祖先中的副本仅供展示，不进入祖先 Context。
- 保留真实来源与已有父子关联，Root 中的 B 仍挂在 A 下，而不是成为 Root 的直接 Child。
- 同一来源事实在每个目标祖先中只留存一次；不把祖先收到的展示副本再次作为新执行事实传播，避免重复。
- 接受展示存储量随祖先层数增加，以换取各 Session 独立完整、Child 清理后可恢复和读取简单；不为消除复制引入跨文件依赖或新的 archive 服务。

## 8. History API 与客户端接管

现有 History API 以消息为分页单位，不能直接把任意新记录塞入原来的 message shape。

### 8.1 最新方向：按目标条数累计，返回完整 Turn

2026-11-03 后续讨论替代了此前“固定条数切页、呈现局部子树”的方向：请求仍携带条数，但它是累计停止阈值，不是返回条数的硬上限。

从最新 Turn 向前累计，每次纳入完整 Turn，累计达到请求条数即停止；不足则返回全部可用内容。Child／后代展示内容计入发起它的本 Session Turn，不独立作为外层 Turn 分页。在 Root 查询中即完整 Root Turn，在 Child 自身查询中则是该 Child 的本地 Turn。

请求 20 条时：

| 从最新向前的 Turn 大小 | 返回 |
|---|---|
| 10、15 | 两个完整 Turn，共 25 条 |
| 50 | 一个完整 Turn，共 50 条 |
| Session 仅一个 10 条 Turn | 10 条 |

条数是 History 内容项数量，不是 JSONL 物理行数或屏幕行数。结果按正常时间方向呈现；下一页从最早已返回 Turn 之前继续取，不重复、不截断 Turn。

### 8.2 展示与成本

历史页包含所选 Turn 的已留存过程及关联，不再因分页缺少 task 起点而只画延续线。正常展示实际 task 调用及内部内容；不增加 task 内部的加载按钮或滚动区。

明确接受单个长 Turn 导致大响应的代价。请求条数限制的是累计目标，不是响应大小上限；本次不再同时引入字节截断、子树分页或分段传输来抵消这一取舍。

此前“页首只显示 Child 尾部缩进、继续翻页才出现 task 标题”的示意及局部子树规则，不再作为当前分页验收要求。

### 8.3 已结束 Turn 的接管

服务端保证返回已选 Turn 的完整持久内容后，客户端可以保留原有终态 Turn 整体替换方式，不因本次展示改造要求逐消息精确接管。

因此不再需要此前为部分 Turn 接管提出的 message_committed 通知。不过，后续运行中时序验证仍发现重叠，owner 已确认增加可选 messageId 关联，见下节；完整 Turn 分页不替代该关联。

### 8.4 运行中加载历史的边界

运行中的 Turn 没有最终完整内容，只能返回查询时已持久化的快照；不能因为纳入了整个可见 Turn，就把它当作执行已结束并清除实时内容。

保留“先订阅、后加载历史”的流程。当前客户端已按工具 callId、Thinking ID 和文本前缀合并，并非完全没有去重；受控真实 socket 检查进一步复现首次打开的后缀重叠及重连的缺段重叠，详见 [验证记录](../changes/active/session-execution-presentation/validation.md)。检查未挂载完整 Vue 页面或真实 Provider，不代表完整端到端验收。

2026-11-03 owner 确认：在消息记录上保存可选 messageId 引用，不改变 entry ID 或已有实时 message ID，也不增加独立映射表。用户输入与 steering 原样传递已有身份；Assistant 消息需在首个可展示事件前确定消息级身份并贯穿到正常／abort partial 落盘。祖先展示副本保留来源 messageId，History 安全投影该字段。invocation ID 不覆盖各种消息，排除为通用关联方案。

覆盖标准不是消息角色，而是是否可能通过实时与 History 重复呈现：所有可能重复的会话消息都需要同一 messageId。字段加在 MessageRecord，祖先 presentation.message 保留来源字段，不上提到所有 entry。tool_execution_accepted／terminal 是工具卡状态事实，继续用 callId／executionId 关联；host_task_completion 当前不独立输出为 History 消息项，这些内部事实不额外增加 messageId。工具结果作为 type: message 的独立消息呈现时，仍遵循消息关联规则。

运行中按 `(sourceSessionId, messageId)` 消除已提交消息与实时片段的重叠，未提交消息继续保留；工具／审批继续按既有调用身份更新，不因正文来自历史就停止。旧记录不补造身份，不以文本相似代替精确关联。记录是否进入 Context 仍由 message／presentation 类型边界处理，不为每个 entry 增加开关。

Change 应针对运行中首次打开、重连、相同文本不同消息、History 与实时增量交错、重试，以及查询期间 Turn 结束做聚焦验证。终态后的最新 History 才可按终态请求整体接管，不能误用较早的运行中快照。完整 Turn 分页与消息关联各解决一个问题；不引入逐 token 持久化或事件重放服务。

### 8.5 Change 中落实的接口细节

- 在现有条数参数和游标上落实完整 Turn 的累计规则。
- 将后代展示记录归入正确的本地 Turn，复用现有父子关联。
- 落实消息级身份传递、可选 messageId 持久关联与 History 投影，不改变 entry ID 或已有实时 message ID。
- 验证已结束 Turn 的写入完成顺序和整体接管。
- 验证运行中快照与实时合并，不把尚未持久化等同于内容缺失或执行结束。

具体实现仍在 Change 中确定；不将运行中快照标为最终完整，也不承诺抗硬退出保存每个 delta。

## 9. Approval 边界

Child Approval 内嵌展示与现有操作纳入本次范围，不新增审批投递路径。独立审核纠正了此前“全局广播且 sessionId 即 Child”的假设：

- 实时请求面向 Root Session 订阅者；可恢复的 pending 集合查询不是实时全客户端广播。
- Child 请求的 sessionId 是 Root 受众 Session，turnId 与 callId 属于 Child 内部调用。通过 Child turnId 和已有父子关联定位 slot，再用 callId 匹配工具，不能仅按 sessionId 定位 Child。
- 审批继续使用原有 approvalId、pending 状态与 Channel 授权流程，不改为向 Parent 或 Child 发送消息，也不新增权限。
- 调用卡片尚未加载或尚不能挂载时，仍保留可操作的 pending 入口；归位后避免重复显示。
- 展示历史中的审批痕迹不能恢复成可点击的旧授权请求。
- 能看到 Child 活动，不自动意味着能提交 Child 消息、取消执行或批准请求。
- 对祖先扩大观察范围必须遵守现有授权边界；不能仅凭 ID 关联跨越访问权限。
- 是否保存审批结果用于展示，独立于本草稿的 Tool 内容持久化范围决定。

## 10. 历史详细程度的取舍

| 方案 | 历史内容 | 收益与代价 |
|---|---|---|
| A：只保留 task in/out | 父 Tool 输入、最终输出及状态；不恢复 Child 内部过程 | 最简单，可主要复用父历史；实时树与重载后展示不同 |
| B：留存 Child 展示投影 | 文本、Thinking、内部 Tool、分组及递归关联 | 清理后仍可恢复过程；需要新增展示记录与历史接管 |

当前方向为 B：恢复已留存的 Child 内部展示过程，并支持单文件追踪。A 仅保留为已比较的简化方案，不再作为同等开放的主路线；不采用刷新后统一退化为仅 in/out 的行为。

留存展示过程按第 8 节的完整 Turn 累计规则分页；运行中的内容仍只是截至查询时的持久快照。“正在汇聚事件”不代表持久化与历史接管没有额外实施成本。

## 11. 外部方案的参考边界

- OpenCode：结构化消息／parts 同时服务展示和模型消息转换；Child 主要通过独立 Session 关联。不能据此推断其把 Child 全部过程复制到父历史。
- 本地 OpenClaw：存在展示专用的 nested tool activity，显式 `display: true`、`excludeFromContext: true`，写入 Transcript 后再生成历史工具内容。已核实的是嵌套 Tool Search 路径，不代表所有 Subagent 事件都如此。
- AcademicAgent：另存展示 tokens 列表可直接恢复展示，但会引入独立展示历史的存储边界。

参考：[OpenCode 固定研究提交](https://github.com/anomalyco/opencode/commit/ff90ed91607cabf420a369e9009539c1aa0932af)。

借鉴的是“持久会话记录与模型 Context 分离”的原则，不要求照搬任何外部 schema。

## 12. 实施边界与验证

目前没有已确认的设计阻塞项。Draft 明确语义与展示方向，具体记录 schema、字段、API、代码落点和兼容细节由后续 Change 结合现有实现确定；不为此预设新的 ID、关联体系或通用框架。

- 复用现有 Child 身份、父子关联与消息更新机制；LLM call 工具分组单独处理。
- Change 落实记录校验、落盘时机、写入失败报告、分支隔离、分页与实时接管、进程中断，以及大小／裁剪边界。
- 无开关祖先观察、所有祖先留存和历史恢复内部过程不再列为待选择方案。
- Child Approval 沿用现有投递与操作，内嵌匹配纳入本次范围，见第 9 节；不另建审批基础设施。

若后续接受实施，应覆盖：无订阅者执行、并发与递归 Child、Child 清理后恢复、实时／历史合并、分支隔离、Context 排除、写入失败、中途退出、旧历史兼容，以及审批不被历史重放激活。分页专项覆盖第 8.1 节三个数值示例、超长 Turn、不拆分后代过程、游标连续性，以及运行中订阅／快照／结束交错的真实时序。

## 13. 相关讨论

- [Tool Activity 展示草稿](tool-activity-presentation-design-draft.md)：较早的卡片设计讨论；其默认折叠等选择不是本轮展示方案的既定约束。
- [Subagent 隔离与事件路由草稿](subagent-identity-event-routing-design-draft.md)：保留 Context firewall；本轮提出的展示专用持久化不等于将 Child 内容送入父 Context。
- [临时单 Turn Session 观察与保留调研](ephemeral-single-turn-agent-session-design-draft.md)：Child 生命周期、保留和清理背景。

这些研究材料均不授权实现。接受方案后，再由正式交付流程处理权威契约及源码变更。
