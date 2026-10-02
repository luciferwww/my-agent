# Thinking Generation Controls Validation

> Status: Not Started — delivery validation pending
> Date: 2026-10-03
> Authority: Acceptance matrix, evidence and gate tracking only
> Related: [Plan](plan.md), [Specification（Draft）](specification.md)

## 1. 证据基线与执行边界

本次只建立正式Change和导航，未修改生产代码、用户配置或运行生产测试/真实模型请求。
研究草稿的JSON、链接、围栏及验收编号检查只证明文档结构，不证明目标功能实现。
已有采集与展示测试属于基线，不能代替本Change新增控制、Anthropic或Relay双协议验收。

下表全部为待验证目标。“自动”表示离线Unit/契约/集成测试，使用fake fetch或fixture；
“自动＋Web手工”还需浏览器验证。LLM请求为零不包含预先发生的独立Catalog discovery。
不重复保存研究讨论；本表作为正式验收及后续执行结果的owner。

## 2. 验收矩阵

| ID | 场景与必须观察到的结果 | 类型与主要验证面 | 状态 |
|---|---|---|---|
| TGC-01 | 策略省略：开关省略、effort=default，wire不变，无全局默认层 | 自动；三Client默认请求对照、配置 | Pending |
| TGC-02 | 能力缺失/空/仅开关/仅effort：只提供声明选项，不丢实际合法Thinking | 自动；能力契约、采集 | Pending |
| TGC-03 | Built-in非法schema：配置/候选staging失败，不发布Catalog；reload保留旧generation | 自动；配置、Unit生命周期 | Pending |
| TGC-04 | 合法显式选项不受模型支持：解析后以capability_unsupported失败；Runner、MessageRecord和LLM请求均未发生，不降级 | 自动；Model Resolution与Runtime边界 | Pending |
| TGC-05 | 同协议不同模型：使用各自schema与冻结事实 | 自动；Provider、Resolver | Pending |
| TGC-06 | Responses high且有私有summary事实：发送high/auto，可读文本进入卡片/History | 自动＋Web手工；请求与公开投影 | Pending |
| TGC-07 | Responses high无summary事实：只发送effort，不猜summary | 自动；Client请求fixture | Pending |
| TGC-08 | Responses none：精确发送none，不请求summary，实际文本仍展示 | 自动；请求、采集与投影 | Pending |
| TGC-09 | Chat high/none：仅发送允许的reasoning_effort | 自动；Client请求fixture | Pending |
| TGC-10 | Anthropic adaptive on/high/off/none：on不补effort，high用adaptive+effort，关闭用disabled | 自动；请求fixture、能力校验 | Pending |
| TGC-11 | Anthropic budget等级：用配置预算，不发送output_config.effort | 自动；配置、请求fixture | Pending |
| TGC-12 | Anthropic静态adapter/预算不一致在配置/staging失败；动态输出冲突preflight失败，不自动调整 | 自动；配置、有效输出上限与请求计数 | Pending |
| TGC-13 | Anthropic redacted：有序保存replay-only块，不生成空卡片 | 自动；事件、Collector、公开投影 | Pending |
| TGC-14 | Anthropic同源工具续轮：thinking/signature/redacted按验证协议顺序恢复 | 自动；多次调用与工具关联fixture | Pending |
| TGC-15 | 三协议互切：不兼容replay省略，正文/Tool关联保留 | 自动；目标Client请求、源Transcript不变 | Pending |
| TGC-16 | Anthropic→OpenAI→Anthropic：各次只投影兼容且经校验replay，不改Transcript | 自动；往返切换、恢复 | Pending |
| TGC-17 | 同协议来源冲突：发送前失败，opaque不进日志 | 自动；来源、请求计数、安全错误投影 | Pending |
| TGC-18 | 运行中改变选择：当前Turn模型/策略固定，新消息采用新快照 | 自动；Runtime队列、generation/Runner | Pending |
| TGC-19 | 不同resolved策略的Steering留在FIFO下一Turn，不注入当前Turn | 自动；队列、Runner领取 | Pending |
| TGC-20 | Abort/流错误：可读partial保留，无未完成replay | 自动；三协议流与持久化 | Pending |
| TGC-21 | reload/Fork：可读文本/原始策略恢复、摘要一致、History无opaque、不继承历史策略 | 自动＋Web手工；磁盘恢复、History | Pending |
| TGC-22 | Compaction不继承用户策略/请求summary；内部Thinking/replay不持久化，只保存摘要正文 | 自动；内部调用、Transcript及事件 | Pending |
| TGC-23 | Relay GPT/Gemini discovery分别绑定Responses/Chat并发布准确effort | 自动；metadata、Provider/Router | Pending |
| TGC-24 | Relay已知值投影；未知非空字符串诊断后忽略；全未知保留模型但无显式effort | 自动；metadata、诊断 | Pending |
| TGC-25 | Relay双endpoint稳定绑定Responses；跨协议历史正确过滤，无失败后协议重试 | 自动；Router请求次数、历史 | Pending |
| TGC-26 | 静态Catalog在staging校验，动态descriptor在解析时校验；同一深冻快照、不发布错误候选 | 自动；Registry/Resolver、Provider | Pending |
| TGC-27 | Web首次选模型为Default+Default；切换时逐字段保留新模型支持值，不支持项重置Default并提示，不恢复按模型旧值；已入队/运行中Turn不变 | 自动＋Web手工；模型切换与队列快照 | Pending |
| TGC-28 | 正常Turn无Display隐藏控制；实际可读Thinking显示；内部调用按TGC-22隔离 | 自动＋Web手工；实时/历史/CLI回归 | Pending |
| TGC-29 | off+high或on+none等通用冲突在Runtime intake拒绝，不入队、不保存MessageRecord、不调用LLM | 自动；入口/组合校验 | Pending |
| TGC-30 | off+none且各自支持：两种选择顺序可用，关闭只映射一次，无冲突effort | 自动＋Web手工；组合与请求fixture | Pending |
| TGC-31 | Anthropic budget独立on需要defaultBudgetTokens并满足max_tokens；缺失时不发布on | 自动；配置、staging与调用限制 | Pending |
| TGC-32 | Relay只有effort：只提交effort即可调用，不强制thinking字段 | 自动；消息、能力、Client请求 | Pending |
| TGC-33 | Built-in无选项隐藏控件，语义Default；有选项才显示，不创建调用默认 | 自动＋Web手工；配置、Catalog、控件 | Pending |
| TGC-34 | 显示控件的Default是首项且初始选中；隐藏维度也按Default；thinking省略、effort解析default，不依赖Relay默认metadata | 自动＋Web手工；初始化、提交与规范化 | Pending |
| TGC-35 | Relay非数组/非字符串/空白等结构非法：候选失败，不发布Catalog，reload保留旧generation | 自动；discovery、Unit生命周期 | Pending |
| TGC-36 | reasoning省略/空对象/显式default执行等价，History/reload/Fork保留原始形态，摘要一致，不被resolved覆盖 | 自动；规范化、磁盘与DTO结构断言 | Pending |
| TGC-37 | effrot等未知字段由Channel解析或Runtime intake拒绝；Runtime不信任Channel，不入队、不保存MessageRecord、不调用LLM | 自动；Channel/WebSocket及Runtime入口 | Pending |
| TGC-38 | 快照保留Provider有效顺序，Web按公共枚举排序且Default首项，不增补能力或改请求值 | 自动＋Web手工；乱序metadata与控件 | Pending |

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

Relay交付时按影响运行verify:relay及verify:package；WebSocket Host有接线变化时运行
verify:websocket-host。上述为后续验证计划，本次没有执行。
执行记录必须区分离线fixture、浏览器组件测试、Host集成和真实模型接受性。
离线成功不证明任意模型/version接受参数；必要真实验证使用合成输入并先确认费用边界。

## 4. Gate与证据记录

| Gate/记录 | 当前状态 | 需要的证据 |
|---|---|---|
| 文档准备 | Created；结构检查通过 | 文件/导航存在、链接、JSON、围栏、38项覆盖、空白检查 |
| G0 Spec与Delivery接受 | Passed（2026-10-03） | 所有者接受Spec、确认TGC-P1，并授权继续至完整实施 |
| 协议fixture准备 | Pending | 来源/版本、有效预算约束、请求/事件/工具续轮fixture；必要有界Spike结论 |
| 各Plan Item聚焦验证 | TGC-P1–P3 Completed；TGC-P4 In Progress | 命令、执行结果、关联TGC及具体失败/限制 |
| G1完整验收 | Not Started | 自动/浏览器/集成/构建证据、独立评审、文档同步与所有者接受 |

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

- Responses精确映射显式effort；仅配置`readableSummary`的模型在显式非none或独立on时请求
  `summary=auto`。Chat Completions只映射`reasoning_effort`，两个协议的Default wire均不变。
- Built-in逐模型校验私有summary及Anthropic adaptive/budget adapter；budget值、能力声明、
  独立on和默认/等级预算在配置与Provider staging时一致，动态`max_tokens`冲突在fetch前失败。
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
