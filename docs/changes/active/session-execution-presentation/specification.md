# Session Execution Presentation Specification

> Status: Accepted
> Date: 2026-11-03
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Related Decision: [Accepted decision](decision.md)
> Design input: [Research draft](../../../research/session-execution-presentation-design-draft.md)

## Purpose and observable outcome

主聊天按 task 内嵌 Child 文本、可展示 Thinking、工具调用／结果与递归 task。实时和历史按相同归属组织；Child 被清理后仍可从祖先历史查看已留存过程。

## Scope and non-goals

包括所有祖先观察与展示留存、按目标条数累计的完整 Turn History 分页、bundled client 固定 slot、现有 Approval 挂载、LLM call 工具分组及独立 Child 窗口替代。

不新增控制权限、观察开关、独立展示数据库或通用身份框架，不变更模型消息语义、Child 清理期限或执行监督规则。以下为已接受的目标设计；消息身份、祖先留存／History／实时投递、递归内嵌 UI 和 LLM call 工具分组已分阶段实现。整体目标验收仍待推进，不表示整个 Change 已完成。

## Boundaries and dependency direction

- Runtime 使用现有执行归属确定祖先链；SessionManager 拥有 Transcript 校验、写入和历史读取。
- Channel 负责有授权的实时投递，不因客户端是否订阅决定是否持久化。
- 客户端按事实派生执行层级，不将 Vue 组件、折叠状态等写入 Transcript。
- Subagent 首次进入终态时自动收起；较旧的 running／unknown History 不得回退已知终态或使卡片重新展开。完成后手动重新展开的选择在重复事件及 History 刷新间保留；生命周期先于父工具卡到达时也遵守此规则。
- 复用 Child ID、task／父子关联与现有文本更新机制；LLM call 分组不是 Child 内容归位的前置条件。

## Public and structural contracts

### Observation

订阅一个 Session 默认接收其全部后代的 chat 事件，保留真实来源与已有关联；同连接多重命中仅发送一次，不增加隐式订阅，不授予 Child 发消息、审批或取消权限。无特性开关。

### Transcript and Context

展示专用记录明确区别于父模型消息。每个执行事实需要留存的展示内容在每个祖先各保存一次，来源 Child 自身记录路径不变。

例如 Root → A → B：A 文件包含 A 自身与 B 展示，Root 文件包含 Root 自身与 A、B 展示。保留嵌套归属，不将 B 误挂为 Root 的直接 Child。

展示记录不进入祖先 Context、token 预算或模型 Compaction 输入，不推进父消息 active leaf；沿用有效分支约束。普通父工具已存输入／结果优先复用，不存等价副本。可展示 Thinking 不包含模型私有 replay 载荷。

#### Minimal record contract

在现有 `TranscriptEntry` 中增加 `presentation` 类型，不为所有现有消息增加通用 context/display 开关。`getMessages()` 和模型 Compaction 继续只消费消息分支；History 另行读取展示记录。

沿用 `TranscriptEntryBase` 的 id、parentId、timestamp，补充以下语义字段：

| Field | Contract |
|---|---|
| `sourceSessionId` | 真实来源 Child Session；不替换为接收副本的祖先 |
| `sourceEntryId` | 复制持久事实时使用原记录 id；用于同目标去重与来源核对 |
| `body` | 以下白名单中的展示内容，不接受任意 AgentEvent 或模型协议对象 |

`body` 仅包含本次需要的事实：

- `message`：来源 turnId、role、经过展示投影的 content、已有 abort 标记、可选的实时消息关联 messageId，以及实际模型响应可选的 llmRound。沿用 History 的可展示 Thinking 结构，不复制 AssistantInvocation、replay payload 或私有 signature。
- `tool_execution_accepted`／`tool_execution_terminal`：复用已有 callId、executionId、turnId（适用时）、结果与终态语义；只投影 History 所需字段，不复制模型完成通知等内部控制记录。
- `subagent_start`／`subagent_end`：复用现有生命周期事件的 Child Session/Turn、callerSessionId、parentTurnId、parentToolUseId、runId、subagentType、depth 和终态。为其创建普通 Transcript 记录身份，不新增 execution 身份体系。

消息与工具事实以 `(sourceSessionId, sourceEntryId)` 去重；生命周期以已有 Child 身份和 start/end 阶段去重。同目标重复写入相同事实是幂等的，内容冲突按 Session 数据错误显式报告，不覆盖旧事实。

`parentId` 是目标 Session 中所属委派分支的消息锚点，不是来源 Child 的消息 parentId，也不是嵌套 Tool 的父级。直接 Child 锚定创建它的 task 所在 Assistant 消息；更深后代沿用该祖先中对应的委派锚点，不能随祖先后续 steering 消息移动。

将最小字段落实为 TypeScript 联合类型时复用现有类型；不以本表为理由新增重复字段、额外 ID 或通用事件存储层。

#### Message identity correlation

2026-11-03 owner 确认增加持久记录与实时消息的关联，不改变既有 entry ID 或已有实时 message ID 的生成方式和含义。

- 覆盖标准是是否可能通过实时路径与 History 重复呈现，而不是 role 或 entry 类型。凡两条路径可能呈现同一条消息，都必须携带同一个 messageId，包括适用的用户输入、Assistant、工具结果及系统／Host 生成的展示消息。字段可选是为了旧数据及没有对应双路径展示的记录，不表示正常新链路可任意省略。
- `MessageRecord` 顶层增加可选 `messageId?: string`，记录对应的实时消息身份；不放进模型 message payload，不改变 `appendMessage()` 生成记录 id 的行为。字段存在时必须是非空字符串。
- 已有用户输入 messageId 原样贯穿初始输入与 steering 的落盘路径，不能在 claim／注入时丢弃。Assistant 消息在首个可展示事件之前确定消息级 ID，相关文本／Thinking 事件及最终正常或 abort partial 写入携带同一个 ID。中途订阅不能依赖先收到该消息的开始事件才能识别后续内容。
- 2026-11-04 owner 确认主 Agent、Child 及未来 Agent 类型对齐：公共 Runner.run 入口保留传入的 originMessageId，缺省则在 run_start 前生成一次；不修改调用方参数，同一次输入跨 compact/retry 沿用该值，落盘为 messageId。不为 Child 单独创建身份框架，不实现尚处设计阶段的 Automation 功能。
- messageId 属于消息，不属于整个 Turn 或 round；同一 Turn 的不同 Assistant 消息分别持有身份，overflow 重试不因 round 重置而复用其他消息的身份。本 Session 消息的历史关联仅处理活动分支上的有效记录；尾部清理后的旧物理消息不参与来源自身 History。祖先展示输入则保留实际提交事实，abort／分支回退不等于撤销输入。
- 来源记录写入后，祖先 `presentation.message` 原样保留其 messageId；History 将本地消息及副本的可选 messageId 投影给客户端。关联键为 `(sourceSessionId, messageId)`，本地来源由响应 sessionId 确定；副本自己的 entryId 不替代来源消息身份。
- `type: message` 的工具结果消息若存在实时／History 双路径展示，同样需要 messageId。工具执行事实则不等于独立消息：tool_execution_accepted／terminal 对已有工具卡的状态和结果更新继续用 callId／executionId 关联，不额外增加消息身份。一个调用、一个 UI 卡片与一条持久消息不保证一一对应。
- messageId 字段加在 MessageRecord，不上提到所有 Transcript entry 的公共基类；祖先 presentation.message 保留来源字段。当前 host_task_completion 是内部完成通知事实，不独立输出为 History 消息项，不增加 messageId；不能把事实参与历史投影或模型恢复等同于它自身是一条展示消息。
- `id`／parentId／sourceEntryId 继续承担记录身份、分支和副本去重职责；不增加独立映射表，不使用 invocation ID 作为通用消息身份。
- 同次输入的重复落盘不应形成多份祖先展示：复制端在目标原有写锁内，按来源 Session＋Turn＋user 消息 messageId 匹配既有副本；body 与委派锚点一致时保留首份及其 sourceEntryId，不一致显式报持久化冲突。不按文本判断，不跨来源／Turn／角色合并，不处理无身份旧消息，也不将 messageId 用作整个 Transcript 的唯一键。来源物理尝试记录不变，不新增撤回事件或分支失效协议，不迁移此前已生成的重复副本。
- 旧记录没有 messageId 时不补造映射；兼容展示不等于具备精确关联保证。`message`／`presentation` 的类型边界继续隔离 Context，不增加通用 includeInContext 标记。

#### Persistence source and timing

- 在 Subagent orchestration 创建 Child 时建立已有身份的关联，并在可观察 start 前保存祖先中的 start 记录；end 同样保存明确终态。setup 失败也需要正常闭合已发布的 start。
- SessionManager 在来源消息成功写入后，从该已保存记录生成展示副本，并 await 各祖先写入。工具 accepted／terminal 记录同理，确保工具完成后无需等 Parent 的下一次模型调用才能持久恢复状态。
- Child 的用户输入也按自身消息投影保存；工具最终输出遵循既有持久保留边界，裁剪须保留明确标记。普通父消息不额外复制。
- 不通过 Channel fanout 的 observer hook 承担可靠写入：现有该路径会隔离 observer 错误。持久化应接入会被 await 的 Session／orchestration 写入链，和传输失败隔离明确分开。
- 不持有一个 Session 写锁再等待另一个 Session 锁。来源记录写完后释放来源锁，以已捕获的来源记录及祖先分支锚点执行副本写入；每个目标继续使用已有串行写入机制。
- 每条事实的祖先副本写完才报告本次持久操作成功；不是跨文件事务，途中失败可能已有部分文件写入，错误必须带来源／目标被报告并按已有 IO 失败路径传播，不伪造回滚或成功。
- 不靠重发所有实时 delta 补历史，不引入自动重试后台队列。已写来源事实可按相同去重键重放，但本次不承诺崩溃后的跨文件自动修复。

硬退出前尚未达到原有持久边界的流式文本可能只在内存。正常 abort 沿用 Runner 已有 partial 消息落盘边界；普通 Provider 流异常当前会直接抛出，尚未提交的文本／Thinking 也可能丢失，不将其误称为已有 partial 保存能力，本次不扩展该失败策略。无内容的 LLM 调用不生成空消息；硬退出后没有终态的执行显示中断／未知，不显示成功。保留完整流程指已持久事实完整可查，不承诺每个曾显示的 token 均抗崩溃。

### History

2026-11-03 后续讨论将分页改为：请求条数是累计停止阈值，返回以完整本地 Turn 为边界。已结束 Turn 的持久内容不得因 limit 被切开，包含挂在该 Turn 下的全部已留存后代展示。

在 Root Session 查询中按 Root Turn 分组；查询 Child 自身时按该 Child 的本地 Turn 分组。不同来源 Child turnId 不作为祖先查询的外层分页单位，而是通过已有委派链归属到祖先本地 Turn。

接受一个长 Turn 可能使响应远超请求条数，不设静默截断或嵌套分页。运行中 Turn 只返回读取时已保存的内容，不代表最终完整，也不据此清空实时内容。

#### Page shape and selection

沿用 `sessionId`、`beforeEntryId`、`limit` 请求和 `items`、`nextCursor`、`hasMore` 响应，不增加 Turn／task 嵌套分页 API。limit 默认 50、允许输入 1–100 不变，但输出可以超过 100；它不再是返回条数上限，也不是字节数上限。

- 候选项为活动分支上的本 Session 消息，以及分支锚点仍在该分支的 `presentation.message`。工具生命周期和 Subagent 关联记录用于补充投影，不独立消耗 limit。
- 按本地 Turn 在活动消息分支的先后顺序，从最新向前逐个纳入完整 Turn；每纳入一个 Turn 累计候选项数量，达到 limit 就停止，不足则返回全部可用项。响应按由早到晚返回，同一 Turn 内使用目标文件追加顺序并保留来源归属。
- `nextCursor` 是本页最早 Turn 的首个候选项在目标文件中的 entryId；传入该 cursor 时，从该 Turn 之前继续读取。校验 cursor 是否指向 Turn 起点；不接受位于 Turn 内部的游标来重新引入截断语义，使用既有游标错误报告，不向调用者悄悄调整范围。
- 查询在读取时固定候选集合和关联投影；新追加到当前 Turn 的内容不改变此前 Turn 的游标边界。只按有效活动分支读取，不因物理文件中不同分支交错而串页。
- 原有消息保留当前 History message 形状；新增可选 `messageId`、`sourceSessionId`、`sourceEntryId` 和 `llmRound`。本 Session 消息的来源身份由响应 sessionId 与 entryId 确定；展示副本显式携带真实来源。
- 响应增加 `scopes`：返回本页涉及的 Child 及必要祖先的已有生命周期关联，按 Child Session 唯一，包含最新已知状态。它用于递归挂载，不引入独立分页或新的身份。
- task 在同一父 Assistant 内容中的调用顺序由该内容的 tool_use 数组确定，不能随交错事件到达顺序重排；完整 Turn 页同时包含其已保存的父调用。
- terminal／accepted 从目标文件的本地事实补充本页工具卡，即使终态事实不在该条分页窗口内，也不依赖来源 Child 存活。缺少卡片的结果暂存匹配，不补造调用。
- `hasMore` 指仍有更早的 Turn，不指当前执行是否结束。

消息 snapshot、工具结果消息维持当前按记录计数的方式，不拆为 token 或按 UI 卡片数计数。大工具结果的大小仍受既有持久化策略约束；不以这次变更引入独立字节分页系统。

请求 20 的验收示例：

| 最新向前的 Turn 大小 | 返回内容项 |
|---|---:|
| 10、15 | 25，两个完整 Turn |
| 50 | 50，一个完整 Turn |
| Session 仅一个 10 条 Turn | 10 |

并发时仍按已有调用关联归位固定 slot；不需要再处理同一个已结束 Turn 在不同历史页之间逐段回填。向前加载完整的更早 Turn 时，沿用并验证现有阅读位置保持。

#### Realtime reconciliation

保留现有 text/thinking/tool 事件与消息分段，补齐上述 messageId 关联。对已确认终态且相关写入完成的本地 Turn，最新 History 返回该完整 Turn 后继续整体接管，不引入 message_committed 通知。

来源 entryId 仍用于持久副本去重／历史关联，不用它假装能关联没有该 ID 的实时消息。完整 Turn 分页不替代运行中的消息关联；owner 已确认将该关联纳入此次设计。

保留先订阅、收到确认后加载 History 的流程。在同一来源 Session／Child slot 内，History 出现带 messageId 的已提交消息时，以持久内容消除该消息的实时正文／Thinking 重叠，不按文本前缀、相同文本或段落位置判断身份；工具卡仍按 callId／executionId 合并后续状态和审批，不因正文已有历史就停止更新。尚未出现在快照中的实时消息继续保留，不清空整个运行中 Turn。

即使实时消息只有后缀或断线后的不连续片段，历史中的完整已提交消息也只能展示一份；同一 Turn 内相同文字但不同 messageId 的消息不得误合并。缺少关联的旧记录维持兼容展示，不以文本启发式冒充精确匹配；正常新链路不应缺少承诺携带的身份，缺失须按现有协议错误路径显式报告。

运行中快照不能触发终态整体清理。若请求期间 Turn 结束，保留现有 pending latest refresh／terminalTurnIds 的串行补刷机制：较早的非终态请求不承担终态替换，需等待终态之后的新快照。Child 自身 run_end 不意味着 Root Turn 终止；Root 的整体接管需要全部子 scope 已收敛，且祖先写入均已完成。

设计阶段的受控真实 socket 检查已复现首次打开的后缀重叠及重连的缺段重叠，并验证了请求期间结束的补刷机制，见 [Validation](validation.md)。检查使用实际 Transcript、socket 和客户端归约函数，但未挂载完整 Vue App／Runtime／Provider，不代表完整页面时序验证。

现有前缀合并不能被承诺为运行中任意重叠均可消重。此次通过消息级关联修正该缺口，并验证 Child 已持久块和当前流；只保存用户输入映射不够，Assistant 身份必须同时贯穿。不扩展为新通知、逐 token 持久化或快照协议。

不承诺补发断开期间未持久化的 delta，不引入 event replay 服务。

### Client

同组 task 按模型 Tool Calls 顺序固定排列，交错 delta 只更新各自 Child slot；内部复用现有文本、Thinking 和工具卡机制。递归 task 同理。

Tool 分组按同一 Agent 的同次 LLM call 边界形成，默认展开，组内所有 Tool 均为 success／error 时自动收起，之后手动展开不受重复完成事件影响；不跨调用合并，不生成工具专属智能摘要。旧历史缺少事实时不猜测分组或层级。

单个 Tool 在实时状态首次进入 success／error 时自动收起详情；Subagent 在收到 subagent_end 时自动收起内部执行展示，不以当前工具全部完成推断 Subagent 已结束。稳定 task Result 补齐终态时同样收起。完成后仍可手动展开，重复完成事件不覆盖手动展开选择；工具分组及参数摘要的既有展示规则不变。

History 首次加载时，已完成 Tool 的详情、全部 Tool 均为 success／error 的 Group 及终态 Subagent 的内部执行默认收起，running／unknown Subagent 默认展开；后续 History 补齐完成状态时也只自动收起一次，重复加载同一终态保留手动展开选择。该规则同样适用于递归 Child，不持久化折叠状态。

只要相邻展示块具有明确的 LLM call 分组归属，无论包含一个还是多个 Tool，均显示分组外框和标题，并遵循组折叠状态。实时、History 及递归 Child 使用同一规则；缺少调用归属的旧记录仍不猜测分组。


实时按每次 llm_call 事件到达形成新的调用边界，round 仅作提示而不是唯一键：overflow 重试可能在同一 Turn 重置 round。真实 Assistant 消息以顶层可选 llmRound 留存该提示（含 abort partial），经安全 History 和祖先展示副本透传，不进入模型消息。历史以各消息 entryId 和同一内容中的 tool_use 顺序形成组，不能将重复 round 合并。没有实际 LLM 调用的合成消息不伪造 round。无需新增 invocation UUID，也不要求所有 delta 携带 round。

实现保留扁平消息顺序，仅为相邻同组工具派生展示容器，不跨正文／Thinking 搬移工具。错过 llm_call 的实时工具不猜边界，后续由带标记的权威 History 补齐。运行中刷新和终态接管保留组身份及显式折叠选择。

完成内嵌观察与历史替代后移除独立 Child 查看入口；不删除 Child History API 或生命周期机制。

### Approval

复用现有通知、pending 查询、approvalId 提交及 Channel 授权。当前 Child Approval 的 sessionId 是 Root 受众，turnId/callId 属于 Child 内部调用；通过现有关联挂载，而非仅按 sessionId 找 Child。

不新增审批投递路径；pending request 在卡片未加载或尚不能挂载时仍可操作，后续归位不能重复显示。历史记录不重新激活已关闭请求。

owner 实机 UX 验收后调整操作入口：审批只在输入框上方固定的非模态面板操作，原 Tool slot 保留状态、不再显示允许／拒绝按钮。多请求一次展示一张，用左右按钮及位置／总数切换；展示来源、工具名及限高滚动的参数。新增请求不抢当前选择、焦点或聊天滚动；关闭当前请求后推进，无请求时隐藏，断线时禁用提交。继续复用 pending map、查询和 approvalId，不新增批量放行或权限语义。

## Lifecycle, failure and concurrency

- 无客户端连接时同样留存；Child TTL 清理不删除祖先中已保存的展示内容。
- 不将收到的祖先展示副本作为新事实再次传播。
- 落盘粒度与未完成文本边界见 Persistence source and timing；不默认逐 token 写入。
- 写入失败沿 await 的持久路径显式传播；Channel 发送失败仍按现有规则隔离，不抹除已持久内容，也不改变为跨文件事务。
- 已终态 Turn 依赖完整 History 整体接管；运行中快照按 messageId 合并已提交消息，不触发整个 Turn 的终态清理。副本写入异常时不得将缺失内容宣称为完整成功；停止／错误展示与最终刷新顺序须覆盖测试。

## Compatibility and migration

Channel 与 bundled client 协调迁移新观察语义及来源处理，保留显式 membership 和控制检查。旧历史维持已知消息／in-out 展示，不伪造缺失过程。

新增记录使用 Transcript v3。新 reader 读取 v1/v2/v3，保留已有消息 ID／分支／Compaction 标记；首次写入 v3 专有记录、messageId 或 llmRound 前，沿用原子 replace 升级 root version，再使用 v3 校验。新 Session 使用 v3，不改已有消息 ID，不为旧记录补造 messageId。

旧 reader 不支持 v3，应明确拒绝而非忽略新记录；回滚需使用兼容 v3 的 reader 或离线迁移，不能承诺旧程序直接打开新文件。没有旧格式运行时双写路径或开关。读取旧历史是持久数据兼容，不补造旧 Child 过程。

fork 复制所选消息分支及其可见展示事实，锚点按复制后的消息关系保留／映射；不复制切点之后才产生的副本，也不把无关分支带入 fork。fork 后只依赖新文件，不依赖源文件或 Child。

分阶段实施已覆盖此项：显式 entryId 以该消息的追加位置为切点；省略 entryId 则对当前分支已有事实作读取时快照，包括当前 leaf 之后追加的展示记录。fork 不继承来源执行的实时路由。

Session、Subagent、Channel／History 稳定契约和当前架构已随分阶段实现同步，ADR-020 已注明部分后继决定；实现事实和验证限制以各阶段 Validation 为准，不将目标设计接受等同于整体通过。

## Acceptance and validation

| Area | Required evidence |
|---|---|
| Routing | Parent/Child/Grandchild 祖先投递、同连接去重、取消订阅及控制边界不变 |
| Persistence | 无观察者也留存，各祖先一次，Child 清理后读回，Context 排除，重载和分支隔离 |
| Concurrency | 三个 Child 交错文本与工具、不同完成顺序、固定 slot、递归嵌套 |
| Pagination | 请求 20 的 25／50／10 三例、输出可超过 100、长 Turn／完整后代、游标边界连续性和分支隔离 |
| Message identity | 按实时／History 双路径逐项核对用户输入、多次 steering、Assistant 正常／abort partial、工具结果及适用的系统／Host 展示消息；同一 messageId 贯穿，重试不误关联，旧记录无映射，祖先副本保留来源身份 |
| Reconciliation | 短／长终态 Turn 整体接管；运行中首次打开与重连的后缀／缺段去重、相同文本不同消息不合并、未提交消息不丢、工具／审批继续更新、请求期间结束补刷、Child 终态不误清 Root |
| Approval | Root audience + Child turn/call 归位、未加载调用的 pending 操作、关闭同步和历史不激活 |
| Failure | 写入错误显式暴露、中断不伪造终态、旧格式可识别的兼容行为 |
| Delivery | 旧窗口替代、真实浏览器检查、相关契约／集成／回归、lint/build、独立复审 |

优先扩展现有 focused tests，按变更边界增加必要测试，不以完整构建代替精确验收。记录实际命令和结果后才能标记通过。

## Transport and routing implementation boundary

Runtime 使用当前 Child 委派关联计算来源到 Root 的祖先链，随 Channel 投递提供可选的展示路由元数据（现有身份，不是新的观察地址）。保持 send 的 AgentEvent 主体和真实来源；ChannelInstance／binding 同步接入该可选参数，不要求 Channel 反向推断执行树。

WebSocket 将来源 Session 与祖先的显式订阅连接取并集后发送一次，序列化必要的祖先关联供客户端归位；生命周期不再只投递 caller，但与普通 Child 内容遵守同样的来源及祖先规则。CLI 和其他消费者核对后代路由，不将 Child run_end 当作 Root 结束。无 sessionId 的 request_end 沿用现有 originMessage 路径，不猜测祖先。

路由关联要在 Child start 可见前建立，在其最终持久提交和已接受的终态发送完成前保留；展示记录不用于授予新的控制能力。

## Authority synchronization and next gate

本 Change 的已接受 [Decision](decision.md) 部分替代 ADR-020 中“Child 内容须独立订阅／查看”的目标设计范围；显式 membership、read-only Child 与 TTL 所有权不变。ADR-020 已注明部分后继决定；祖先观察及递归内嵌已替换 bundled client 的独立 Child 查看运行路径。

交付时同步现有 [Session 架构](../../../architecture/session.md)、[Runtime](../../../architecture/runtime.md)、[Channels](../../../architecture/channels.md)、[Channel 契约](../../../specifications/channel.md)、[Subagent 契约](../../../specifications/subagent.md) 和受影响的 Runner／History 文档，不顺手修复无关旧文档问题。

SEP-ID 至 SEP-4 已实现消息身份、v3 读写升级、祖先留存／投递、完整 Turn 分页、递归内嵌、Approval 归位及工具分组。SEP-5 的独立复审、自动验证及限制见 Plan／Validation。2026-11-06 owner 确认经过多轮人工测试和修正，暂未发现还需修改的事项，人工审核通过；该确认不扩写为未执行的线上 Provider E2E。
