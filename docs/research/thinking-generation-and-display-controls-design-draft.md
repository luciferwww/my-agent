# Thinking 生成与展示控制设计草稿

> Status: Non-authoritative design draft
> Date: 2026-10-03
> Scope: Per-model reasoning controls, Thinking on/off and effort preference, Turn snapshot, three Built-in protocols, and dual-protocol Copilot Relay
> Related: [Thinking 采集与展示归档 Change](../changes/archive/thinking-capture-and-display/plan.md), [Model-Aware Output Control](../changes/archive/model-aware-output-control/model-aware-output-control-specification.md), [Providers Current Architecture](../architecture/providers.md), [Runner Turn Flow](../specifications/runner-turn-flow.md)
> Handoff: [Thinking Generation Controls Active Change](../changes/active/thinking-generation-controls/plan.md)及其[Draft Specification](../changes/active/thinking-generation-controls/specification.md)承接契约准备；[validation](../changes/active/thinking-generation-controls/validation.md)承接38项正式验收。本研究保留讨论来源，不独立授权Delivery。

## 1. 背景与决策

当前已实现 Responses/Chat Thinking 的被动采集、内部 replay、安全公开投影和
CLI/Web 展示。Anthropic 原生 Thinking 尚未接入；Copilot Relay 扩展目前只接入
Responses，本地 Relay 服务则同时提供 Responses 和 Chat Completions。

受控实测确认：

- GPT Responses 默认可能只返回 encrypted reasoning，没有可读 summary；
- Responses的`summary: "auto"`可选择不返回摘要；需要兑现Thinking On展示语义时使用
  已验证的`reasoning: { effort: "high", summary: "detailed" }`；
- Gemini Chat 默认可以返回`reasoning_text`；
- Relay `/v1/models`逐模型提供`reasoning_effort`和`supported_endpoints`；
- 可读文本和 Provider continuation state 不是同一类数据。

采用最小控制面：

- 模型 schema 描述`thinking`开关和`efforts`各自允许的值；
- 用户在模型支持时选择Thinking开启/关闭，也可选择effort；
- 用户可见正常Turn中实际返回的合法可读Thinking采集、展示并保存；内部调用见§6；
- 不提供独立 Display 控件，也不增加隐藏或丢弃可读文本的持久化规则；
- summary请求和Anthropic wire映射由各自Protocol Client内部处理，不进入用户配置；
- Core 保留统一事件、History 外壳和 opaque replay envelope。

OpenClaw 用作协议实现参考，不复制其所有默认值、模型名判断或覆盖层级。
本草稿不授权生产代码实现；已建立Active Change，生产Delivery仍需按其Gate获准。

## 2. 目标与非目标

目标：

1. 同一公共 schema 支持 Responses、Chat Completions 和 Anthropic Messages。
2. 开关省略且effort为`default`时保持现有wire请求，不增加生成或summary参数。
3. 模型能力、调用策略、Provider wire 映射三者分离。
4. Turn 内模型、Thinking开关及effort不可变，工具循环继续使用同一策略。
5. 不支持的显式选项及冲突组合在发送前失败，不静默降级。
6. replay 不进入公共事件、RunResult 或用户 History。
7. 新 Provider 通过实现自己的 Client 接入，不要求 Core 认识其 wire 字段。

首期不做：

- Slash 命令、多层 Agent/Session/per-model 用户策略覆盖；
- 任意 JSON Schema、JSON Pointer 或请求模板驱动 wire 改写；
- 根据模型名称猜能力或 Anthropic 生成模式；
- 跨 Provider/protocol 转换 opaque state；
- 从普通正文中的`<think>`标签猜测 Thinking；
- 暴露Anthropic专用生成配置或要求用户理解wire字段；
- 服务端 conversation、`previous_response_id`或新重试机制。

## 3. 公共能力 schema

```ts
type ThinkingEffort =
  | 'default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

type ExplicitThinkingEffort = Exclude<ThinkingEffort, 'default'>;

type ThinkingSwitch = 'on' | 'off';

interface ReasoningCapabilities {
  readonly thinking?: readonly ThinkingSwitch[];
  readonly efforts?: readonly ExplicitThinkingEffort[];
}
```

两个数组描述用户可控制的选项，不是模型是否内部推理的boolean标记：

| Schema | 语义 |
|---|---|
| 整个schema缺失 | 没有已确认的控制能力，只允许省略开关和默认effort |
| `thinking`省略 | 不提供已确认的独立开关，不表示模型不会推理 |
| `thinking=[]` | 明确没有可供用户选择的独立开关 |
| `thinking=["on","off"]` | Client能够兑现独立开启、可读Thinking请求和关闭 |
| `thinking=["off"]` | 只确认独立关闭路径，不承诺独立开启 |
| `efforts`省略或为空 | 不提供显式等级，只允许默认effort |
| `efforts=[...]` | 允许列出的显式等级 |

模型可以只声明effort而不声明开关，或只声明开关而不声明等级。
数组表达的是模型/endpoint与Client组合能够兑现的控制。effort本身不保证返回可读
Thinking；独立`on`必须能在不指定effort的情况下开启推理并请求可读Thinking，否则不能声明。

schema缺失或空数组不能成为丢弃合法上游Thinking的理由。实际收到的结构化事件仍按已
实现的codec校验、采集和投影。

校验规则：

- `thinking`只能是无重复的`on/off`数组，不接受boolean或字符串`true/false`；
- `efforts`只能是无重复的已知等级数组；
- 默认状态由Host提供，不进入能力数组；
- effort的`none`不是必须选项，也不增加effort=`off`别名；Thinking开关的`off`是另一个字段；
- schema 不包含请求字段、数值预算、signature 或 replay codec。

能力快照保留Provider声明的有效选项顺序，但数组顺序不表达优先级或调用默认。
Web展示顺序见§9，不为排序改写能力快照。

示例只说明配置形态；实际模型等级以有效 metadata 和协议验证为准：

```json
{
  "efforts": ["none", "low", "medium", "high", "xhigh", "max"]
}
```

```json
{
  "thinking": ["on", "off"],
  "efforts": ["low", "medium", "high"]
}
```

不同 Provider 的相同等级代表其自身声明的强度，不能承诺相同 token 预算、延迟或效果。

## 4. 用户策略与Turn入口

```ts
interface ReasoningPreference {
  readonly thinking?: ThinkingSwitch;
  readonly effort?: ThinkingEffort;
}
```

调用中的`thinking`是本次开关选择，和能力数组含义不同：

- 省略：不要求独立启用或关闭，不发送额外开关字段；
- `on`：显式请求启用Thinking，不是要求显示卡片；
- `off`：显式请求关闭Thinking，不是隐藏卡片；
- `effort`省略时规范化为`default`。

| 值 | 语义 |
|---|---|
| `default` | 不指定强度；若开关也省略则保持当前Provider请求，显式开关仍单独生效 |
| `none` | 显式请求 Provider 支持的无推理模式，不是隐藏内容 |
| `minimal` | 最低的非关闭推理等级 |
| `low/medium/high` | Provider 声明的对应等级 |
| `xhigh/max` | 仅在模型明确支持时提供的扩展等级 |

`default`不等于`medium`或`none`。Copilot UI 将 Medium 标为默认，不足以证明省略请求字段
等于 medium；当前 discovery 没有提供明确的 effort default。

只提供消息携带的Turn策略，不新增全局reasoning配置。用户先选择模型，再从模型声明的
开关和effort选项中选择；Channel请求示例中的策略片段为：

```json
{
  "reasoning": {
    "thinking": "on",
    "effort": "high"
  }
}
```

这个组合要求模型分别支持`on`和`high`，并符合下面的组合规则。只提供effort的模型可以
只传`reasoning: { effort: "high" }`。关闭可只传`reasoning: { thinking: "off" }`。

省略整个对象等价于开关省略且`effort=default`，不需要全局配置重复声明。
模型schema是能力，不能自动变成调用默认。显式开关或等级未声明支持时返回
`capability_unsupported`，不调用fetch。

Default是策略语义，不要求一定渲染控件；有非默认选项而显示的控件始终以Default为首项。
不要求模型能力数组包含`default`：

- Thinking选择Default时，Channel省略`reasoning.thinking`；
- Effort选择Default时，Channel可省略effort或发送`effort="default"`，Runtime统一解析；
- 两项都为Default时可省略整个`reasoning`；
- 模型配置只声明允许值，不预设用户选择，不存在默认值继承链。

### 4.1 组合规则

两个能力数组不表示其笛卡尔积全部合法：

- `off`与任何显式非`none`effort冲突，发送前报invalid request；
- `on`与`none`冲突，发送前报invalid request；
- `off`加省略/default effort只执行关闭路径；
- `off + none`只有两个值都被模型声明支持时允许，关闭映射只执行一次；
- `on`加省略/default effort执行独立开启，不补公共默认等级；
- 开关省略加显式effort由Client完成等级所需的启用或关闭参数；
- `none`仅通过efforts声明控制，不因此隐式发布独立`on/off`能力。

未知类型、值和冲突属于无效请求；合法但不支持的选项属于capability错误。
Provider不能静默忽略开关或effort来构造“成功”的请求。

当前`ReasoningPreference`只接受`thinking`和`effort`字段；例如`effrot`等未知字段
在Turn入口明确返回invalid request，不进入队列、不保存错误策略，也不发起LLM请求。
对象形态沿用入口的JSON对象校验，拒绝null、数组和非对象；只读取自身字段，不从
原型链取得策略。无需另建覆盖所有内部对象的原型检查机制。
这不是永久封闭字段集合：未来新增策略字段时同步扩展契约、校验和消费逻辑，而不是
让当前版本静默接受无法兑现的字段；不引入版本协商或扩展字段容器。

## 5. Model Facts、Catalog 与 Built-in

建议模型事实和 Catalog 各自投影同一份 schema：

```ts
interface ProviderModelFacts {
  // existing facts...
  readonly reasoning?: ReasoningCapabilities;
}

interface BuiltinModelRegistration {
  readonly modelId: string;
  readonly protocol: BuiltinProtocol;
  // existing fields...
  readonly reasoning?: ReasoningCapabilities;
}
```

可选配置的准确位置是`llm.builtin.models[n].reasoning`。它只声明能力，不是每模型
调用默认；不增加`reasoningDefaults`或全局reasoning配置。

完整配置片段示例：

```json
{
  "llm": {
    "builtin": {
      "baseURL": "http://127.0.0.1:5000/v1",
      "models": [
        {
          "modelId": "gemini-3.8-flash",
          "protocol": "openai-chat-completions",
          "reasoning": {
            "efforts": ["low", "medium", "high"]
          }
        }
      ]
    }
  }
}
```

对于支持独立开关的模型，`reasoning`还可包含`thinking: ["on", "off"]`，
但必须有对应Client支持，不能因配置了数组就跳过协议能力验证。

省略该可选参数时没有非默认选项，两个控件均省略；对应策略仍是Default + Default，
消息不增加reasoning控制字段。能力数组有非默认选项时才显示相应控件，初始选择是Default，
不自动采用能力数组首项。

| Provider | 每模型能力来源 | 用户未选择时 |
|---|---|---|
| Built-in | `llm.builtin.models[n].reasoning`可选配置 | 保持当前上游请求 |
| Copilot Relay | discovery元数据及已验证的Client适配能力 | 保持当前上游请求 |

Relay不需要发现effort默认值来实现Default；Default表示不干预，而不是medium等确定等级。
不同来源最终投影到同一公共能力结构。

外层统一使用`reasoning`。模型对象中包含能力数组，消息对象中包含本次选择。
不增加旧`thinking`外壳、boolean开关或其他兼容别名；这些都尚未成为生产契约。

```text
Provider model snapshot
  ├─ ProviderModelFacts.reasoning -> ResolvedModel.facts.reasoning
  └─ ProviderCatalogModel.capabilities.reasoning -> Runtime DTO -> Web
```

要求：

- Built-in逐模型严格校验，错误指向`models[index].reasoning`的具体字段；
- 复制并深度冻结 schema 及数组，不只浅冻结 registration；
- Catalog 与 Resolver 来自同一不可变模型快照；
- Host 校验 schema 结构及可观察的一致性，不能读取 Provider 私有配置；
- Runtime DTO 只包含公共schema，不包含Protocol Client wire细节；
- 同协议下不同模型可以有不同 schema；
- 模型 schema 不是`invocationDefaults`。

### 5.1 校验阶段与publication

沿用现有generation staging、rollback和immutable per-Turn binding，不增加snapshot handle：

- 配置解析先校验Built-in字段类型、值和数组结构，错误在配置加载期报告；
- Provider创建及generation staging期间验证静态模型schema、已实现codec
  和路由能力的一致性，包括声明开关/等级是否有可兑现的映射；
- 静态配置错误不得等到用户发送才发现，不发布错误候选Catalog；
- reload/staging失败保留现有generation；首次启动失败按现有Unit失败策略处理，不假装
  发布成功，也不创建虚假的旧generation；
- Catalog与descriptor必须从同一模型快照构造；Host在staging验证可观察的Catalog，
  在现有模型解析阶段校验实际返回的descriptor；
- 不为预先比较而调用所有模型的`resolveModel()`、建立连接或发送模型请求；
- 用户请求组合、实际descriptor不一致、动态输出预算及历史replay来源/内容冲突仍在
  相应解析或调用preflight阶段失败；它们不一定能在generation创建时获知。

staging验证codec的可用性及能力声明，不验证未来响应或任意Session的opaque payload。
后者由目标Client在收到事件或回放前验证。

### 5.2 协议保守行为

协议本身不能证明模型支持独立开关或任何等级。因此不能从
`protocol=responses/chat/anthropic`自动补`thinking=["on","off"]`或efforts。

Built-in省略schema时保留未知状态，只允许省略开关和默认effort，不发送新增wire参数；
协议 Client 仍被动采集它已经支持的实际输出。这就是新的协议保守行为。
明确不提供控制时可发布空数组，不将其解释为模型没有内部推理。

显式 schema 完整替换未知状态，不做 partial merge。summary支持、生成模式等事实留在
Provider内部，并与同一模型快照绑定。

## 6. Turn、Steering 与内部调用

```text
Channel message reasoning preference
  -> Runtime normalize + enqueue snapshot
  -> Turn resolves model and validates switch, effort and combination
  -> immutable policy
  -> Runner passes it to normal Model calls
  -> Provider Router + target Client map wire parameters
```

Channel请求增加`reasoning?: ReasoningPreference`。WebSocket使用同名字段，发送时与
`modelReference`一起复制。

Turn策略解析：

```text
Message reasoning ?? {}
  -> preserve omitted thinking
  -> normalize omitted effort to default
```

Runner的调用契约传已解析的开关和effort，不传schema或wire参数：

```ts
interface ResolvedReasoningPolicy {
  readonly thinking?: ThinkingSwitch;
  readonly effort: ThinkingEffort;
}

interface ModelInvocationRequest {
  // existing fields...
  reasoning?: ResolvedReasoningPolicy;
}
```

整个工具循环采用同一冻结对象，沿用现有immutable per-Turn binding和generation pin，
不新增独立快照身份。UI中途修改只影响之后发送的消息。

### 6.1 消息策略持久化

当前Session用户消息尚未保存reasoning。本Change在现有用户消息元数据上增加可选的
`reasoning?: ReasoningPreference`，不新建策略存储、Session默认或恢复继承机制：

- Channel提交的策略先做结构/值校验和深度复制，再同时用于队列与后续用户消息记录；
- 保存原始合法字段，区分对象/字段省略与显式`effort="default"`；不保存本地化摘要字符串；
- Runtime另外规范化得到`ResolvedReasoningPolicy`用于执行和Steering比较；
- 主消息及被领取的Steering消息各自保存当时提交的策略；
- 公共user_message事件和History DTO投影同一结构化策略，UI从字段渲染摘要；
- 重载/Fork沿用现有消息复制和历史路径，恢复历史选择，不把它应用为后续消息的默认；
- 旧记录没有该字段时，按默认策略渲染，不猜测过去曾使用的等级；
- 模型身份展示继续沿用现有模型绑定路径，本Change不额外设计模型选择持久化系统；
- reasoning是Host消息元数据，不加入LLM历史content或序列化为user wire字段；
- 解析后的策略可用于运行期诊断，但不能覆盖原始用户选择，也不要求另存一份durable
  Resolved policy。

省略整个reasoning、显式`reasoning: {}`和`reasoning: { effort: "default" }`执行等价，
持久化及History/reload/Fork保持这三种原始形态。保留差异只为忠实呈现请求，不创建
继承优先级，也不要求UI为执行等价的输入显示不同摘要。

### 6.2 Steering与内部调用

Steering：

- 模型和解析后的开关/effort相同：可在当前Turn下一安全点注入；
- 模型、开关或effort不同：留在FIFO，作为下一Turn；
- 不尝试动态替换当前调用的 Provider replay。

Compaction属于内部调用，不继承用户显式开关或effort，也不主动请求summary。
它不产生用户 Thinking 展示，沿用现有内部调用边界；不能把主动 summary 策略做成
Client全局默认，以免污染内部调用。

Compaction调用仍用同一Turn绑定的Model Port，只消费`text_delta`构造摘要。
其Thinking文本、signature和replay只在Client调用期存在，结束后不进入用户消息
Transcript、RunResult或公开History；仅摘要正文沿现有Compaction记录路径保存。
原会话中已有的Thinking/replay仍按现有Compaction保留边界处理，不因这条规则额外删除。

## 7. Protocol Client 映射

### 7.1 OpenAI Responses

| Reasoning policy | Wire |
|---|---|
| 开关省略且effort为`default` | 不增加`reasoning`对象 |
| 开关省略且effort为`none`，模型声明支持 | `reasoning.effort="none"` |
| 开关省略且effort为其他允许等级 | 原样发送`reasoning.effort` |
| 独立开关 | on请求summary=detailed并展示返回文本，off映射effort=none；不从effort数组猜测 |

若实现的独立`off`通过`reasoning.effort="none"`兑现，必须验证模型接受该值。
独立`on`表示该模型/endpoint既能以默认或显式effort开启推理，也能通过
`reasoning.summary="detailed"`请求可读Thinking；Provider不得为未验证此路径的模型发布`on`。

其固定语义：

- 正常用户调用选择独立`on`时附加`reasoning.summary="detailed"`；
- 开关省略时只精确映射effort，不把强度控制自动等同于显示请求；
- 显式关闭/none及内部调用不主动请求summary；
- Client不补隐式`medium`，不根据模型名猜测；
- 上游未返回summary时正常结束，不生成空卡片；
- 所有实际返回的合法summary和complete replay照常采集。

这让Thinking On直接表达“开启并显示”，同时不改变Default或仅effort请求。公共schema
不增加第二个summary开关，Provider声明独立`on`及其请求策略必须有测试覆盖。

### 7.2 OpenAI-compatible Chat Completions

| Reasoning policy | Wire |
|---|---|
| 开关省略且effort为`default` | 省略推理参数 |
| 开关省略且effort为允许的显式等级，包括`none` | 顶层`reasoning_effort=<value>` |
| 独立开关 | on使用经验证的默认开启路径并展示reasoning_text，off映射已验证的reasoning_effort=none |

当前网关的`reasoning_text`和`reasoning_opaque`由Chat Client处理，不宣称它们是所有
OpenAI-compatible服务统一支持的字段。逐模型发布独立`on`表示该部署已验证省略effort
会开启推理且返回可读`reasoning_text`；Client采集并展示。需要其他私有开启或输出参数的
部署不能通过通用Chat adapter发布`on`。独立`off`使用已验证的`reasoning_effort=none`，
不能从effort元数据自动补出`on/off`整组能力。

### 7.3 Anthropic Messages

当前Client未实现原生Thinking，本设计将捕获、signature/redacted replay和生成映射一起
纳入Built-in闭环。用户配置只声明公共thinking/effort能力，Client拥有Anthropic wire映射，
不暴露adaptive、budget或budget_tokens私有模型字段。

| Reasoning policy | Wire |
|---|---|
| 开关省略且effort为`default` | 不新增`thinking`或`output_config.effort` |
| `off`或开关省略且effort为`none`，相应选项支持 | `thinking: { type: "disabled" }`，不发送effort |
| `on`+默认effort | 仅`thinking: { type: "adaptive" }`，不补effort |
| `on`或开关省略+允许等级 | `thinking: { type: "adaptive" }` + `output_config.effort=<value>` |

约束：

- Anthropic没有`thinking.type="none"`，也不发送`output_config.effort="none"`；
- 等级以模型真实允许值为准，不把`minimal/xhigh`静默换成`low/high`；
- 只有关闭映射已实现并经模型验证时，才可发布开关`off`或effort=`none`，二者各自声明；
- 独立`on`要求模型支持adaptive模式；
- 没有等级映射时可只发布`thinking=["on","off"]`，前提是两个独立路径都能兑现；
- 发布独立`on`还表示Client会采集、投影并展示返回的可读thinking block；无法产生可读
  block的模型/endpoint不能发布`on`。

对于已验证支持独立开关和等级的模型，配置只包含公共能力：

```json
{
  "modelId": "claude-adaptive-example",
  "protocol": "anthropic-messages",
  "reasoning": {
    "thinking": ["on", "off"],
    "efforts": ["low", "medium", "high"]
  }
}
```

Anthropic fixture需覆盖有序Thinking、signature、redacted block及Tool continuation。

### 7.4 Copilot Relay双协议

当前扩展只筛选`/responses`，需要补齐Chat Completions Client及模型Router。
Provider公开identity保持不变，protocol改为稳定的Provider路由器标识；descriptor与
Provider保持一致。实际wire protocol记录在invocation source中，不要求Core分支。

每模型从discovery保存协议绑定：

- 支持`/responses`：使用Responses；同时支持Chat时优先保持Responses路径；
- 只支持`/chat/completions`：使用Chat Client；
- 两者都没有：不纳入可调用Catalog；
- 不根据vendor/modelId选择协议；
- 不因请求失败自动切协议重试；
- 当前不接入Relay的Anthropic Messages endpoint。

2026-10-03读取本地metadata确认：

| Model | Endpoint | Reasoning effort |
|---|---|---|
| GPT-5.6 Sol | `/responses` | `none, low, medium, high, xhigh, max` |
| Gemini 3.8 Flash | `/chat/completions` | `low, medium, high` |

`parseRelayModelCatalog()`读取`capabilities.supports.reasoning_effort`：

- 数组中已知等级精确保留，不增加effort=`off`别名或相邻等级转换；
- 有效等级只投影到`reasoning.efforts`，不推导`thinking=["on","off"]`；
- 独立开关只能由额外可信事实及对应Client实现发布；
- 字段缺失不等于模型不会推理，保持该控制能力未确认；
- 空effort数组只表示没有已声明的等级，不证明开关支持或内部推理状态；
- 已知非空字符串精确投影到公共枚举；
- 未知但结构合法的非空字符串，例如`"ultra"`，不投影该值并记录有界、内容无关诊断；
- 值全部是未知字符串时仍保留符合其他准入条件的模型，但不发布显式effort选项；
- 字段存在却不是数组，或数组元素为非字符串、空/仅空白字符串、嵌套对象等，属于结构
  非法；拒绝本次discovery候选snapshot，不静默冒充空能力；
- `min/max_thinking_budget`不自动转换为等级；
- 当前metadata没有summary请求能力，不自动开启summary；独立可信事实可按§7.1声明。

metadata、模型binding、Catalog、Resolved Facts和私有路由都来自同一深度冻结快照。
各Relay Client负责自己的参数、认证、事件及replay，不导入Built-in私有模块。

## 8. Thinking block、持久化与模型切换

```text
上游产生原始事件
  -> Client解析并产生thinking_start/delta/end及replay
  -> Collector按顺序组装canonical block
  -> Runner/Session保存
  -> Presentation只公开id/text/status
```

用户可见正常Turn保持现有结构；Compaction等内部调用不适用公开展示与持久化规则，
具体边界见§6.2：

- 一个assistant message可以包含多个有序Thinking block；
- Thinking、正文及Tool按原顺序组装；
- 完整block可以`text=""`但有replay，例如encrypted-only或redacted Thinking；
- partial保存已获取的可读文本，不包含不完整replay；
- complete保存可读文本及Provider-owned版本化replay；
- UI不显示空卡片，历史卡片默认折叠；
- 正常Turn无论开关是否为`off`或effort是否为`none`，实际返回的合法可读内容仍展示和保存；
- 不新增可见性字段、隐藏历史重投影或文本丢弃规则。

实现Anthropic时扩展`ThinkingWireProtocol`，不向Core增加signature等wire字段。
Anthropic完整thinking/signature和redacted block由其Client编码及恢复。

模型切换时：

- 内部Transcript不改写；
- 目标Client省略不兼容协议Thinking，保留普通正文和Tool历史；
- 同协议来源兼容时校验codec并恢复replay；
- 同协议来源冲突仍发送前失败；
- 不把Thinking改成普通正文，不转换opaque；
- 往返切换、Session重载/Fork和Compaction必须验证顺序及工具关联；
- 不宣称任意模型、历史修改或Compaction后的signature都可无条件复用。

## 9. Web UX、安全与成本

能力驱动地展示最多两个生成控件：

```text
Thinking: Default + selected model reasoning.thinking options
Effort: Default + selected model reasoning.efforts
```

默认Thinking表示消息字段省略，默认Effort表示`default`。某个能力数组没有非默认选项时
省略该控件，语义等价于该维度选择Default。有非默认选项的控件显示Default首项。
Relay的effort-only模型只展示等级控件，不支持任何控制的模型两个控件都省略。
Thinking文案使用“默认/开启/关闭”，不是“显示/隐藏”。

Web只对模型已声明的选项排序：Thinking按`on → off`，effort按
`none → minimal → low → medium → high → xhigh → max`，Default始终为首项。
例如Provider声明`["high","low","medium"]`时展示`Default/low/medium/high`，
不改变能力快照或请求值。未来扩展公共枚举时同步定义新值的展示位置，不将当前排序
作为额外的能力准入条件。

每次切换模型更新选项；当前显式值不被新模型接受时禁用发送并提示明确重选，不静默改成
其他值。选择`off`后仅禁用`minimal/low/medium/high/xhigh/max`，保留Default和模型声明
支持的`none`；effort=`none`时禁用`on`，并提示已存在的冲突，
不静默清掉用户选择。Runtime仍独立校验，不能只依赖UI。

开关与effort摘要由持久化的结构化消息字段渲染，重载后不依赖浏览器内存。
模型摘要沿现有绑定展示。Thinking卡片沿用实时展开、正文/Tool开始后折叠
及历史默认折叠，不增加Display。CLI首期不增加开关/等级选择或Slash命令，
省略消息策略并保持当前行为。当前Turn快照不受控件修改影响。

必须说明：

- 高等级可能增加推理token、延迟和费用；
- 没有可读Thinking不代表模型没有推理；
- 开关`off`及effort=`none`表达Provider支持的关闭意图，不保证零reasoning token或零内部推理；
- Provider文本/summary不保证完整原始思维链；
- Public History和日志禁止opaque、signature、encrypted content；
- 日志可记录策略、能力状态和内容长度，不记录Thinking文本或replay payload。

## 10. 建议交付顺序

1. 契约：schema严格校验、Model Facts/Catalog一致投影及Built-in配置。
2. Turn：队列快照、开关/等级/组合校验、Runner请求和Steering兼容。
3. Built-in：Responses/Chat effort、Thinking On展示语义、Anthropic公共策略映射及完整replay。
4. Relay：双协议Client/Router、discovery等级和不可变模型快照。
5. Web：能力驱动的开关及effort控件、组合约束、明确重选及历史回归。

不从Research直接开工。正式Change应先固化私有配置校验和Anthropic fixture，再修改
生产调用链。不得将未完成codec的模型能力提前发布为可用。

## 11. 验收矩阵

| ID | 场景 | 必须观察到 |
|---|---|---|
| TGC-01 | 消息策略省略 | 开关省略且effort为default，wire请求不变，无全局reasoning配置层 |
| TGC-02 | 数组缺失/空/仅开关/仅effort | 只提供各自声明的选项，实际合法Thinking不被丢弃 |
| TGC-03 | Built-in schema非法 | 配置加载/候选staging失败，不发布新Catalog；reload保留当前generation |
| TGC-04 | 显式开关或等级不支持 | fetch为零，返回capability错误，不降级 |
| TGC-05 | 同协议不同模型schema | 各自使用自己的选项与冻结事实 |
| TGC-06 | Responses high与私有summary支持 | 发送high及summary auto，文本进入卡片和History |
| TGC-07 | Responses high无summary事实 | 仅发送effort，不猜测summary支持 |
| TGC-08 | Responses none | 发送none，不主动请求summary；返回文本仍正常展示 |
| TGC-09 | Chat high/none | 仅发送模型允许的reasoning_effort |
| TGC-10 | Anthropic adaptive on/high/off/none | 独立on不补effort，high构造adaptive+effort，关闭用disabled |
| TGC-11 | Anthropic显式等级 | 发送adaptive及精确output_config.effort，不做等级替换 |
| TGC-12 | Anthropic配置边界 | 拒绝协议私有模型字段；公共能力结构错误在配置/staging失败 |
| TGC-13 | Anthropic redacted block | 有序保存replay-only block，无空卡片 |
| TGC-14 | Anthropic同源工具续轮 | thinking/signature/redacted块按验证过的协议顺序恢复 |
| TGC-15 | 三协议互切 | 不兼容replay省略，普通正文和Tool关联保留 |
| TGC-16 | Anthropic→OpenAI→Anthropic | Transcript不改写，各次仅投影可消费且经校验的replay |
| TGC-17 | 同协议来源冲突 | 发送前失败，opaque不进日志 |
| TGC-18 | 运行中改变模型/开关/effort | 当前Turn不变，新消息采用自己的快照 |
| TGC-19 | 不同开关或effort Steering | FIFO下一Turn，不注入当前Turn |
| TGC-20 | Abort/流错误 | 保留可读partial，不生成未完成replay |
| TGC-21 | Session重载/Fork | 可读文本与原始结构化策略恢复，摘要一致，公共History无opaque，不继承历史策略 |
| TGC-22 | Compaction | 不继承用户策略，不请求summary或公开Thinking；内部Thinking/replay不持久化，只保存摘要正文 |
| TGC-23 | Relay GPT与Gemini发现 | 分别绑定Responses/Chat，发布准确等级 |
| TGC-24 | Relay未知等级字符串 | 已知值投影；未知非空字符串诊断后忽略；全未知保留模型但无显式effort |
| TGC-25 | Relay双endpoint及跨协议历史 | 稳定协议绑定，无失败后协议重试，replay正确过滤 |
| TGC-26 | Catalog/Resolver schema | 静态Catalog在staging校验且不发布错误候选；动态descriptor在解析期校验，同一快照深度冻结 |
| TGC-27 | Web切换到不支持当前策略的模型 | 禁用发送并提示重选，不修改运行中Turn |
| TGC-28 | 正常Turn展示路径 | 无Display控件或隐藏持久化，实际可读Thinking正常显示；内部调用按TGC-22隔离 |
| TGC-29 | off+high或on+none | 发送前invalid request，不忽略任一字段 |
| TGC-30 | off+none且两者支持 | 两种选择顺序均允许；关闭只映射一次，不发送冲突effort |
| TGC-31 | Anthropic统一配置边界 | 只配置thinking/effort，Client内部映射adaptive/disabled及精确effort |
| TGC-32 | Relay等级控制但无独立开关 | 只提交effort仍能正确调用，不强制增加thinking字段 |
| TGC-33 | Built-in可选reasoning配置 | 无非默认选项则省略控件，语义为Default + Default；有选项才显示，不创建调用默认 |
| TGC-34 | UI返回Default | 已显示控件的Default是首项；Thinking字段省略、effort解析为default，无Relay默认值依赖 |
| TGC-35 | Relay结构非法metadata | 非数组、非字符串或空白值使discovery候选失败，不发布错误Catalog，reload保留旧generation |
| TGC-36 | 原始策略与解析策略 | 省略reasoning、空对象、显式default执行等价；History/reload/Fork保留各自形态，摘要一致，不用resolved覆盖 |
| TGC-37 | 消息策略未知字段 | effrot等未知字段返回invalid request；LLM请求为零，不入队、不保存错误策略 |
| TGC-38 | 能力与展示顺序 | 快照保留Provider有效顺序；Web按公共枚举顺序展示且Default在首项，不增补能力或改写请求值 |

## 12. 外部参考与证据边界

- [OpenClaw Thinking levels](https://docs.openclaw.ai/tools/thinking)
- [OpenClaw Slash commands](https://docs.openclaw.ai/tools/slash-commands)
- [OpenClaw Agent CLI](https://docs.openclaw.ai/cli/agent)
- 初次网页调研版本：
  [`eb13b4fa6b84088fcba8dde1f097f37e7402e5a0`](https://github.com/openclaw/openclaw/commit/eb13b4fa6b84088fcba8dde1f097f37e7402e5a0)
- 后续本地源码检查：OpenClaw的copilot-proxy插件固定Chat Completions和reasoning=false，
  Anthropic扩展定义默认adaptive/native output/replay hooks，通用transport实现预算换算。

这些只验证设计模式，不构成所有模型支持某参数的证明。当前my-agent尚未实现本草稿的
能力schema、独立开关/effort控制、Anthropic原生Thinking及Relay双协议路由。
