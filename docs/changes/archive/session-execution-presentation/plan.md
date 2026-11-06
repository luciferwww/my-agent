# Session Execution Presentation Plan

> Status: Accepted
> Date: 2026-11-03
> Owner: Project owner
> Classification: Architecture Slice
> Archived: 2026-11-06，owner 多轮人工测试后确认审核通过
> Stable authority: [Session architecture](../../../architecture/session.md), [Channels architecture](../../../architecture/channels.md), [Channel Specification](../../../specifications/channel.md), [Subagent Specification](../../../specifications/subagent.md)
> Authorization: 2026-11-03 owner 在独立复审后确认继续，分阶段实施消息身份关联与祖先留存，不自动 commit/push
> Specification: [Accepted Specification](specification.md)
> Decision: [Accepted ancestor presentation decision](decision.md)
> Validation: [阶段验证记录](validation.md)
> Input: [设计讨论草稿](../../../research/session-execution-presentation-design-draft.md)

## 1. Outcome

在父聊天中内嵌 Child 的实时执行过程，并在所有祖先 Transcript 中留存展示专用记录。每个 Session 可独立恢复自身及后代过程，不依赖临时 Child 文件仍然存在；展示内容不进入祖先模型 Context。

消息身份关联、祖先展示留存／History 投影／完整 Turn 累计分页、祖先实时投递、递归内嵌 UI 及工具分组已实现。2026-11-06 owner 确认经过多轮人工测试和修正，暂未发现还需修改的事项，人工审核通过；相关功能已按依赖拆分提交，文档完成收尾归档，不扩大实现范围。

## 2. Confirmed direction

- 订阅 Session 默认观察全部后代 chat 事件，无开关；保留真实来源，同连接去重，不修改显式订阅集合或控制权限。
- 后代展示记录在所有祖先 Transcript 各留存一次；不将收到的展示副本再次作为新事实传播。
- 复用 Child ID、现有 task／父子关联和消息更新机制，支持并发固定 slot 和递归内嵌。
- 同次 LLM call 的 Tool 分组是单独展示工作，不作为 Child 内嵌前置条件，不预设新增 invocation ID。
- 历史从最新 Turn 向前累计到目标条数，每次纳入完整本地 Turn 及其后代展示；允许输出超过请求值，游标落在 Turn 起点，不增加内部加载按钮。
- 已结束 Turn 继续整体接管；运行中用持久记录可选 messageId 关联实时消息，保留未提交内容。凡可能通过实时与 History 重复呈现的消息都必须贯穿身份，不按角色排除工具结果或 Host 展示消息。不改变 entry ID 或已有实时 message ID，不引入 message_committed 或独立映射表。
- 完成内嵌替代后移除 bundled client 的独立 Child 查看入口，不删除 Child 身份、生命周期或既有 History 能力。
- Child Approval 沿用现有通知和 approvalId 操作路径，调整卡片挂载；请求的 sessionId 是 Root 受众，Child turnId 与 callId 用于匹配内部调用。

## 3. Non-goals

不新增观察模式、第二条事件流、独立展示数据库、通用关联框架、Child 控制权限、Child 生命周期变更或智能工具摘要。不重构无关 Session、Provider、steering 或执行监督路径。

## 4. Delivery plan

| Item | Status | Work | Exit condition |
|---|---|---|---|
| SEP-0 Design | Completed | 结合源码收敛最小记录／History 契约、落盘与合并行为，处理独立审核结论 | owner 在独立复审后确认继续分阶段实现 |
| SEP-ID Message identity | Completed | messageId 持久关联、v3 升级、输入／steering／Assistant 身份贯穿、History 投影与客户端运行中合并 | 已实现；402 例聚焦回归、lint/build 通过；2026-11-06 owner 人工审核通过 |
| SEP-1 Persistence | Completed | 展示白名单、所有祖先留存、递归 Parent 接线、Context／分支隔离、History scopes、fork 与完整 Turn 累计分页 | 已实现；无订阅者也留存，Child 清理后可恢复，实际 Runtime／存储与 socket 聚焦验证通过；2026-11-06 owner 人工审核通过 |
| SEP-2 Observation | Completed | 复用委派路由、祖先 chat 投递、来源保留、连接去重、Root captured generation 与终态路由寿命 | 已实现；真实 socket、递归 Runtime 与 N→N+1 generation 验证通过；610 例相关回归、lint/build 通过；2026-11-06 owner 人工审核通过 |
| SEP-3 Client | Completed | 固定 slot、内嵌文本／Thinking／工具、完整 Turn 页接管、来源隔离合并、Approval 挂载与旧窗口替代 | 已实现；240 例聚焦测试、lint/build、真实 socket 历史恢复及挂载生产页面的受控浏览器验证通过；旧查看路径已移除；2026-11-06 owner 人工审核通过 |
| SEP-4 Tool grouping | Completed | 利用现有 LLM call 边界及真实 Assistant 的 llmRound 按调用分组，默认展开 | 已实现；685 例相关回归、lint/build、生产页面受控浏览器检查通过；重复 round 不合并，History 接管保留选择，后续折叠规则见 Specification；2026-11-06 owner 人工审核通过 |
| SEP-5 Validation and closeout | Completed | 聚焦、契约、集成、浏览器、lint/build、独立审核与权威文档同步 | 既有整体回归为单元 1692 例、集成 23 例通过；后续独立复审及修正、聚焦验证和限制见 Validation。2026-11-06 owner 确认多轮人工测试后审核通过；本轮仅按功能提交，无关治理和 Prompt 改动单独保留 |

实际依赖：SEP-ID、SEP-1、SEP-2 在 SEP-0 接受后开展；SEP-1 和 SEP-3 复用 SEP-ID 的消息关联基础，SEP-3 同时依赖祖先持久化与投递契约；SEP-4 复用基础展示数据但不是 SEP-1/2 的前置条件；SEP-5 汇总交付结果。表格不是逐项串行实现要求。

## 5. Design gate and authority

本变更改变现有订阅和展示持久化边界。[Accepted Decision](decision.md) 部分替代 [ADR-020](../../../decisions/adr-020-session-addressed-presentation-subscription-and-ephemeral-child-observation.md) 的后代独立观察／查看目标设计，保留显式 membership、只读 Child 和 TTL 所有权。当前已交付消息身份关联、祖先留存、祖先实时投递和递归内嵌；独立 Child 查看入口及其额外订阅已移除。研究草稿不作为权威覆盖依据。

实施前落实 Spec 中的记录／分页形状、持久化时机和失败行为，复用现有类型和链路；不因字段尚未设计就新增通用框架或要求无依据 Spike。

2026-11-03 已补充实施设计并独立审核。后续根据 owner 讨论将固定条数切页改成完整 Turn 累计分页，撤下 message_committed；保留最小 presentation 白名单、来源记录 ID 复用、祖先副本、v3、History items/scopes 和 Channel 路由元数据。该分页版本已独立复审，未发现新增设计 blocker。随后受控真实 socket 检查发现已有运行中重叠，见 Validation；owner 确认增加可选 messageId 关联，不改变两种已有 ID，不以 invocation ID 替代通用消息身份。新增关联设计也已独立复审，未发现阻塞项；owner 随后确认继续分阶段实现，SEP-0 完成，先进入 SEP-ID。

## 6. Review disposition

2026-11-03 独立 reviewer 对照当前实现，未发现方向性 blocker。接受其中 Approval 事实纠正：

- 实时 request 面向 Root Session 订阅者，并非全客户端广播；pending 集合查询是另一条恢复路径。
- Child request 使用 Root sessionId、Child turnId/callId，不能只按 sessionId 定位 Child。
- 审批提交继续使用 approvalId 和现有 Channel 授权，不新增 Parent 转发。
- 调用尚未加载时仍需可操作的 pending 入口，避免丢失审批或重复卡片。

核实依据：[RuntimeApp](../../../../src/runtime/RuntimeApp.ts)、[现有 Child Approval 断言](../../../../src/runtime/RuntimeApp.test.ts)。独立审核是设计证据，不代表完成 Delivery 验证。

具体实施设计的第二轮审核处理：

- 输入 messageId 与 entryId 缺少关联：曾随完整 Turn 分页撤下；后续时序验证表明运行中仍需关联，owner 已确认增加可选 messageId 字段，同时覆盖 Assistant，不恢复 message_committed 通知。
- 普通流异常被误称为已有 partial 保存：接受纠正，Spec 明确仅 abort 沿用已有边界，普通流异常未提交内容可能丢失。
- round 在 overflow 重试中可能重复：接受，按实际边界与持久消息身份分组，不将 round 作为唯一键。
- captured generation、递归 Child 的活动 Parent 登记、持久化错误不得被发送 catch 吞掉：保留为实现核对与测试事项，不以此引入新框架。

现有运行中合并的聚焦检查：既有文本前缀合并测试通过；进一步受控 socket 检查复现了首次打开的后缀重叠与重连时缺段重叠，并验证终态刷新后消重。测试未挂载完整 App 或使用真实 Provider，不据此宣称每次页面打开都会重复。详细顺序与限制见 [Validation](validation.md)。

完整 Turn 分页修订的第三轮独立审核：未发现实质性矛盾或新增设计 blocker。reviewer 核实了请求期间结束的 pending latest refresh／terminalTurnIds 补刷路径，确认较早运行中请求不会被追加终态清理标记。仍需实际连接验证运行中打开／重连及祖先／Child 扩展后的时序；整体接管须以子 scope 收敛和祖先写入完成为前提。此结论不是功能验证通过。

此后新增的 messageId 关联不属于上述审核覆盖范围；需核对输入／steering 传递、Assistant 首事件与正常／abort 落盘、祖先副本及 History 投影，并验证缺段与重复文本场景。该轮只更新设计，未修改生产逻辑。

本轮对照核实没有已确认的设计 blocker。曾以 sanitizeSessionTail 保留旧 JSONL 记录推测关联歧义，该疑虑撤回：尾部清理通过回退内存 leaf 排除失效消息，History 只返回有效消息链，文件残留本身不构成重复展示。身份贯穿完整生命周期、终态接管晚于后代收敛与祖先写入均作为实现验收要求，不再列为待决设计问题；此结论不替代新增关联设计的独立复审或功能验证。

新增消息关联的独立复审随后完成：未发现设计阻塞项或需要按严重性报告的确定性设计缺陷。复审确认下列事项属于实施／验收，不再作为开放的设计问题：

- 输入、steering、Assistant 首事件到正常／abort partial 落盘的身份贯穿；覆盖已有 Assistant 落盘后 overflow 重入，不将此与失效文件残留混为一谈。
- 按消息身份分段与合并；覆盖中途缺少 Thinking start、ABC＋BC／ABC＋AC、相同文字不同消息，以及旧快照返回时下一条未提交消息已经开始。
- Root／Child／Grandchild 来源隔离；正文接管后工具／审批继续更新；一个 toolResult 包含多个结果时不混淆消息与调用身份。
- 后代收敛／祖先写入完成之后才终态接管；v1/v2 兼容、首次 v3 写入与重载、旧 entry ID 不变且不补造 messageId。

此轮为只读设计复审，没有新增测试运行、生产修改或功能验收结论。

## 7. Validation

按 [Specification](specification.md) 的验收矩阵使用既有测试与工具。设计阶段先用 80 例现状测试核实行为；SEP-ID 的 402 例通过。SEP-1 扩大相关回归至 31 个文件 510 例通过，CLI 来源隔离另有 48 例通过；lint/build 通过，构建附带的 Relay 121 例通过。完整范围、环境警告及限制见 [Validation](validation.md)。各阶段结果不能代替内嵌 UI 或整体目标验收。保留用户原有工作区修改，不自动 commit/push。

2026-11-04 SEP-2：owner 要求继续且避免过度设计／扩大范围。本阶段只复用已有委派记录增加投递元数据，未增加执行树表、观察模式或控制权限，未修改 UI。35 个相关测试文件共 610 例、lint/build 和构建附带 Relay 121 例通过；祖先实时投递已实现，递归 UI 和整体目标验收仍未完成。

2026-11-04 SEP-5：按 owner 指定只清理 `test-workspace/sessions` 后执行整体回归。修复 intake 测试替身遗漏的新路由查询，并将 FIFO 断言补为严格核对原输入 messageId；固定 slot 测试扩为三个 Child 的交错文本／工具及不同完成顺序。使用命令隔离的 Node 22.23.3 解决本机 Node 20 与现有 SQLite 原生模块 ABI 不匹配，不切全局 Node，不改依赖清单。完整单元 1692 例、集成 23 例、lint/build 通过；fitness 四项已有漂移未扩范围修复。默认 test:all 会误纳入 Agent Home 的其他研究项目，不能将该次失败称为通过，后续使用已有三套配置明确测试边界。详见 Validation 第 10 节；当时独立实现复审与 owner 确认尚未完成。

## 8. Owner acceptance

2026-11-06 owner 确认：“做过多轮人工测试也修改过一些东西。暂时没发现还有什么需要改的。可以看成人工审核已过。”据此标记本 Change 的人工审核通过，不据此补写未执行的线上 Provider E2E。按 owner 授权分功能提交，不推送；无关治理调整及独立的原始 message／模型 User prompt 分离改动保留在工作区。

## 9. Closeout

2026-11-06 相关功能已分为五个提交：`afa69c0` 展示留存与路由、`99dffb2` 递归客户端与工具分组／审批卡组、`fd9b37e` Subagent 终态折叠修复、`ef15682` Aborted 徽标和 `111620f` 工具标题与操作摘要。最终提交快照的聚焦测试、类型检查和构建结果见 Validation §19。

本 Change 归档保存交付与验收来源；长期行为以现有架构文档和稳定契约为准。无关治理／fitness 和模型 User prompt 改动不纳入本次归档提交，原有未提交内容保留；未推送。
