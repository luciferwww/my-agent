# Thinking Capture and Display Plan

> Status: Archived — completed and owner-accepted
> Date: 2026-10-02
> Owner: Project owner
> Classification: Architecture Slice
> Authorization: 所有者于2026-10-02确认验收并归档
> Current phase: Chat Completions / Responses；Anthropic按所有者2026-09-30后续指示暂缓

## 1. 目标与范围确认

让用户实时和历史查看上游返回的可读Thinking，同时不破坏模型工具续轮、不向用户History或日志暴露opaque replay state。

初始范围曾同时包含Anthropic完整Thinking块及OpenAI Responses完成reasoning item；该范围已被2026-09-30后续决定取代。当前阶段只解决Chat Completions与Responses，Anthropic暂缓，保留前期研究但不作为当前阶段验收阻塞。不提供Thinking生成开关，不复制完整账户/Replay管理框架。所有者授权读取本地5000端口网关目录并挑选不同协议模型验证；不是生产Delivery批准。

- [Specification（Validated and Archived）](thinking-capture-and-display-specification.md)
- [验证与Gate记录](validation.md)
- [研究与本地Spike](../../../research/thinking-capture-and-display-design-draft.md)
- [流程权威](../../../governance/development-workflow.md)

## 2. 交付范围

- 当前阶段：Built-in Chat Completions、Responses及Copilot Relay原生Responses的Thinking采集；本地网关的Chat Completions通过对应Client验证，不假定现有Relay扩展已实现Chat Client。
- 带调用与块身份的生命周期、无损内容顺序和完成状态。
- 当前阶段另含已实测的网关Chat assistant级reasoning_text/reasoning_opaque，不能把Chat一律降为display-only。
- Anthropic thinking/signature及redacted/data及其严格prefix恢复方案暂缓，后续单独恢复验收。
- Responses完成reasoning item的保存与回放，包括实际返回的id、summary、encrypted_content；不伪造未返回字段。
- Internal Transcript、Provider请求投影、Presentation三层分离；安全投影覆盖History、run_end、Runtime终态事件及返回值。
- Web实时展开/自动折叠、历史默认折叠且可展开；CLI区分Thinking与正文。
- 与上述路径直接相关的Abort、Session恢复、Compaction、预算及协议错误处理。

## 3. 非目标

- 生成开关、effort/budget设置及模型选择UI。
- 本地Ollama＋deepseek-r1:7b实测返回的正文`<think>`标签解析（来源见[Spec §7.6](thinking-capture-and-display-specification.md#76-真实验证路径澄清)）；所有者确认继续沿用普通消息文本增量，不转换为结构化Thinking。
- 任意跨模型/账户可移植性承诺、完整账户注册表或通用Replay Registry。
- previous_response_id缓存、服务端conversation管理、Provider server-side compaction。
- 持久化Thinking耗时、补造旧记录的Thinking、Markdown/pin等展示增强。
- Subagent执行模型、Tool Result状态持久化等独立草稿的实施。
- 未经确认改变store、数据保留策略或用户配置。

## 4. 阶段与Gate

| Plan Item | 状态 | 工作 | 退出条件 |
|---|---|---|---|
| TCD-1 设计与证据闭合 | Done | 已完成离线测试、真实网关受控证据及D1/D2收敛；实现中进一步确认Client/Provider边界 | 当前阶段契约与实现一致 |
| TCD-2 Core与Provider | Implemented | 采集、保序组装、Provider-owned replay envelope、协议回放及来源检查 | 聚焦契约测试通过；协议字段不离开Client/Provider |
| TCD-3 History与Channel | Implemented | Transcript v2、安全History/RunResult投影、Web/CLI生命周期及历史恢复 | 可读内容恢复、opaque无泄露、跨调用ID及Abort行为通过 |
| TCD-4 集成与验收 | Completed | 恢复、Compaction、预算、目标路由验证、文档同步 | G1通过，所有者已验收并归档 |

### G0：进入实现前

必须闭合以下边界，不为每项额外创建Change：

1. **最小契约**：接受Spec §4–6的强类型、事件、来源、v2升级、公共结果安全投影及错误白名单；Core不导入Provider SDK。
2. **恢复范围**：接受§7单一工具结果owner及恢复矩阵，评审D1受控Spike的有限支持范围。保守原则已获认可，不以modelId变化直接拒绝。Anthropic严格prefix暂缓，不强加全会话append-only或system/tools快照。
3. **Relay证据**：5000端口完整item/opaque回传及工具续轮已有真实样本；不推广到其他网关/模型。生产Client/Session接线在Delivery的G1验证，不能要求先实施再倒签G0。
4. **请求与预算策略**：本期保持store/include/服务端关联参数不变，被动采集实际状态；完整replay使Core预算路由标记为`unavailable`，不冒充预算通过，也不因不确定性默认停止；允许一次带安全warning的上游裁决，明确overflow后复用既有有界Compaction并最多重试一次。
5. **评审与批准**：评审D1实测、D2外部实现对照及完整契约并批准进入Delivery；目前变更均由本Spec承载，未选择另建Replay平台或独立ADR。若评审产生超出本Change的长期架构决定，再补相应ADR。

### G1：交付验收

- Specification验收矩阵全部通过，或明确列出由所有者接受的支持限制；不得有未解释Blocker。
- 最小测试随各实质代码修改运行；跨边界集成、Fitness、lint、build在最终Gate执行。
- 独立评审已处理；当前架构/稳定契约/Extension导出与测试清单完成同步。
- 将Spike表征断言替换为目标行为测试；不让“丢数据”成为永久验收条件。
- 真实验证使用无敏感信息的合成任务和无副作用工具；连接与费用预算须在执行前确认。
- Anthropic专项验收标为Deferred，不冒充通过，也不阻止当前两协议形成可单独验收的阶段。

## 5. 风险及停止条件

- 必需签名或item丢失：明确失败，不补空字段、不自动删块伪装成功。
- 来源、prefix或网关行为推翻设计：暂停受影响实现，记录证据与取舍后重新确认。
- 多协议原始状态使契约超出两个已知协议所需：缩减到具体需求，不搭建可插拔Replay平台。
- 历史研究与本Change冲突：以本Change当前状态及已接受权威为准；研究不能授权生产修改。

## 6. 当前结论

当前阶段Delivery已完成并由所有者于2026-10-02确认验收归档。实现保持最小：Session唯一确定工具结果并返回已持久化记录；Transcript升级v2，公开运行结果与History采用同一安全展示边界。协议差异由Client/Provider封装为Provider-owned replay envelope，Core预算仅增加`unavailable`路由，不引入通用Replay Registry或新的Provider检查框架。Chat opaque采用单个完整值的保守支持策略，重复明确失败；竞品依据不是正式协议规范。

后续所有者认可[Spec §11](thinking-capture-and-display-specification.md#11-remaining-decisions-before-acceptance)的D1保守原则，但明确要求Spike。本轮新增受控实测12次：两组同协议切模型均成功；删除opaque两协议都成功；破坏密文时Responses为400而Chat仍成功。不能据此建立“换模型就失败”或“删状态必失败”规则，也不证明推理等价。

2026-10-02补充Claude Code/Agent SDK、OpenAI Codex CLI、OpenAI Agents SDK、OpenClaw和OpenCode公开实现对照后，D2按所有者“正常运行优先”方向收敛：无法可靠计量opaque时显式标记unavailable并允许一次上游裁决，不使用通用密文长度估算，不无限重试，不破坏活动工具链。

最终完整Unit套件、项目及Extension类型检查、Host build audit和Relay验证均通过；浏览器组件级验收覆盖实时折叠、历史默认折叠、partial收敛及Thinking纯文本防注入。未自动增加真实计费请求。
