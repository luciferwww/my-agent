# Async Tool Use Steering Projection Spike

> Status: Completed and Archived — bounded Provisional Pass accepted
> Date: 2026-09-30
> Accepted: 2026-10-02
> Archived: 2026-10-02
> Owner: Project owner
> Type: Architecture Spike
> Authorization: 项目所有者于 2026-09-30 明确要求“先 spike”，授权下述方案 A 的隔离离线原型与证据采集；不授权生产实现或真实 Provider 请求
> Authorization amendment: 同日项目所有者另行授权先验证 OpenAI Chat Completions 与 Responses 的真实请求，指定免 Key 的 `http://127.0.0.1:5000/v1/models` Relay，并选择两个协议均使用 `gpt-5.4`。本修订仅放开下述有界合成请求，不授权 Anthropic 实网或生产改造
> SiliconFlow amendment: 随后另行授权 `https://api.siliconflow.cn/v1` 的 Messages/Chat 对照，模型 `deepseek-ai/DeepSeek-V4-Flash`，最多 9 次生成、60 秒/请求，无自动重试；使用用户指定仓库外临时 Key 文件，仅脚本读取用于该域认证，不输出或保存 Key。仅合成数据，不授权 Anthropic 官方直连或生产改造
> GLM follow-up: 项目所有者随后要求试 `zai-org/GLM-5.3`；同端点、同临时认证来源、同合成场景，两个协议各启动/NOTE/进度/完成四次，最多 8 次生成，60 秒/请求，不重试、不重复负例。回答质量另列观察，不作为本轮机制验收条件
> Direct-append follow-up: 项目所有者随后授权三个协议直接保留未配对调用追加 steering：Relay gpt-5.4 Chat/Responses，SiliconFlow GLM-5.3 Messages。每协议新启动一次、未配对 steering 一次、若成功则按原始时序追加结果一次，合计至多 9 次生成，60 秒/请求，无重试。此为方案 A 之外的直接追加对照；不得隐藏调用、补假结果或重排消息。Messages 仍非 Anthropic 官方直连
> Controlled follow-up: 用户进一步质疑参数并要求完成 pending steering 实测；补做 Relay 两协议各一组未配对/仅添加真实结果的对照，共 4 次、60 秒/请求，无重试，排除响应专用字段回传等干扰。使用已有合成启动响应构造 fixture，不重复请求启动
> Host-notification follow-up: 项目所有者要求证明“提交调用返回 accepted+taskId；期间正常 steering；后台完成后宿主追加普通完成通知并主动续调模型”是否可用，或取得其他 Agent 同类完整链路。Relay gpt-5.4 Chat/Responses 各启动、steering、完成通知三次，共 6 次、60 秒/请求，无重试。通知明确标注 trusted host lifecycle source，不伪装为原 tool_result；另做公开源码端到端调研
> Unified Messages follow-up: 项目所有者要求统一机制以避免 `runAttempt` 按协议分支；追加 SiliconFlow GLM-5.3 Messages 同形态验证，启动、accepted 后 steering、普通完成通知各一次，共 3 次、60 秒/请求，无重试。Messages wire 仅由适配器将 accepted tool_result 与当次 steering text 放在同一条合法 user message 中；Runner 候选契约仍是统一的 accepted/steering/completion 事件
> State record: 本轮按上述有界授权建立 Accepted Spec 后进入 Executing；方案 A 取证后转向统一 accepted + Host completion，并取得跨协议有界证据。项目所有者确认已有可行方案并要求继续正式化，随后于 2026-10-02 接受该有界证据及最终 Delivery；原方案 A 未完成矩阵仍按 Results 记录，不补写为已验证
> Decision unlocked: [统一 Async Tool Use 草稿](../../../research/async-tool-use-design-draft.md) D1 的上下文投影方案是否值得继续设计

## Decision question

保留原 Tool Call pending 并最终只交付一次真实结果时，能否用合法的临时控制上下文处理连续 steering、保留运行或请求取消，并在完成后构造配对完整且有时序说明的历史投影？

本实验不决定最终生产存储格式，也不把 mock 模型的配合解释为真实 LLM 一定理解投影语义。

范围澄清（2026-09-30）：项目所有者指出，本轮要验证 pending 工具期间的 steering 回复与完成后的协议续调，而非合成业务的模型理解能力。实网中报数、提醒措辞及内部标记回显作为补充观察，不单独用来判定机制失败；事实记录完整、无重复执行、无伪造工具终态及配对要求保持不变。

## Falsifiable hypothesis

在受控异步 fixture 和可序列化事实记录上，不修改生产 Runner/Session/Provider，可以同时满足：

- pending Tool 不阻止 steering 控制调用；一次 Parent 模型调用串行执行。
- 控制上下文不含未闭合调用组，不伪造 running/accepted 终态；只提供执行状态和已知业务事实，不注入 Child delta。
- 提醒/询问保持执行；转向通过独立控制动作取消，不排在普通 Tool 后。
- 最终真实结果按原 call ID 配对；期间 steering/回复保留且标明发生在执行期间；原始记录顺序不被投影改写。
- 同一 assistant 多调用、完成/取消竞态、迟到结果以及快照重载不能造成缺失或重复配对。

任何条件失败，都应记录并收窄或否定假设，不通过删除场景、静默丢弃消息或将部分结果冒充全部结果来通过。

## Scope and non-goals

- 仅新增隔离原型与测试到 `scripts/spikes/async-tool-use/`，不接入生产导出或执行路径，不修改依赖清单。
- 原型可使用现有公开消息类型和 Provider 编码器，测试需观测真实编码请求体，不仅检查自造对象或源码字符串。
- 生产 Tool Result 类型和四态 Change 保持不变；原型事实记录可表达实际成功、取消和未启动，不引入生产状态迁移。
- 离线部分使用受控 deferred Tool、scripted model 和 mock transport；补充实网仅使用上述分别授权的 Relay/SiliconFlow 模型和合成 fixture。请求可能计费；不执行真实业务工具、进程强杀或同步死循环。
- 不实现 launch/collect、后台脱离、任务恢复执行、通用 worker 隔离、完整生产 admission 或 Child 并发。
- 不决定自动超时政策；本次只用可协作取消及不合作 Promise 的有界观察验证投影闸门，不承诺强制停止。

## Method

1. 建立显式有序事实记录，区分原调用组、执行结果、steering 和控制回复；候选形状仅为原型，不是 Session schema。
2. 构造最小合法历史前缀、一个延迟 Tool，以及连续 NOTE/进度询问。scripted model 返回受限 reply/keep/cancel 动作；无普通业务工具可用。
3. 在 Tool 未完成时实际调用原型控制流程，验证操作可完成且 Tool 未被取消。暂停的控制回复期间令 Tool 完成以检查快照一致性。
4. 对转向、Root Abort、已完成后取消、重复晚结果、多 call 串行/未启动进行故障注入，记录模型调用数、活动刷新、取消次数、结果数和事实序号。
5. 序列化/重载事实记录，比较控制与最终投影；模拟缺失结果须显式 unknown/拒绝续调，不自动恢复或重放副作用。
6. 优先通过 Chat Completions 和 Responses 两个现有编码器与 mock transport 捕获请求体，独立断言无悬空/重复工具配对。Anthropic/Relay 专用编码器若已完成则保留为额外离线证据，不作为本阶段阻塞条件；Anthropic 检查紧邻及一组结果完整，不从本地编码推断上游接受。
7. 用现有 Vitest 跑目标文件；用聚焦 TypeScript no-emit 检查原型；文档运行治理测试、本地链接、空白检查。
8. 优先实测 Relay 的 `/v1/chat/completions` 和 `/v1/responses`，两个协议均使用 `gpt-5.4`。通过真实模型产生原始调用，再在受控工具 pending 时发送 NOTE/进度控制投影，并在工具完成后发送完整合并投影；分别记录 HTTP/流终态、真实调用次数、配对、保留提醒及是否编造进度/颠倒时序。不得把脚本指定答案或本地编码成功替代真实回复观察。
9. 实网每个请求至多 90 秒，两个协议合计至多 12 次生成请求，不自动无限重试；失败显式记录。仅发送合成任务、合成执行状态和模型自己的回复，使用同一原型投影；不上传仓库内容、真实会话或凭据。不得触发模型提出的真实工具副作用。实网脚本必须显式运行，不放入默认测试自动调用。
10. SiliconFlow 使用独立预算：一次目录检查，两个协议各启动/NOTE/进度/最终四次，加一次 Messages 配对负例，至多 9 次生成。优先使用现有两个客户端与同一原型；测试 transport 仅按服务商文档加 Bearer 认证，不隐式修改消息或 SSE。捕获响应以区分 HTTP 接受、流式解码和模型语义；失败停止该场景、不伪装为通过。API Key 只能发往指定 HTTPS origin，不跟随重定向，不进日志；负例拒绝或接受仅代表该服务行为，不替代官方规范。

执行偏差记录：完整原型未及时返回证据，先运行独立 raw HTTP smoke（两个协议各 3 次请求，单请求 60 秒，无重试），不使用生产编码器，且将 NOTE/进度合在一次 steering 中。该结果单列为更窄证据，不能替代 AP-8/AP-10 或降低原验收要求；详情见 Results。

后续执行记录：后台任务取消后直接接手遗留原型，通过现有两个 Provider 客户端完成各两次独立 steering 和最终续调；每协议复用前轮真实启动响应，共再发 6 次生成请求，累计 12 次预算用尽。本地取消/竞态四项通过，恢复/完整矩阵尚未完成，不能据此将整个 Spike 标记通过。未修改生产代码。

初始终端为 Node v20.16.0，项目要求 Node 22。尽量使用已有 Node 22 环境；若本机无可用解释器，则记录环境限制，不以 Node 20 结果宣称目标环境已验证，不擅自升级共享环境。

## Required evidence

| ID | Scenario | Required observation |
|---|---|---|
| AP-1 | 单 Tool + 两条连续 NOTE/进度询问 | Tool 未完成时两个控制回合完成，无取消/重复执行；无 Child 正文；合法控制投影 |
| AP-2 | Tool 完成后合并 | 原 callId 一个真实结果；两条输入/回复各一次，带执行期间时序说明；原始事实顺序保持 |
| AP-3 | 明确转向 | 独立取消到达当前执行，收敛前不推进新路线；父 Turn 不因单调用取消而自动 abort |
| AP-4 | 多 call 同 assistant | 普通调用串行；续主历史前整组闭合，未启动调用明确 not_executed；不漏配对 |
| AP-5 | 竞态 | 控制回合中完成、完成后取消、重复结果、Root Abort 不覆盖真实终态；控制模型不并发 |
| AP-6 | 不合作 Tool | 请求取消后仍 pending，不能生成成功/aborted 假终态或开放完成闸门；fixture 最后由测试主动释放 |
| AP-7 | 重载及失败 | JSON round-trip 投影等价；缺失/矛盾记录显式阻断；不重放执行 |
| AP-8 | 实际请求编码 | 优先 Chat、Responses 的控制/最终请求体配对完整、无 accepted 伪终态或同 ID 双结果；Anthropic/Relay 专用编码额外证据单列 |
| AP-9 | 局限与复杂度 | 明确临时投影相对现有历史/repair/compaction 的新增成本，以及哪些场景原型未覆盖 |
| AP-10 | 已授权 Relay 实网 | 同一 `gpt-5.4` 的 Chat/Responses 两协议完成受控调用、期间两条 steering 和真实结果后的续调；分别记录服务接受与模型语义观察，失败不被 mock 成绩覆盖 |
| AP-11 | SiliconFlow 协议对照 | 同一 DeepSeek 模型的 Messages/Chat 合法投影与一次 Messages 配对负例，分别记录编码、服务端、解码和语义结果，不推断官方 Anthropic 完全兼容 |

## Success, failure, and stop conditions

- 全部离线证据满足可标记 Provisional Pass；仅说明候选投影可构造。AP-10 单独记录实网结果，最多证明当前 Relay/模型/fixture 的有限行为，不外推 OpenAI 官方直连、Anthropic、生产恢复或强取消。
- 无法在合理局部原型内保持消息完整、时序可解释与一次真实结果时，记录 Failed 或 Inconclusive，不自动切换生产设计。
- 需要修改生产契约、访问凭据、超出上述端点/模型/请求上限、安装新工具或扩大为执行隔离时停止相关实验并请求批准。
- 已有工作树改动不属于本 Spike，不覆盖或归因到本实验。

## Constraints and safety

不读取真实会话或无关认证信息；仅 SiliconFlow 显式脚本可读取用户指定临时 Key 用于指定域认证。fixture 使用合成任务文本。离线测试网络由替身接管；实网仅使用上述显式授权端点，不得把仓库内容发送给第三方。

原型无服务监听，无真实子进程/长期后台任务。测试清理计时器、监听和 mock transport，所有受控 Promise 在结束时释放。可复用原型保留为实验产物，不留临时输出或生成构建文件。

## Deliverables

- 本 Spec、隔离原型与测试、实际执行后的 [Results](spike-results.md)。
- 更新研究草稿和索引，注明证据与未验证范围；Results 不授权选择方案 A 为生产实现。
- 项目所有者确认结果后再决定后续 Spike 或正式 Plan/ADR/Spec，不自动进入 Delivery。

Process authority: [Development Workflow](../../../governance/development-workflow.md).
