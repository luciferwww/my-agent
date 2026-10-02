# Thinking Generation Controls Specification

> Status: Draft
> Date: 2026-10-03
> Owner: Project owner
> Related: [Plan](plan.md), [Validation](validation.md), [Research source](../../../research/thinking-generation-and-display-controls-design-draft.md)

## 1. Purpose, scope and non-goals

模型声明可兑现的开关/effort，消息携带选择，Turn内固定策略。
省略控制时保持现有请求；正常用户Turn实际返回的合法可读Thinking仍保存和展示。
范围包括Built-in三协议、Relay双协议、原始策略恢复及Web选择。

不引入全局`llm.thinking`/reasoning默认、reasoningDefaults、Session继承、Display开关、
任意schema/wire模板、模型名猜测、隐式预算、跨协议opaque转换、新重试或快照机制。
不重做已交付的Responses/Chat采集与展示，不改变store或服务端conversation默认。

## 2. Boundaries and dependency direction

| Owner | 职责 |
|---|---|
| Core Model契约 | 公共能力/策略类型、解析后的调用策略、canonical Thinking与opaque envelope |
| Provider | 不可变模型快照、Catalog/Facts一致投影、私有能力/adapter及模型路由 |
| Protocol Client | wire参数、事件、signature/redacted/opaque codec、目标历史投影及来源校验 |
| Runtime/Runner | 入口校验与队列快照、模型能力检查、Turn固定策略、Steering与调用类型隔离 |
| Session | 保存合法原始消息策略与已有Thinking块，History安全投影、恢复/Fork |
| Channel/Web | 提交结构化策略，按能力展示选项和摘要，不替代Runtime校验 |

Core不认识summary/adaptive/budget wire字段，不读取Provider私有配置。
Relay不能导入Built-in私有Client模块；共享内容只通过现有公共Extension API提供。
沿用[Model Resolution](../../../specifications/model-resolution.md)的membership顺序、
Provider快照义务及immutable per-Turn binding，不增加snapshot handle。

## 3. Public and structural contracts

```ts
type ThinkingEffort =
  | 'default' | 'none' | 'minimal' | 'low'
  | 'medium' | 'high' | 'xhigh' | 'max';
type ExplicitThinkingEffort = Exclude<ThinkingEffort, 'default'>;
type ThinkingSwitch = 'on' | 'off';

interface ReasoningCapabilities {
  readonly thinking?: readonly ThinkingSwitch[];
  readonly efforts?: readonly ExplicitThinkingEffort[];
}
interface ReasoningPreference {
  readonly thinking?: ThinkingSwitch;
  readonly effort?: ThinkingEffort;
}
interface ResolvedReasoningPolicy {
  readonly thinking?: ThinkingSwitch;
  readonly effort: ThinkingEffort;
}
```

- 能力只列模型/endpoint/Client可兑现的值，不是内部是否推理的boolean，也不保证可读输出。
- `thinking`只接受无重复on/off数组；`efforts`只接受无重复已知显式等级数组。
- schema或数组省略/为空表示没有该维度已确认的选项，不表示模型不会推理。
- Default由Host提供，不进入能力数组；`none`与独立开关`off`各自声明。
- 独立on必须能在effort省略时启用，不偷偷选择某个等级。
- 能力深度复制/冻结，保持Provider有效选项顺序；顺序不表达默认或优先级。
- 当前消息策略只接受thinking/effort；未知字段（如effrot）、未知值、null、数组和
  非对象由Channel协议解析及Runtime intake防御校验拒绝，不入队、不保存MessageRecord、
  不调用LLM。只读取自身字段。
- 不另建全局对象原型检查。未来增加字段/等级时扩展契约、校验及消费者，
  不静默接收当前无法消费的字段，也不预建版本协商或扩展容器。

ProviderModelFacts及Resolved Facts增加可选`reasoning`；
Catalog的`capabilities.reasoning`与Runtime DTO由同一快照投影。
Channel/WebSocket消息增加`reasoning?: ReasoningPreference`；
正常ModelInvocationRequest携带`reasoning?: ResolvedReasoningPolicy`，不携带schema或wire参数。

消息示例；仅声明并实现相应能力的模型可接受：

```json
{
  "reasoning": {
    "thinking": "on",
    "effort": "high"
  }
}
```

### 3.1 Default与组合

省略thinking保留Provider默认；省略effort规范化为default。
省略reasoning、空对象、显式effort=default执行等价，不继承全局或模型调用默认。

| 组合 | 行为 |
|---|---|
| 开关省略 + default | 不增加推理/summary控制参数 |
| 开关省略 + 声明的显式effort | 精确映射该等级所需的参数 |
| on + 省略/default | 独立开启，不补公共默认等级 |
| off + 省略/default | 只执行关闭 |
| off + none | 两者各自受支持时允许，关闭映射一次 |
| off + 其他显式effort；on + none | invalid request，不忽略任一字段 |

off+非none显式effort、on+none等通用冲突不依赖模型事实，在Runtime intake拒绝，
不入队或保存MessageRecord。合法但模型未声明支持的选择在选定模型解析后返回现有
`capability_unsupported`，且在Runner、Session消息写入和LLM调用之前失败。
两类错误都不能由UI的禁用逻辑代替Runtime校验。
none不推导整组on/off，协议名称或数组首项不成为能力/默认事实。

## 4. Configuration, lifecycle and publication

Built-in可选位置为`llm.builtin.models[n].reasoning`，仅声明能力。
省略时保留默认调用及被动采集；不存在partial merge或调用默认继承。

```json
{
  "llm": {
    "builtin": {
      "baseURL": "http://127.0.0.1:5000/v1",
      "models": [{
        "modelId": "gemini-3.8-flash",
        "protocol": "openai-chat-completions",
        "reasoning": { "efforts": ["low", "medium", "high"] }
      }]
    }
  }
}
```

- 配置加载校验字段结构、值、重复项，错误指向models[index]的具体字段。
- Provider创建/generation staging验证静态能力、私有adapter、路由及codec可用性；
  未实现或没有有效映射的能力不能发布。
- 候选失败不发布新Catalog，reload保留旧generation；首次启动按现有Unit失败策略处理。
- Catalog/descriptor来自同一深冻快照；Host在staging校验可观察Catalog，在解析时
  校验实际descriptor。不得为了比较而预先resolve所有模型或发送探测请求。
- 实际descriptor、请求组合、调用期输出预算、历史replay内容/来源在相应解析或
  preflight阶段检查；未来响应的codec合法性在消费事件时检查。
- 不把静态配置错误推迟到首次发送，也不宣称staging可以验证任意未来Session payload。

## 5. Turn, Steering and persistence

Channel可按自身wire协议先拒绝非法形态；Runtime intake仍统一校验、复制原始策略并
拒绝未知字段和通用组合冲突，不信任Channel已完成校验。模型能力检查在解析选定模型时
完成；调用期输出预算和wire构造冲突留给对应Client/Provider preflight。后两者都必须在
上游fetch前失败，但不回填为入口结构错误，也不新增跨层通用错误框架。
解析后的策略随现有generation pin固定，正常工具循环使用同一对象。
UI改变只影响之后提交的消息，当前调用不换模型/协议/策略。

模型及resolved开关/effort相同的Steering可在现有安全点领取；不同则留在Session FIFO，
作为下一Turn。比较resolved策略，因此省略、空对象和default可执行等价。

用户MessageRecord增加可选reasoning元数据；主消息及实际领取的Steering消息各自保存
合法原始选择。公共user_message事件与History DTO投影同一字段：

- 区分对象省略、空对象和显式default；恢复结构化字段，不保存本地化摘要字符串。
- resolved策略不能覆盖原始字段，不必另存durable resolved副本。
- reload/Fork忠实保留原始形态；不把历史策略变成后续消息默认。
- 旧记录缺失该字段按Default渲染，不推测曾经的选择。
- 元数据不进入LLM历史content或user wire字段；模型身份沿现有绑定展示路径。
- 使用现有Transcript校验、复制及History路径，不新建策略存储或模型默认体系。

Compaction是内部调用：继续用同一模型绑定，不继承用户显式策略，不主动请求summary，
只消费正文构造并保存摘要。该内部调用的Thinking/signature/replay不进入用户Transcript、
RunResult或History；不因此额外删除原会话已有Thinking。

## 6. Protocol Client behavior

### 6.1 Responses与Chat

| Policy | Responses | Chat Completions |
|---|---|---|
| 开关省略 + default | 不增加reasoning | 不增加推理参数 |
| 开关省略 + 显式effort（含none） | reasoning.effort精确值 | reasoning_effort精确值 |
| 独立开关 | 只有已验证具体adapter才能声明 | 同左；首期通用映射不发送enable_thinking |

首期通用OpenAI两协议只提供effort，不推导独立on/off。
未来具体adapter可验证关闭或开启路径；不能通过summary冒充开启或偷偷补medium。
Chat现有reasoning_text/reasoning_opaque不是所有兼容服务的统一协议。

Built-in模型私有可选`readableSummary: "auto-on-explicit-reasoning"`仅用于已验证的
Responses summary路径；省略就不主动请求，不公开到能力schema。
正常用户调用显式非none等级或已验证独立on时附加`reasoning.summary="auto"`。
Default、关闭/none、内部调用不请求；未返回可读summary正常结束，不造空卡片。

### 6.2 Anthropic

新增anthropic-messages Thinking codec，采集有序thinking/signature/redacted块，
沿用canonical生命周期和Provider-owned replay envelope。
私有模型字段`anthropicThinking`仅用于anthropic-messages，不投影Core/Catalog：

```ts
type AnthropicThinkingAdapter =
  | { readonly mode: 'adaptive' }
  | {
      readonly mode: 'budget';
      readonly defaultBudgetTokens?: number;
      readonly budgets?: Partial<
        Record<Exclude<ExplicitThinkingEffort, 'none'>, number>
      >;
    };
```

| Policy | Wire |
|---|---|
| 开关省略 + default | 不新增thinking/output_config.effort |
| 支持的off或none | thinking.type=disabled，不发送effort；off+none只映射一次 |
| on + default，adaptive | thinking.type=adaptive，不补effort |
| on + default，budget | thinking.type=enabled + 明确defaultBudgetTokens |
| on或开关省略 + adaptive支持的等级 | adaptive + output_config.effort精确值 |
| on或开关省略 + budget已配置等级 | enabled + 对应budget_tokens |

不发送thinking.type=none或output_config.effort=none，不猜mode或数字，不将minimal/xhigh
换成相邻等级。预算须为安全整数并满足目标API最低预算及有效max_tokens约束；
静态不一致在配置/staging失败，实际输出预算冲突在preflight失败，不自动调整上限或预算。
budget独立on要求defaultBudgetTokens；只有等级预算时可提供efforts但不提供on。
关闭与各等级分别声明支持。fixture必须覆盖请求、签名、redacted、流错误和工具续轮；
模型/version接受性依据在对应步骤补证，示例或竞品默认不证明所有模型支持。

### 6.3 Relay

保持Provider identity，公开protocol使用稳定Router标识并与descriptor一致；
实际wireProtocol进入invocation source，不要求Core识别Router内部协议。
新增独立Chat Client，不复制Builtin私有模块。

- discovery支持responses时绑定Responses；双endpoint优先Responses，保持既有路径。
- Chat-only绑定Chat；两者都没有不进入可调用Catalog。
- 一个generation捕获元数据及私有路由绑定；Turn固定该绑定，不在失败后换协议重试。
- reasoning_effort已知值精确投影为efforts，不推导独立开关、summary或默认值。
- 未知非空字符串忽略并作有界内容无关诊断；全未知保留其他准入条件合格的模型，
  但不发布显式effort；字段缺失/空数组不意味着无内部推理。
- 字段非数组、元素非字符串或空/空白字符串等结构非法时拒绝候选snapshot；
  不静默回退为空能力，reload保留旧generation。
- min/max_thinking_budget不自动换算等级；summary只可来自额外可信事实及已实现路径。

## 7. Thinking output, Abort and security

沿用已有collector及安全投影：Thinking/正文/Tool保序，一个assistant可有多个Thinking块。
complete可包含空text和replay；partial只保存已获取可读文本，不生成未完成replay。
正常Turn即使选off/none仍采集、展示并保存实际合法可读内容；不保证零reasoning token。

目标Client过滤不兼容协议Thinking，保留普通正文/Tool关联，不改Transcript或把opaque
转成正文。同协议校验来源和codec；不把modelId变化单独当成必然不兼容。
新增Anthropic路径不宣称任意历史编辑、跨模型或Compaction后签名都可无条件复用。

Public事件、History、RunResult及日志不含opaque/signature/encrypted payload。
日志只记录安全策略/状态/长度，不记录Thinking文本或replay内容。
Abort/流错误沿用已有终态和partial保存，不新增自动协议重试。

## 8. Web behavior and compatibility

- 每维有非默认能力才显示控件；无选项隐藏，语义等价于Default。
- 显示控件以Default为首项；Thinking显示on/off（默认/开启/关闭），effort只显示声明值。
- UI首次选择模型后，Thinking与Effort均选中Default；隐藏的维度同样按Default处理。
- 用户切换模型时逐字段检查原选择：新模型仍支持的显式值继续保留；不支持的维度重置
  为Default并给出简短提示。Default始终可保留，不维护每个模型的历史选择。
- 重置后重新应用通用组合规则；UI调整不能替代Runtime对最终提交策略的校验。
- UI排序为on → off，以及none → minimal → low → medium → high → xhigh → max。
  不改能力快照或请求值；未来增加枚举时定义展示位置，不新增能力准入约束。
- Thinking Default省略字段；effort Default可省略或传default；两者默认可省略整个对象。
- 选择off保留Default及支持的none，禁用其他显式等级；none禁用on。
  冲突提示重选，不静默清值，off+none的两种选择顺序均可用。
- 模型切换的保留/重置只修改尚未提交的编辑器状态；已入队消息及运行中Turn继续使用
  各自快照。
- 历史摘要由原始结构化字段生成；三种Default形态可显示相同摘要。
- Thinking卡片继续实时展开、正文/Tool后折叠、历史默认折叠；CLI首期不加控制命令。

省略新配置/字段保持现有行为；没有旧thinking外壳、boolean或reasoningDefaults兼容别名。
没有新增覆盖层、迁移平台或临时生产路径。交付时同步当前规格和架构，不能提前将
本Draft写成已实现事实。

## 9. Acceptance, validation and open points

[validation.md](validation.md)是本Change验收矩阵和执行证据的唯一owner，保留TGC-01–38。
每步聚焦Unit/契约验证，跨边界集成、相关Fitness及最终lint/build/Relay/浏览器验证
按Plan执行；文档创建不算生产行为验证，不自动调用计费模型。

当前无新增公共语义待决策。Delivery前仍需所有者接受本Draft及对应步骤授权；
Anthropic目标协议fixture、有效预算约束、Relay Router实际标识与包清单接线在实施中
核实并记录，不据此增加公共配置层。若证据要求改变语义则回到Plan停止条件。
