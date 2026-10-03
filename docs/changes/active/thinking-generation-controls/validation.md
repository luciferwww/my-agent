# Thinking Generation Controls Validation

> Status: Technical validation complete — owner acceptance pending
> Date: 2026-10-03
> Authority: Acceptance matrix, evidence and gate tracking only
> Related: [Plan](plan.md), [Specification](specification.md)

## 1. 证据基线与执行边界

交付实现已完成；未调用真实计费模型，协议接受性由离线fixture和Host smoke覆盖。
“自动”表示离线Unit/契约/集成测试，使用fake fetch或fixture；
“自动＋Web手工”还需浏览器验证。LLM请求为零不包含预先发生的独立Catalog discovery。
不重复保存研究讨论；本表作为正式验收及后续执行结果的owner。

## 2. 验收矩阵

| ID | 场景与必须观察到的结果 | 类型与主要验证面 | 状态 |
|---|---|---|---|
| TGC-01 | 策略省略：开关省略、effort=default，wire不变，无全局默认层 | 自动；三Client默认请求对照、配置 | Passed |
| TGC-02 | 能力缺失/空/仅开关/仅effort：只提供声明选项，不丢实际合法Thinking | 自动；能力契约、采集 | Passed |
| TGC-03 | Built-in非法schema：配置/候选staging失败，不发布Catalog；reload保留旧generation | 自动；配置、Unit生命周期 | Passed |
| TGC-04 | 合法显式选项不受模型支持：解析后以capability_unsupported失败；Runner、MessageRecord和LLM请求均未发生，不降级 | 自动；Model Resolution与Runtime边界 | Passed |
| TGC-05 | 同协议不同模型：使用各自schema与冻结事实 | 自动；Provider、Resolver | Passed |
| TGC-06 | Responses high且有私有summary事实：发送high/auto，可读文本进入卡片/History | 自动＋Web手工；请求与公开投影 | Passed |
| TGC-07 | Responses high无summary事实：只发送effort，不猜summary | 自动；Client请求fixture | Passed |
| TGC-08 | Responses none：精确发送none，不请求summary，实际文本仍展示 | 自动；请求、采集与投影 | Passed |
| TGC-09 | Chat high/none：仅发送允许的reasoning_effort | 自动；Client请求fixture | Passed |
| TGC-10 | Anthropic adaptive on/high/off/none：on不补effort，high用adaptive+effort，关闭用disabled | 自动；请求fixture、能力校验 | Passed |
| TGC-11 | Anthropic budget等级：用配置预算，不发送output_config.effort | 自动；配置、请求fixture | Passed |
| TGC-12 | Anthropic静态adapter/预算不一致在配置/staging失败；动态输出冲突preflight失败，不自动调整 | 自动；配置、有效输出上限与请求计数 | Passed |
| TGC-13 | Anthropic redacted：有序保存replay-only块，不生成空卡片 | 自动；事件、Collector、公开投影 | Passed |
| TGC-14 | Anthropic同源工具续轮：thinking/signature/redacted按验证协议顺序恢复 | 自动；多次调用与工具关联fixture | Passed |
| TGC-15 | 三协议互切：不兼容replay省略，正文/Tool关联保留 | 自动；目标Client请求、源Transcript不变 | Passed |
| TGC-16 | Anthropic→OpenAI→Anthropic：各次只投影兼容且经校验replay，不改Transcript | 自动；往返切换、恢复 | Passed |
| TGC-17 | 同协议来源冲突：发送前失败，opaque不进日志 | 自动；来源、请求计数、安全错误投影 | Passed |
| TGC-18 | 运行中改变选择：当前Turn模型/策略固定，新消息采用新快照 | 自动；Runtime队列、generation/Runner | Passed |
| TGC-19 | 不同resolved策略的Steering留在FIFO下一Turn，不注入当前Turn | 自动；队列、Runner领取 | Passed |
| TGC-20 | Abort/流错误：可读partial保留，无未完成replay | 自动；三协议流与持久化 | Passed |
| TGC-21 | reload/Fork：可读文本/原始策略恢复、摘要一致、History无opaque、不继承历史策略 | 自动＋Web手工；磁盘恢复、History | Passed |
| TGC-22 | Compaction不继承用户策略/请求summary；内部Thinking/replay不持久化，只保存摘要正文 | 自动；内部调用、Transcript及事件 | Passed |
| TGC-23 | Relay GPT/Gemini discovery分别绑定Responses/Chat并发布准确effort | 自动；metadata、Provider/Router | Passed |
| TGC-24 | Relay已知值投影；未知非空字符串诊断后忽略；全未知保留模型但无显式effort | 自动；metadata、诊断 | Passed |
| TGC-25 | Relay双endpoint稳定绑定Responses；跨协议历史正确过滤，无失败后协议重试 | 自动；Router请求次数、历史 | Passed |
| TGC-26 | 静态Catalog在staging校验，动态descriptor在解析时校验；同一深冻快照、不发布错误候选 | 自动；Registry/Resolver、Provider | Passed |
| TGC-27 | Web首次选模型为Default+Default；切换时逐字段保留新模型支持值，不支持项重置Default并提示，不恢复按模型旧值；已入队/运行中Turn不变 | 自动＋Web手工；模型切换与队列快照 | Passed |
| TGC-28 | 正常Turn无Display隐藏控制；实际可读Thinking显示；内部调用按TGC-22隔离 | 自动＋Web手工；实时/历史/CLI回归 | Passed |
| TGC-29 | off+high或on+none等通用冲突在Runtime intake拒绝，不入队、不保存MessageRecord、不调用LLM | 自动；入口/组合校验 | Passed |
| TGC-30 | off+none且各自支持：两种选择顺序可用，关闭只映射一次，无冲突effort | 自动＋Web手工；组合与请求fixture | Passed |
| TGC-31 | Anthropic budget独立on需要defaultBudgetTokens并满足max_tokens；缺失时不发布on | 自动；配置、staging与调用限制 | Passed |
| TGC-32 | Relay只有effort：只提交effort即可调用，不强制thinking字段 | 自动；消息、能力、Client请求 | Passed |
| TGC-33 | Built-in无选项隐藏控件，语义Default；有选项才显示，不创建调用默认 | 自动＋Web手工；配置、Catalog、控件 | Passed |
| TGC-34 | 显示控件的Default是首项且初始选中；隐藏维度也按Default；thinking省略、effort解析default，不依赖Relay默认metadata | 自动＋Web手工；初始化、提交与规范化 | Passed |
| TGC-35 | Relay非数组/非字符串/空白等结构非法：候选失败，不发布Catalog，reload保留旧generation | 自动；discovery、Unit生命周期 | Passed |
| TGC-36 | reasoning省略/空对象/显式default执行等价，History/reload/Fork保留原始形态，摘要一致，不被resolved覆盖 | 自动；规范化、磁盘与DTO结构断言 | Passed |
| TGC-37 | effrot等未知字段由Channel解析或Runtime intake拒绝；Runtime不信任Channel，不入队、不保存MessageRecord、不调用LLM | 自动；Channel/WebSocket及Runtime入口 | Passed |
| TGC-38 | 快照保留Provider有效顺序，Web按公共枚举排序且Default首项，不增补能力或改请求值 | 自动＋Web手工；乱序metadata与控件 | Passed |

## 3. 验证执行顺序

1. P1：扩展现有Built-in配置/Provider、Model Resolution与DTO契约测试，
   先验证默认兼容、字段错误、深冻及staging回滚。
2. P2：Channel/WebSocket、Runtime队列、Runner Steering和Session/Transcript测试；
   覆盖相同resolved策略可领取及三种原始形态恢复。
3. P3：扩展[Built-in协议测试](../../../../src/builtins/providers/builtin/protocol-clients.test.ts)，
   增补Anthropic事件、签名、工具续轮及三协议往返fixture。
4. P4：Relay metadata/Unit/Provider/Client与包发布验证，含Chat-only、双endpoint、
   未知等级、非法候选、错误路径不自动重试。
5. P5：Web行为测试及浏览器检查，再跑涉及边界的Integration/Fitness与最终Gate。

聚焦测试优先用现有runner选定相关文件，一次覆盖同一修改的相关选择器。
稳定命令以[package.json](../../../../package.json)为准：

```text
npm test -- <related test files>
npm run test:integration
npm run test:fitness
npm run lint
npm run build
```

Relay交付按影响运行verify:relay及verify:package；WebSocket Host接线运行
verify:websocket-host。
执行记录必须区分离线fixture、浏览器组件测试、Host集成和真实模型接受性。
离线成功不证明任意模型/version接受参数；必要真实验证使用合成输入并先确认费用边界。

## 4. Gate与证据记录

| Gate/记录 | 当前状态 | 需要的证据 |
|---|---|---|
| 文档准备 | Created；结构检查通过 | 文件/导航存在、链接、JSON、围栏、38项覆盖、空白检查 |
| G0 Spec与Delivery接受 | Passed（2026-10-03） | 所有者接受Spec、确认TGC-P1，并授权继续至完整实施 |
| 协议fixture准备 | Passed | 三协议请求/事件/工具续轮、预算及Relay双协议fixture |
| 各Plan Item聚焦验证 | TGC-P1–P5 Completed | 命令、执行结果、关联TGC及具体失败/限制 |
| G1完整验收 | Technical gate passed；owner acceptance pending | 自动/浏览器/集成/构建证据、独立评审、文档同步已完成；等待所有者接受 |

文档结构检查、后续测试命令和Gate结果追加在本节，不将Pending改为Passed而没有证据。
后续P1结果记录如下；仍没有真实协议接受性结论。

### 2026-10-03 文档准备检查

- 6份创建/更新文档的118个本地链接目标存在，7份JSON示例可解析，围栏平衡。
- 研究到正式validation的TGC-01–38连续、唯一、无遗漏，全部仍为Pending。
- 6份文档无尾随空白并保留结尾换行；已跟踪导航文件的git diff --check通过，
  新文件另行直接检查，未把git忽略未跟踪文件误当成验证。
- 首次检查器对Pending行未兼容CRLF；修正检查正则后全项通过，未改验收状态。
- 该次文档准备检查未运行生产测试、构建、浏览器或真实模型请求；当时G0/G1未通过。

### 2026-10-03 TGC-P1 类型与能力校验

实现范围：

- 增加公共Thinking effort/switch、原始Preference、Resolved policy及ReasoningCapabilities类型，
  并通过Core与Extension API导出；ModelInvocationRequest只增加可选结构字段，尚无调用方。
- Provider Facts、Provider Catalog、Registry staging、Resolved Facts及Runtime Catalog DTO
  投影同一reasoning schema，保持Provider顺序并深度复制/冻结。
- Built-in逐模型配置严格校验reasoning对象、字段、数组值和重复项，错误保留具体fieldPath。
- Registry原先重建Catalog条目时没有保留已有capabilities；P1沿同一投影点保留并冻结
  既有tool/media及新增reasoning，避免只为reasoning建立旁路。
- P1尚无Client wire mapper，因此Built-in Provider对非空reasoning选项在staging失败关闭；
  空schema可验证投影链。P3实现具体协议映射前不发布无法兑现的Built-in选项。
- 未修改Channel消息、Runtime intake策略、Runner、Session、任何协议请求体或Web。

验证：

| Gate | 结果 |
|---|---|
| 聚焦配置/Provider/Resolver/Registry/Runtime测试 | 130/130通过 |
| Unit | 110 files，1284/1284通过 |
| Integration | 7 files，22/22通过 |
| Type/lint | 根项目及两个Workspace通过 |
| Build | TypeScript、Host build audit（352 files）通过 |
| Relay验证 | 6 files，94/94通过 |
| Fitness | 12 files通过；FT-12的1项日期断言失败，与提交`7048e3b`中已存在的runtime.md=2026-10-02、测试常量=2026-09-18基线一致 |
| diff check | 通过 |

TGC-01–05、TGC-26和TGC-33只取得P1结构/投影部分证据，矩阵仍保持Pending；
没有用类型测试冒充消息、wire、reload或UI验收。未运行真实模型请求。
所有者于2026-10-03确认TGC-P1完成，随后授权继续至完整实施。

### 2026-10-03 TGC-P2 消息与Turn链路

实现范围：

- Channel及WebSocket接受消息级`reasoning`，严格拒绝未知字段、非法类型和值及通用组合冲突；
  Runtime intake重复执行同一校验，不信任Channel输入。
- Queue同时冻结原始`ReasoningPreference`和执行用`ResolvedReasoningPolicy`；模型解析后按同一
  Catalog事实拒绝不支持的显式选项，Default不要求模型发布能力。
- Runner仅在正常模型调用携带resolved策略；Compaction保持省略。Steering只领取模型、媒体和
  resolved策略均兼容的连续前缀，raw preference仅作为用户消息元数据持久化，不进入模型历史。
- Transcript v2、Session reload、History和Fork保留原始选择，并区分省略、空对象和显式Default；
  reasoning只允许出现在user message。

验证：

| Gate | 结果 |
|---|---|
| P2聚焦测试 | reasoning normalizer、Runtime intake/FIFO、Runner/Compaction、Session/reload/Fork及WebSocket共291项通过 |
| Unit | 111 files，1318/1318通过 |
| Integration | 7 files，22/22通过 |
| Type/lint | 根项目及两个Workspace通过 |
| Build | TypeScript、Host build audit（354 files）通过 |
| Relay验证 | 6 files，94/94通过 |
| Fitness | 12 files通过；FT-12的1项既有日期断言失败，与P1记录的基线相同 |

首次Unit全量并行运行时`process-tool`日志等待测试超时；该文件单独重跑5/5通过，
随后完整Unit重跑1318/1318通过。TGC-18–22、29–30及36–37取得P2范围证据；
协议wire、Anthropic恢复和Web摘要仍由P3/P5完成，因此验收矩阵对应行继续保持Pending，
没有把阶段结构测试冒充完整端到端验收。

### 2026-10-03 TGC-P3 Built-in协议闭环

实现范围：

- Responses精确映射显式effort；独立`on`在Default或显式effort下均请求`summary=detailed`，
  使Thinking On直接表达开启并显示。Chat Completions只映射`reasoning_effort`，
  未选择独立开关时两个协议的Default wire均不变。
- 后续实机配置确认两个Relay-backed Built-in模型提供独立开关；逐模型声明后，Responses和
  Chat均以省略effort表达`on + default`、以单个`none`表达`off`，未声明模型仍在fetch前拒绝。
- 三个Built-in协议统一把独立`on`定义为开启并显示：Responses请求并采集summary，Chat使用
  经验证的默认开启路径并采集reasoning_text，Anthropic发送原生Thinking配置并采集thinking block。
- 2026-10-03本机Copilot Relay受控探测：`summary=detailed`返回1段528字符摘要及512个
  reasoning tokens；同日真实`summary=auto`会话返回空summary，因此Responses独立`on`
  固定使用`detailed`，不把Provider可选择省略摘要的`auto`用于显示语义。
- 2026-10-03人工验收：重启Runtime后使用`builtin/gpt-5.6-sol`、Thinking On、
  Effort High，Web成功显示可读Thinking信息。
- 2026-10-03补充人工验收：
  - `builtin/gpt-5.6-sol`使用Thinking On、Effort Low时成功显示可读Thinking；
  - `builtin/gemini-3.8-flash`使用Thinking On、Effort Medium时成功显示可读Thinking。
  由此覆盖Responses与Chat Completions两条实际Built-in展示路径，且显示行为不依赖High等级。
- Built-in逐模型校验Anthropic adaptive/budget adapter；Responses/Chat不发布
  未实现的独立开关；Responses发布独立on即承诺可读summary请求路径；Anthropic budget值、
  独立on和默认/等级预算在配置与Provider staging时
  一致，动态`max_tokens`冲突在fetch前失败。
- Anthropic映射disabled/adaptive/enabled+budget_tokens，采集thinking/signature及
  redacted_thinking为Provider replay；公开投影隐藏空redacted卡片。
- Anthropic工具续轮按原顺序恢复thinking/signature/redacted；跨协议只过滤不兼容replay，
  保留正文和Tool，并验证Anthropic→OpenAI→Anthropic不修改源消息。
- 旧Spike中“Anthropic当前丢失Thinking”的候选结论已替换为生产行为断言：
  有签名完整恢复，无签名完成块失败关闭。

验证：

| Gate | 结果 |
|---|---|
| P3聚焦测试 | Built-in配置/Provider/三Client/Collector/Transcript及replay Spike共119项通过 |
| Unit | 111 files，1345/1345通过 |
| Integration | 7 files，22/22通过 |
| Type/lint | 根项目及两个Workspace通过 |
| Build | TypeScript、Host build audit（354 files）通过 |
| Relay验证 | 6 files，94/94通过 |
| Fitness | 12 files、42项通过；仅FT-12的既有日期断言失败 |

首次并行全量运行时，旧Anthropic Spike按预期因结论过期失败并已更新；同时进程Integration、
process-tool及Fitness扫描出现负载型超时。之后Unit、Integration和Fitness分别独立重跑，
前两者全过，Fitness只剩已记录的FT-12日期基线。未执行真实模型或产生费用。
TGC-06–17、20、22及31取得P3范围证据；Relay和Web依赖项仍由P4/P5完成，
矩阵对应行继续保持Pending，最终状态只在完整验收后更新。

### 2026-10-03 TGC-P4 Relay双协议

实现范围：

- discovery按每模型`/responses`优先、Chat-only回退的规则捕获不可变协议绑定；
  Provider公开稳定Router protocol，实际Client在`InvocationSource.wireProtocol`记录wire协议。
- `capabilities.supports.reasoning_effort`只投影已知显式等级，保留Provider顺序；
  未知非空字符串按计数诊断并忽略，全未知保留模型但不发布能力，结构非法拒绝候选snapshot。
- Responses精确映射`reasoning.effort`；新增独立Relay Chat Client映射`reasoning_effort`，
  支持文本、媒体、Tool及Chat reasoning replay，不导入Built-in私有模块。
- 双endpoint固定走Responses，失败不切Chat重试；Chat-only固定走Chat。
- 根包发布清单及npm审计权威加入`chat-client.ts`，对应自动审计测试通过。

验证：

| Gate | 结果 |
|---|---|
| P4聚焦测试 | Relay Unit/Router/Responses/Chat/entry共62项通过 |
| Relay完整验证 | 7 files，108/108通过 |
| Unit | 112 files，1359/1359通过 |
| Integration | 7 files，22/22通过 |
| Type/lint | 根项目及两个Workspace通过 |
| Build | TypeScript、Host build audit（354 files）通过 |
| 包清单审计 | audit/verify脚本自动测试9/9通过；发布allowlist包含Chat Client |
| npm临时安装验证 | `verify:package`打包完成后因当前Node 20与项目`engines.node=22.x`不符而`EBADENGINE`；未放宽引擎 |
| Fitness | 12 files、42项通过；仅FT-12的既有日期断言失败 |

TGC-23–26、32及35取得P4范围证据；UI排序、选择和摘要仍由P5完成。
未进行失败协议重试或真实Relay调用，未把未知等级映射为相邻值。

### 2026-10-03 TGC-P5 Web与最终Gate

实现范围：

- WebSocket Catalog DTO补齐reasoning能力深拷贝；HTML客户端仅在选中模型声明显式值时显示
  对应控件，Default固定首项，Thinking和Effort按公共UI顺序展示。
- 编辑器初始为Default+Default；模型切换逐字段保留仍受支持的显式值，只重置不支持维度并
  显示提示，不建立每模型历史选择。
- `off + none`两种选择顺序均可达；冲突选项被禁用并给出说明，Runtime最终校验仍保留。
- 发送前构造并快照原始reasoning preference；首次Session创建等待期间及运行中Turn不受后续
  UI选择影响。实时用户消息和History都从结构化字段渲染同一摘要。
- Host smoke删除已被WebSocket契约禁止的`maxLlmCalls`，改为通过Relay metadata发布`high`
  并断言`run_turn.reasoning.effort`端到端到达Responses请求。
- 当前架构及稳定Model Resolution、Runner、Channel契约已同步。

验证：

| Gate | 结果 |
|---|---|
| WebSocket聚焦测试 | 47/47通过；Catalog reasoning DTO、客户端资产及History结构化字段覆盖 |
| 浏览器交互 | 真实HTML + 可控WebSocket通过：Default初始、乱序能力排序、无能力隐藏、逐字段保留/重置提示、`off + none`双顺序、请求payload、实时与History摘要 |
| Unit | 112 files，1361/1361通过 |
| Integration | 7 files，22/22通过 |
| Relay完整验证 | 7 files，109/109通过 |
| Type/lint | 根项目及两个Workspace通过 |
| Build | TypeScript、Host build audit（354 files）及Relay验证通过 |
| WebSocket Host smoke | 通过；合法reasoning effort端到端到Relay Responses请求 |
| Fitness | 12 files、42项通过；仅FT-12的既有日期断言失败 |
| npm临时安装验证 | `verify:package`仍因当前Node 20与项目`engines.node=22.x`不符而`EBADENGINE`；包清单审计9/9已在Integration通过 |
| 独立评审 | 发现并修复2项中优先级契约偏差：Responses summary冒充独立on、Relay重复已知effort静默去重；相关测试94/94及最终全量Gate通过 |

TGC-01–38均有对应阶段自动证据；TGC-06、21、27–28、30、33–34、38另有浏览器证据。
没有真实模型调用或费用。技术Gate完成，保留已知FT-12日期基线和Node版本环境限制，等待
所有者接受后归档。

### 2026-10-03 Built-in OpenAI独立开关补齐

- 两个本地Relay-backed Built-in模型确认并配置`thinking: ["on", "off"]`。
- Responses与Chat Client只为逐模型声明该能力的模型启用映射：
  `on + default`省略effort，`off + default/none`精确发送一次`none`；未声明模型fetch前拒绝。
- Built-in配置校验不再错误拒绝OpenAI模型的合法Thinking能力；Anthropic私有adapter约束不变。
- 真实`test-workspace/config.json`通过Built-in配置校验；未执行真实模型调用。
- 聚焦配置/Provider/Client测试80/80、Unit 1360/1360、Integration 22/22、build/Relay及lint通过。
