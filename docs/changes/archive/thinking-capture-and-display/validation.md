# Thinking Capture and Display Validation

> Status: Accepted and Archived
> Date: 2026-10-02
> Authority: Evidence and gate tracking only
> Related: [Plan](plan.md), [Specification（Validated and Archived）](thinking-capture-and-display-specification.md)

## 1. 已有输入证据

下表复用2026-09-30立项前的执行记录，不表示创建Change时重新运行了代码测试。

| 证据 | 已观察结果 | 不能据此证明 |
|---|---|---|
| [本地Spike](../../../../extensions/copilot-relay-provider/thinking-replay.spike.test.ts) | 7/7通过；Anthropic丢thinking/signature/redacted；两个Responses Client丢reasoning；新Client后仍手工重建不含reasoning的history | 真实上游接受性、签名有效性、磁盘Session恢复 |
| 相关既有测试 | Built-in protocol clients、BuiltinLlmProvider、Relay responses-client共45/45通过 | 目标Thinking契约已实现 |
| Extension类型检查 | `npm run lint --workspace @my-agent/copilot-relay-provider`通过 | 全仓库类型检查通过 |
| 根类型检查 | `npx tsc --noEmit`报告既有[AgentRunner.test.ts](../../../../src/core/runner/AgentRunner.test.ts)缺少ChatMessage导入 | 不应为本Change自动修复独立Subagent测试 |
| [官方与竞品复核](../../../research/thinking-capture-and-display-design-draft.md#173-官方资料复核确认与纠正) | 当前Tool loop完整回放；Responses summary是合法item字段；返回reasoning item不应主动丢弃 | 所有模型/网关都采用相同服务端校验 |

Spike是当前行为表征，不是未来回归目标；实现时替换丢数据断言并保留可追溯结果。

## 2. Gate状态

| 项目 | 状态 | 下一步证据 |
|---|---|---|
| 范围确认与Change创建 | 已确认；当前阶段收敛为Chat/Responses | 所有者同日后续明确Anthropic先不处理 |
| Anthropic当前Tool loop保留范围 | Deferred | 保留官方依据；签名/prefix专项不阻塞当前两协议阶段 |
| 本地Client实际请求模式 | 已确认 | store省略不是false；保留后重新验证body |
| 完成item/来源/partial强类型 | 已实现并通过聚焦及全量回归 | Spec §4–6；含单值Chat opaque、Provider-owned replay envelope、v2格式与公开结果投影 |
| 恢复与Compaction矩阵 | 单一owner、v2恢复、Fork及unavailable路由已实现；D1原则认可并补实测 | Spec §7.8；两组同协议切模型成功，未知范围保守停止；不推广为账户/网关通则 |
| Provider约束与预算入口 | Client发送路径执行来源/codec校验；Context增加unavailable路由 | D2按正常运行优先实现最小有界上游裁决；未引入通用inspectInput框架或opaque估算 |
| 指定网关原生回放 | 两个模型的完整原生history续轮通过；生产Client/Session已接线 | 见§7；其他模型和来源兼容性不作推广 |
| 指定Ollama本地验证 | 路由可达，能力不足 | deepseek-r1:7b仅completion；thinking/tools均400，无签名或encrypted reasoning item |
| Delivery与最终接受 | Delivery已完成；所有者于2026-10-02确认验收 | 已归档 |

## 3. 真实验证边界

立项及前两轮本地Spike没有读取真实凭证或调用模型服务。随后所有者授权的Ollama探测见§6，再授权的5000端口网关验证见§7；仅发送合成输入，未读取本地凭证。网关目录提示usage-based billing，本轮有真实模型调用，不能沿用“未调用上游”的早期结论。后续须明确：

- Anthropic完整当前Tool loop对照缺块路径；
- OpenAI当前store省略模式与显式false模式分别验证，未经确认不修改产品默认存储策略；
- Relay当前模式单独验证，不由OpenAI结果代替；
- 仅发送合成输入；不使用生产会话内容；记录接受性、结构化错误和已知限制，不声称单个HTTP 200证明质量等价。

## 4. G0追加核实（2026-09-30）

### 源码依据

- [Runtime用户输入与System构建](../../../../src/runtime/RuntimeApp.ts)：已准备的user内容进入Runner；system按Turn构建。
- [Runner](../../../../src/core/runner/AgentRunner.ts)：保存user/assistant/toolResult，内存工具结果与Session持久化相互独立；循环内另有prune，重载历史另有Compaction摘要注入。
- [SessionManager](../../../../src/core/session/SessionManager.ts)及[bootstrap](../../../../src/runtime/bootstrap.ts)：head/tail上限由配置传入，落盘时可截短工具结果；该上限传入不取决于Compaction enabled。
- [Transcript类型](../../../../src/core/session/types.ts)与[加载器](../../../../src/core/session/transcript.ts)：没有调用级实际system/tools及Thinking来源；version 1有限结构校验不等于新块校验。
- [工具结果裁剪](../../../../src/core/runner/context/tool-result-pruning.ts)、[预算](../../../../src/core/runner/context/context-budget.ts)和[估算](../../../../src/core/runner/context/token-estimation.ts)：投影可随输入预算改变；新未知块当前默认估算为0，目标实现需避免延续该路径。
- [Extension API](../../../../src/extension/api/index.ts)已有Core调用类型出口；不需要新增平行Extension协议。

### 官方依据复核

- [Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)：前缀规则不是全模型通则；适用路径检查system/tools及消息内容，还约束保留Thinking序列的连续性。账户和模型可读性另有规则，不以Session/进程身份代替。
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls)：部分模型具有跨Turn推理保留默认行为；因此“新user出现就统一删除旧reasoning”不是安全通则。本Change不因此新增生成或context控制。
- [固定版本reasoning输入类型](https://github.com/openai/openai-python/blob/58aca1dcfd8d04a3c6352fa2c34b3035ea850f57/src/openai/types/responses/response_reasoning_item_param.py)：明确summary、可选content/status及encrypted_content的缺省/null形态；具体字段已进入Spec候选。
- 未读取用户凭证或实际会话内容，未调用真实模型；官方文档不证明任意兼容网关行为。

### 本地新增3项表征

继续使用[同一Spike文件](../../../../extensions/copilot-relay-provider/thinking-replay.spike.test.ts)，真实SessionManager写入临时目录，再通过新SessionManager读取，使用真实Anthropic Client与注入的fake fetch捕获body：

| 对照 | 已观察结果 |
|---|---|
| 无落盘截短，固定system/tools/预算 | 当前内存、已保存内容及新实例磁盘加载的3个请求body相等 |
| 有落盘截短，同样固定system/tools/预算 | 原624字符工具结果在磁盘保存为16字符头部＋8字符尾部＋标记；当前内存请求与后两次请求不同，后两者相等 |
| 相同历史，输入预算从10000降至200 | prune改写工具结果投影，原输入对象保持不变 |

这是组件组合表征，不是完整Runtime重启测试。测试fixture没有回放真实签名，也未跑目标Thinking实现；只证实恢复前缀的本地差异。临时目录由测试finally清理。

执行结果：

- `npx vitest run --config vitest.unit.config.ts extensions/copilot-relay-provider/thinking-replay.spike.test.ts`：**10/10通过**（原7项＋新增3项）。
- `npm run lint --workspace @my-agent/copilot-relay-provider`：通过。
- 首次验证仅发现原7项；定位并修正新增describe的作用域后，重新执行明确发现并通过10项，不以原7项结果代替新增覆盖。
- 本轮未重跑根lint/全量Unit/Integration/Build；§1中的45/45及根类型诊断为此前记录，不是本轮重新认证。

结论：内容候选和条件式矩阵已补充，但恢复机制、Provider约束入口及真实路由仍未闭合，G0不通过；不据此批准快照机制或功能降级。

## 5. 目标方案Spike（2026-09-30）

### 授权与实现边界

所有者批准先执行“具体设计＋本地目标方案验证”，未批准生产Delivery。新增：

- [测试专用原型](../../../../extensions/copilot-relay-provider/thinking-recovery-prototype.spike.ts)：单写入者JSONL、一次有效工具结果、一次system/tools上下文、局部保护摘要、prepare与发送分离。
- [目标方案测试](../../../../extensions/copilot-relay-provider/thinking-recovery.spike.test.ts)：合成完整块，无真实模型生成；复用现有prune函数，并以现有Client对照普通消息投影。

原型不被生产入口引用，也不使用真实账户、用户会话、工具执行或网络。预算oracle固定返回100，仅验证控制流和阈值，不冒充真实token估算。严格append-only约束在两个编码模式下使用，是实验假设，不是Responses通用规则。

### 25项测试结果

| 组 | 数量 | 观察结果 |
|---|---|---|
| Anthropic / Responses两轮工具续轮与磁盘重载 | 2 | 完整块保序；624字符结果只截短一次，短结果不变；重载后降低预算参数仍重建相同请求；6条JSONL记录只存一次system/tools |
| System、工具schema、来源、wire协议变化 | 4 | 显式context_changed，零次发送，磁盘不变；不以旧配置偷偷覆盖新配置 |
| 旧工具结果改写、Thinking中间缺口、保留suffix/清空旧链的Compaction候选 | 4 | prefix_changed先于预算和发送；不修改原记录 |
| 追加新user、等值工具schema key顺序 | 2 | 保留旧准备文本；等值对象不被误判为变化 |
| 预算100/99边界 | 1 | 100允许，99阻止；不裁剪受保护内容或改盘 |
| 缺签名、不完整item、磁盘旧输入变化 | 3 | 重新加载时显式invalid_record或prefix_changed |
| 写入失败 | 1 | 内存消息不前进，错误不被吞掉 |
| encrypted_content缺省/null及完整可选字段 | 2 | 缺省、null、summary、content、status保持原形 |
| 未受保护Compaction候选预览 | 1 | 可准备候选，不发送或提交；不等于完整Compaction通过 |
| 跨协议opaque块 | 1 | 明确拒绝，不写入错误块 |
| 当前Session cap接线反例 | 1 | 已有截短标记的结果仍会再次被截短；生产不能直接叠加两个normalizer |
| 普通消息与真实Anthropic / Responses / Relay Client请求对照 | 3 | 排除stream/output-limit传输参数后，字段精确相等；不证明新增Thinking已接入生产Client |

验证命令：

- `npx vitest run --config vitest.unit.config.ts extensions/copilot-relay-provider/thinking-recovery.spike.test.ts extensions/copilot-relay-provider/thinking-replay.spike.test.ts`：35/35通过（25项新测试＋原10项）。
- `npm run lint --workspace @my-agent/copilot-relay-provider`：通过。

### 可以与不能得出的结论

- 可以：在同一合成来源、固定投影、完整单写入者文件下，一份有效消息＋一次实际system/tools足以重建本原型请求；不必每轮保存整份history/body。配置和前缀冲突可以在预算/发送前识别。
- 不可以：真实签名有效、模型真正读取推理、任意换模型/账户兼容、全Runtime重启/崩溃事务、生产Compaction继续策略、媒体/Fork/partial完整接线均未得到证明。
- 本地摘要用于漂移检测，不是签名校验、账户证明或抗恶意篡改机制；原型JSONL、wire-oriented块和版本号不直接成为Core公共契约。
- 原型在冲突时停止，证明“不会静默错误发送”，但不能据此把永久禁止配置变化或Compaction作为已接受产品行为。

### 从Spec移出的原型设计说明

候选A以单个JSONL保存一条上下文记录（来源及实际system/tools）和顺序消息，assistant附固定长度的本地摘要；没有每轮复制完整body。`prepare`检查配置/受保护前缀和预算，不改盘、不发送；`send`只使用已提交消息，不发送尚未提交的Compaction候选。摘要仅用于检测内容/顺序漂移，不能恢复丢失数据，也不是账户或服务端签名证明。

这些严格prefix约束保留为Deferred Anthropic方向的实验，不成为本期Chat/Responses的默认持久化结构。本期Spec改为提议保留Session现有cap作为唯一owner，并将其已持久化有效内容返回Runner；这与原型先prune的实验接线不同，不能把25项原型测试算作新owner方案已通过。

## 6. 所有者指定的Ollama真实探测

所有者说明Relay模型的原生路径是Responses/Completions，转换为Anthropic会忽略Thinking；本轮按此澄清验证范围，未连接Relay独立复核。真实请求改用其指定的本地Ollama＋deepseek-r1:7b，要求简单提示。

环境只读查询：`http://127.0.0.1:11434`，Ollama **0.20.7**；已安装`deepseek-r1:7b`，约4.68GB，元数据family=qwen2、7.6B，仅声明`completion`。未读取凭证、下载模型或发送项目内容。

| 请求 | 限制与耗时 | 实际结果 |
|---|---|---|
| Chat Completions：`What is 1+1? Answer briefly.` | max_tokens=96，约12.87秒 | 200；正文为未闭合`<think>`文本，finish_reason=length；无独立Thinking字段 |
| Native `/api/chat`显式think=true：`Reply exactly: OK.` | num_predict=32，约0.07秒 | 400，模型不支持thinking |
| Chat Completions带无副作用fixture工具 | max_tokens=32，约0.07秒 | 400，模型不支持tools；未执行任何工具 |
| `/v1/responses`：`Reply exactly: OK.` | max_output_tokens=32，约4.36秒 | 200；只有message/output_text中的`<think>`文本，reasoning=null，无reasoning item/ciphertext |
| `/v1/messages`：同一短提示 | max_tokens=32，约4.41秒 | 200；只有text块，stop_reason=max_tokens，无thinking/signature/redacted块 |

- 5个模型请求串行执行，其中3个发生生成，共报告160个输出token；两次能力拒绝没有生成。不扩大输出预算以追求完整回答。
- Responses响应报告status=completed且输出32 token，但正文仍为未闭合标签；不能把该状态或HTTP 200当成Thinking完整性证据。
- Responses请求未传store，Ollama响应报告store=false；这只是本次本地兼容端点的元数据，不推广为官方OpenAI或Relay默认，也未验证服务端存储语义。
- 这些是非流式路由/能力探测，不是SSE或工具续轮实验。正文标签不能替代结构化协议字段；没有为此修改Client去解析`<think>`。
- **结论：指定模型不能闭合签名、encrypted reasoning或真实工具续轮Gate。** 不自动切换模型、拉取大模型或使用付费连接；需要另行明确具备相应能力的测试来源。

## 7. 5000端口网关目录与原生协议验证

### 范围及模型目录

所有者指定`http://127.0.0.1:5000/v1/models`、允许选不同协议模型验证，并明确暂缓Anthropic。2026-09-30读取39条记录，按声明的HTTP端点分组如下；未声明不能解释成不支持，声明也不是实测认证。

| HTTP端点声明 | 数量 | 模型ID |
|---|---|---|
| 仅/chat/completions | 5 | gemini-3.5-flash、gemini-3.6-flash、gemini-3.7-flash、gemini-3.8-flash、trajectory-compaction |
| 仅/responses | 15 | gpt-5.3-codex、gpt-5.4-mini、gpt-5.5、gpt-5.6-luna、gpt-5.6-sol-fast、gpt-5.6-sol、gpt-5.6-terra、gpt-6.1-sol、gpt-6-astra、gpt-6-luna、gpt-6-sol、grok-4.5、grok-4.6、grok-4.7、mai-code-1.1-flash |
| 两种HTTP端点均声明 | 2 | gpt-5.4、gpt-5-mini |
| 未声明端点 | 17 | gpt-4o-mini-2024-07-18、gpt-4o-2024-11-20、gpt-4o-2024-08-06、text-embedding-3-small、text-embedding-3-small-inference、gpt-4.1-2025-04-14、gpt-3.5-turbo-0613、gpt-4、gpt-4-0613、gpt-4-0125-preview、gpt-4o-2024-05-13、gpt-4-o-preview、gpt-4.1、gpt-3.5-turbo、gpt-4o-mini、gpt-4o、text-embedding-ada-002 |

另有14项声明`ws:/responses`，本轮只测HTTP。所选gemini-3.5-flash、gpt-5.4-mini均声明streaming/tool_calls，policy=enabled，支持low reasoning effort。

### 请求与结果

仅发送短合成提示；fixture_value工具只返回输入整数，不读文件、不联网、不执行Shell。两次调用参数依次为n=1、n=2，然后要求回答和。所有请求串行，单请求输出上限512，实验显式effort=low；不改变产品生成默认值。每次续轮从实验JSON文件读完整history，不使用previous_response_id或服务端conversation。

| 实验 | 请求数 | 结果 |
|---|---|---|
| Gemini Chat非流式两轮工具＋最终回答 | 3 | tool_calls → tool_calls → stop，最终3；原assistant消息整体回传 |
| GPT Responses非流式两轮工具＋最终回答 | 3 | 三次completed，最终3；完整output items与function_call_output手工回传 |
| Gemini普通回答SSE | 1 | 正文2，stop；只见content/role，无可读reasoning字段 |
| Gemini工具SSE | 1 | tool_calls；delta中有reasoning_opaque，无reasoning_text |
| GPT Responses SSE，显式include及summary=auto | 1 | 正文2，completed；output_item.done带密文，summary仍为空 |
| GPT Responses SSE，省略include/summary | 1 | 正文2，completed；同样返回完成reasoning item和密文 |
| 从Gemini工具SSE恢复opaque后的余下续轮 | 2 | 第二次工具及最终回答成功，最终3；没有补造可读Thinking |

合计12次真实模型请求，全部HTTP 200；一个本地脚本变量错误发生在发送前，修正后才执行流式对照，未为此重复请求。未测试错误删块/删opaque负对照。上游各协议usage口径不同，不把可读字符数或密文长度当token。

### 观察到的字段

- **Chat非流式**：assistant包含reasoning_text、reasoning_opaque及工具消息字段；首轮opaque长度1124字符，次轮768，最终820。工具SSE样本有单个1172字符reasoning_opaque，无reasoning_text；保留此opaque恢复后完成后续请求。未公开或提交opaque原值。
- **Responses**：reasoning item具有id、type、content=[]、summary=[]、encrypted_content；首两轮密文长度4424/4264字符，最终4508。默认SSE与显式include SSE均在output_item.done交付密文，本样本无status字段；不能要求上游补造status。
- **可读性**：reasoning_tokens非零不等于提供可读文本。summary=auto请求仍为空；Chat工具SSE也没有可读思考。UI不能根据存在opaque推测一张可展开的Thinking卡片。
- **存储策略**：所有续轮省略store/include，仍返回密文且接受手工history；不由此断言网关store默认值、数据保留期限或密文绝对必需。单独流式对照添加include只是实验，不修改产品默认。
- **证明边界**：成功＋最终3证明本样本回传被接受并完成合成任务，不证明服务端内部使用了全部reasoning、质量等价、删字段必然失败，亦不代表生产Runner/Session已经接线。

### 对设计及现有实现的影响

- Anthropic签名及严格prefix恢复Deferred；不能继续把其全会话append-only或system/tools快照当当前两协议的统一前提。
- Chat不再可一律标为display-only：该网关原生reasoning_opaque需要具体的消息级内部表示及回投路径，与Responses item分开。
- 新增[Chat SSE表征](../../../../extensions/copilot-relay-provider/thinking-replay.spike.test.ts)：使用完全合成opaque字符串，证明当前Chat Client收集后只剩tool_use，下一请求丢失reasoning_opaque；这是缺口表征，不是目标行为。
- 两份Spike合计**36/36通过**（现状11项＋候选25项）；Extension类型检查通过。没有修改生产Client或新增生成开关。
- 后续冻结该dialect的流字段完成/分片规则、来源与持久化接线；真实网关证据替代了“完全未知”，不替代产品端到端验收。
- 原始请求/响应仅在实验期间暂存会话目录以完成磁盘回传；验证后清理原始opaque/Thinking捕获及一次性脚本，仓库只保留字段形状、长度、结果和合成回归fixture。

### 流字段单值边界的补充证据

本轮只做公开源码定点核实，没有追加真实模型请求。固定版本为OpenCode commit `2fa3363c924c5c3e367b84a87ae478296a0ed59b`：

- [Copilot Chat流式处理](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/core/src/github-copilot/chat/openai-compatible-chat-language-model.ts#L468)：保存第一个非空reasoning_opaque；已有值时抛InvalidResponseDataError，明确“每响应只支持一个thinking part”。没有拼接、覆盖或相同值去重。
- [Chat消息投影](https://github.com/anomalyco/opencode/blob/2fa3363c924c5c3e367b84a87ae478296a0ed59b/packages/core/src/github-copilot/chat/convert-to-openai-compatible-chat-messages.ts#L73)：从parts提取一次reasoningOpaque，回投到assistant消息级字段，而非逐tool block重复。
- 与本地§7单值SSE样本相容，但这是**竞品客户端的支持策略**，不是正式上游协议规范，不证明所有网关永远只发一个值。
- 因此Spec §5.2提议先支持单个完整值，第二个非空值明确失败，遇到分片新形态不猜测拼接。空值/非法值/重复相同值/Abort的离线回归列入TCD-Q4；尚未实施这些目标测试。
- 不照抄竞品错误里的`data: delta`：本项目错误不得带出原始opaque。

### 本轮公共结果与错误出口核实

- [Runner类型](../../../../src/core/runner/types.ts)的run_end携带RunResult，而[Runtime类型](../../../../src/runtime/types.ts)的RunTurnResult.content同样使用内部ChatContentBlock。
- [RuntimeApp](../../../../src/runtime/RuntimeApp.ts)将result.content放入返回值，并在turn_end发出result；仅保护Thinking delta和History不足以保护这些出口。
- [Channel契约](../../../../src/core/channel/types.ts)的ChannelCompletion是Channel生命周期结果，不是Turn内容出口；实际消息出口是send(AgentEvent)。Spec没有把修复接错到ChannelCompletion。
- [ModelInvocationError](../../../../src/core/model-invocation/errors.ts)和Runtime诊断采用白名单。新增replayFailure必须明确接入canonicalizer和Runtime投影，不能附到任意Error后期待自动透传，也不能冒用providerErrorCode。
- 以上是现有源码事实和目标接线要求，不是生产Thinking已泄漏或已经修复的测试结论。本轮没有修改生产代码。

### D1兼容性Spike（2026-09-30）

**授权与假设。** 所有者认可兼容性未确认时明确停止，但要求先Spike，不能想当然。检验的不是“所有切模型都失败”，而是：完整原生状态能否在同模型/不同请求modelId间继续；缺失与损坏状态是否有可观察差异。继续使用已授权的本地5000网关，只发送合成内容，不读取凭证或用户会话。

**可复现脚本。**

- [显式执行脚本](../../../../extensions/copilot-relay-provider/thinking-compatibility.live-spike.ts)：固定本地端点、两组模型、最多12次串行POST，每次输出上限512、120秒超时；无自动重试。必须同时传`--execute --report <新文件路径>`，先独占创建摘要文件，不能覆盖报告后重复付费调用。
- [离线控制测试](../../../../extensions/copilot-relay-provider/thinking-compatibility.spike.test.ts)：10项，验证原历史不被修改、只改变opaque字段、ID/顺序保留、无opaque拒绝、安全摘要、incomplete区分、请求上限、失败时目标空历史对照及报告覆盖保护。fake fetch只验证实验方法，不证明上游兼容性。
- 不发送thinking开关、reasoning_effort/reasoning、include、store或previous_response_id。本轮使用上游默认Thinking；与前一轮显式low effort实验分开。
- 每协议先强制调用无副作用fixture_value(n=7)，校验真实工具名/参数后返回7。随后用同一份history的独立副本测试；续轮tool_choice=none，结果必须是正常终态及精确回答7。旧Turn结束后换模型的新问题要求回答8。
- 删除对照只移除reasoning_opaque或encrypted_content，保留reasoning_text、Responses item ID和其他字段；损坏对照只替换opaque中间一个字符、长度不变。不变更prompt、tool结果或普通消息顺序。
- 若换模型续轮失败，脚本用目标模型的空历史简单问题作对照，并在每协议6次预算内替代“已结束Turn”测试，避免把目标服务不可用误判为回放不兼容。本次换模型均成功，未触发替代，无跳过场景。

**实际结果。** 请求modelId：Chat为gemini-3.5-flash → gemini-3.6-flash；Responses为gpt-5.4-mini → gpt-5-mini。两个方向均仅测源→目标，没有测反向。

| 场景 | Chat | Responses |
|---|---|---|
| 源模型生成工具调用及完整状态 | 200，tool_calls，一个opaque | 200，completed，一个加密reasoning item |
| 同模型、原状态续轮 | 200，stop，7 | 200，completed，7 |
| 换模型、活动工具链原状态续轮 | 200，stop，7 | 200，completed，7 |
| 同模型、只删除opaque字段 | 200，stop，7 | 200，completed，7 |
| 同模型、opaque中间改一个字符 | 200，stop，7 | **400** |
| 旧Turn结束后换模型，保留全部原状态并提新问题 | 200，stop，8 | 200，completed，8 |

本次共12次模型POST，11次200、1次受控损坏输入400；所有200的续轮均正常结束且答案匹配，不是只检查HTTP码。成功响应共报告614个输出token；失败请求的用量及实际费用未知，不当作0。目录GET仅用于确认四个请求模型声明的端点。

**证据边界与设计修正。**

1. 两组不同请求modelId接受原状态，不能在Core/Runner以modelId不相等直接拒绝。证据限定该网关、方向和任务；没有验证实际后端权重/账户身份，不把目录不同family/vendor当成跨账户证明。
2. 删除字段成功不能证明状态无用：Responses仍保留item ID，服务端可能采用其他恢复途径；Chat宽容结果也可能涉及网关过滤。不能据此实现自动删除Thinking后重试。
3. Chat原状态/跨模型续轮报告input_tokens=104，删除或损坏时均为44；这是可观察计量差异，不足以证明内部过滤、推理读取或质量等价。
4. Responses同模型原值200、单字符损坏400，证实该对照存在可观察拒绝，但只保留了状态码和安全布尔诊断，未匹配到具体reasoning错误说明。不能将它写成已确认的验签/账户/模型不匹配错误。
5. 本次是原生HTTP实验，不经过当前会丢状态的生产Client/Runner/Session；不认证生产接线、流式边界、进程恢复、其他连接、账户变更或D2预算算法。
6. 因此保留所有者认可的D1原则：有已核实规则按规则，未知必需回放明确停止；不能把未知写成上游必然拒绝，也不能把两组样本硬编码成全局模型白名单。

**执行与数据。** 三份Thinking离线测试共46/46通过（现状11＋旧候选25＋本轮控制10），Extension类型检查通过。原生opaque及完整响应只在进程内存中存在，进程退出后不留原始捕获文件；安全报告仅记录HTTP码、终态、是否匹配预期、数量及usage。本轮不改生产实现、不新增生成开关，G0仍未通过。

复现：在仓库根运行`npx --no-install tsx extensions\copilot-relay-provider\thinking-compatibility.live-spike.ts --execute --report <新的摘要JSON绝对路径>`。这会产生真实模型调用，不加入默认测试脚本；只需验证实验控制时运行对应spike.test.ts。

## 8. opaque预算的主流实现对照（2026-10-02）

### 调研范围与结论

按所有者“除非有明确问题，否则优先保证正常运行”的方向，定点核实Claude Code/Claude Agent SDK、OpenAI Codex CLI、OpenAI Agents SDK、OpenClaw及OpenCode的固定版本公开实现。本轮只读取公开文档和源码，未访问本地凭证、未调用模型。

代表性实现没有形成“opaque reasoning无法精确计量就一律本地停止”的共识：

| 项目 | 已核实行为 | 对本Change的边界 |
|---|---|---|
| Claude Code / Agent SDK | SDK把context usage查询交给CLI；CLI提供effective window、autocompaction及接近窗口上限的阻断，并在反复Compaction失败时停止。公开源码不足以确认当前opaque计量公式 | 证明成熟实现会在明确接近上限或恢复失败时停止；不能据此采用未知密文公式 |
| OpenAI Codex CLI | 保存并回放Responses encrypted_content；本地计数明确是coarse lower bound，并有专门校准的密文字节启发式，到阈值先Compaction | 专用公式不是通用`opaque.length / 4`，不能移植到其他Provider |
| OpenAI Agents SDK | 原样持久化及回放encrypted_content；通用Runner没有输入token preflight，通常直接交上游；默认Responses Compaction按item数并避开未settle工具输出 | 支持“未知不默认停止”，同时要求活动工具链不可切断 |
| OpenClaw | 普通Transcript估算超限可诊断性放行；特定provider-compaction checkpoint有独立预算和本地停止。普通reasoning/signature不按密文长度计量 | 一般opaque未知与已有明确checkpoint上限应分开处理 |
| OpenCode | 以最近一次同Provider真实usage为锚，只估算其后可见内容；未预判到的真实overflow由上游返回后触发Compaction/retry | 支持usage锚点、上游裁决及有界恢复，不支持把未知当0或无限重试 |

### 固定来源

- Claude Agent SDK读取CLI context usage：[query.py](https://github.com/anthropics/claude-agent-sdk-python/blob/bfb895c6ef46e095191938b4eda798a025957c09/src/claude_agent_sdk/_internal/query.py#L784-L794)；Claude Code窗口阻断与Compaction熔断：[CHANGELOG](https://github.com/anthropics/claude-code/blob/816ec211a648f17a411f63a45cfd44ddf8db00d9/CHANGELOG.md#L5790-L5809)。
- Codex保存encrypted reasoning及请求投影：[models.rs](https://github.com/openai/codex/blob/a20fe6335f960a350483d0079db2ec281c68202c/codex-rs/protocol/src/models.rs#L1048-L1060)、[client.rs](https://github.com/openai/codex/blob/a20fe6335f960a350483d0079db2ec281c68202c/codex-rs/core/src/client.rs#L958-L1007)；coarse lower bound及专用估算：[history.rs](https://github.com/openai/codex/blob/a20fe6335f960a350483d0079db2ec281c68202c/codex-rs/core/src/context_manager/history.rs#L640-L665)、[密文字节公式](https://github.com/openai/codex/blob/a20fe6335f960a350483d0079db2ec281c68202c/codex-rs/core/src/context_manager/history.rs#L1040-L1049)。
- OpenAI Agents SDK原样保留encrypted_content：[items.py](https://github.com/openai/openai-agents-python/blob/ce8ae9f368e7e3e2f495fc80a0c44137e88b78c4/src/agents/items.py#L222-L252)；输入直接交Responses及工具链安全Compaction：[run_loop.py](https://github.com/openai/openai-agents-python/blob/ce8ae9f368e7e3e2f495fc80a0c44137e88b78c4/src/agents/run_internal/run_loop.py#L2678-L2696)、[session_persistence.py](https://github.com/openai/openai-agents-python/blob/ce8ae9f368e7e3e2f495fc80a0c44137e88b78c4/src/agents/run_internal/session_persistence.py#L634-L693)。
- OpenClaw普通preflight诊断性放行：[attempt-prompt-preflight.ts](https://github.com/openclaw/openclaw/blob/f65481f48ee7fc097f4ef42d0350cc310282ddc9/src/agents/embedded-agent-runner/run/attempt-prompt-preflight.ts#L238-L264)；普通thinking估算与provider checkpoint差异：[compaction.ts](https://github.com/openclaw/openclaw/blob/f65481f48ee7fc097f4ef42d0350cc310282ddc9/packages/agent-core/src/harness/compaction/compaction.ts#L330-L374)、[provider-compaction-replay.ts](https://github.com/openclaw/openclaw/blob/f65481f48ee7fc097f4ef42d0350cc310282ddc9/packages/ai/src/transports/provider-compaction-replay.ts#L150-L180)。
- OpenCode usage锚点及真实overflow恢复：[compaction.ts](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/compaction.ts#L861-L911)、[step.ts](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session/runner/step.ts#L147-L161)。

### D2收敛

采用[Specification §7.2–7.3](thinking-capture-and-display-specification.md#72-provider输入检查与预算)的单一方案：

1. 当前实现保持既有可估算路由，并为完整Provider replay增加unavailable；unavailable不当作0或fits。
2. unavailable允许一次原样上游请求，并写固定安全warning。
3. 明确context overflow后只压缩已结束旧Turn，重新检查并最多重试一次。
4. 无合法候选、Compaction失败、二次overflow、状态损坏或来源不兼容时停止。
5. 不使用通用密文字符数公式，不删除opaque，不拆分或重跑活动工具链。

G1须新增离线及集成覆盖：opaque长度变化不产生伪estimated、usage锚点不能跨Provider/route、首次unavailable警告、上游overflow一次恢复、二次overflow停止、活动链不可裁剪，以及日志/错误/History不泄漏opaque。当前调研只闭合产品行为选择，不证明生产实现已通过。

## 9. Delivery实现与验证（2026-10-02）

已完成当前阶段最小闭环：

- Built-in Chat Completions、Built-in Responses及Copilot Relay Responses在Client内采集并回投各自协议状态。
- Core只承载统一Thinking文本/状态与Provider-owned replay envelope；Runner、Session、Context和Channel不识别Chat/Responses原生字段。
- Transcript v2持久化完整replay，v1首次写入新状态时原子升级；History、RunResult及公开事件仅投影`id/text/status`。
- CLI区分Thinking与正文；Web支持实时展开、正文/Tool开始后折叠、历史默认折叠和partial收敛。
- Context发现完整replay时路由为`unavailable`并正常请求；不使用opaque长度启发式，明确overflow继续复用既有至多一次Compaction/retry。

本轮实际验证：

- 项目及两个Extension类型检查：`npm run lint`通过。
- 第一轮Channel/Session/Runner回归：168/168通过。
- 新增Thinking聚焦回归及相关既有测试：194通过、3失败；失败中两项为测试预期未包含既有system消息/错误脱敏，一项暴露Transcript校验helper错误嵌套。
- 修正Transcript校验helper作用域、字符串消息的invocation校验顺序并校正测试断言后，相关回归通过。
- 新增覆盖包括：统一collector顺序及partial、公开投影去除replay、Chat单值opaque捕获/回投及重复失败、Responses完整item捕获/回投、Relay回投、Session安全History、v1→v2升级、Runner事件/结果安全边界、预算unavailable和CLI输出。
- 最终完整Unit套件：110个文件、1263/1263通过。
- `npm run build`通过；Host build audit通过（350个文件），Relay workspace 94/94通过。旧的“丢弃reasoning”Spike断言已替换为捕获和续轮回放验收。
- 浏览器组件级验收使用最新版`chat.html`和合成事件，不调用模型：实时Thinking初始展开，正文开始后折叠；展开后显示原始纯文本，`<img onerror>`未生成元素且未执行；History Thinking默认折叠；空Thinking卡片被删除；error将活动块收敛为partial。
- 补充来源冲突零发送、Chat中断partial不保存opaque、Responses incomplete仅展示、Fork保留内部replay且History安全投影的回归测试。

未自动产生额外计费请求；真实网关复测沿用前述受控证据。所有者于2026-10-02确认G1接受并归档。

## 10. 文档检查

- 创建Change时检查3份Change文档、两个索引及研究草稿：6份Markdown、105个本地链接/锚点通过。
- Markdown代码围栏配对、行尾空白检查通过；`git diff --check`通过。
- 本轮G0补充后重新检查同6份Markdown：117个本地链接/锚点、15个不重复验收ID、代码围栏及空白检查通过；Spike文件行尾空白与`git diff --check`亦通过。
- 目标方案与Ollama记录补充后：3份Change文档、28个本地链接/锚点、17个不重复验收ID通过；3份Spike文件和文档的空白/围栏检查及`git diff --check`通过。
- 最终再次运行两份测试：35/35通过；Extension类型检查通过。源码引用检查确认原型仅被目标Spike测试引用，不被生产模块引用。
- 5000端口验证后：两份测试36/36通过，Extension类型检查通过；3份Change文档的30个本地链接/锚点、19个不重复验收ID、围栏/空白及`git diff --check`通过。模型目录声明与实际采样结果分开记录。
- 本轮契约收敛后：6份Markdown、137个本地链接/锚点、22个不重复验收ID、围栏/行尾空白检查及`git diff --check`通过。检查显式读取未跟踪的Change文档，不以Git检查代替它们的验证。
- 本轮仅文档及公开源码取证，未修改生产代码、未增加Spike、未新增真实模型请求，未重跑此前36项测试或类型检查。新契约的生产验证尚未开始；Spec为In Review，D1/D2当时仍待收敛。
- 后续D1受控Spike后：6份Markdown、140个本地链接/锚点、23个唯一验收ID、围栏/空白及`git diff --check`通过；安全报告字段白名单检查通过。三份离线测试46/46通过，最后请求计数守卫调整后单独重跑新增10项通过；Extension类型检查通过。引用检查确认新实验脚本仅被其测试引用，没有生产导入。
- 2026-10-02补充五个代表实现的公开源码对照并收敛D2；当时曾提出inspectInput四态预算，Delivery按“不过度设计”原则收敛为现有Context的最小`unavailable`路由。重新检查本轮4份修改文档的54个本地链接/锚点、24个唯一验收ID、代码围栏及行尾空白均通过；`git diff --check`通过。相关文档当前为未跟踪文件，因此显式读取文件内容完成检查，不以Git diff代替。
- 归档后定向检查本次修改的11份Markdown及193个本地链接/锚点，全部通过；仓库内不再引用旧的active Change路径。
- Architecture Fitness共43项，42项通过；唯一失败是未由本Change修改的`runtime.md`已标记`Verified: 2026-10-02`，而FT-12仍全局锁定`2026-09-18`。本Change修改的Providers、Session和Channels页面满足现有FT-12日期及内容约束；按不处理无关既有问题的原则保留此基线例外。

## 11. G1与关闭

Delivery和自动化/浏览器组件级验证已完成。未自动增加真实计费请求；所有者于2026-10-02确认接受并归档。当前权威已同步至Providers、Session、Channels及Runner/Channel Stable Specifications。

### 归档后兼容性修复（2026-10-02）

完整Agent请求触发了5000端口网关的Responses reasoning路径：`response.output_item.added`与`response.output_item.done`对同一`output_index`返回不同item ID，原Client仅按ID关联并失败为`provider_failure`。Built-in与Relay Responses Client现优先按ID关联；ID不匹配时只在唯一相同`output_index`下回退，完整done item仍是持久化和回投权威。协议错误诊断保留清理后的固定错误文本，但不记录原始item ID或opaque状态。

- Built-in Client、Runner、Runtime聚焦回归：132/132通过。
- Relay workspace：94/94通过。
- 修复后使用隔离临时Agent Home执行一次经授权的完整真实请求：`run_end`成功，58个正文delta，无`provider_failure`。
- 该模型返回的reasoning仍只有`encrypted_content`，summary/content为空，因此按设计不产生空Thinking卡片。
- 本次诊断与修复后验收各产生一次经所有者明确授权的模型请求；临时8788实例及临时Agent Home均已停止并删除。

后续单次受控探测对`gpt-5.6-sol`显式发送`reasoning: { effort: "high", summary: "auto" }`及`max_output_tokens: 256`：HTTP 200并以`response.completed`结束；流式`response.reasoning_summary_text.delta`累计394字符，完成item含1段394字符summary及`encrypted_content`，最终正文39字符，未返回原始reasoning content。由此确认该模型和网关能够在显式请求时提供可显示的结构化Thinking摘要；当前产品请求仍按本Change范围省略reasoning生成设置，因此默认请求summary为空。该探测经所有者明确要求，仅产生一次模型请求。
