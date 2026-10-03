# Thinking Capture and Display Specification

> Status: Validated and Archived — owner accepted
> Date: 2026-10-02
> Owner: Project owner
> Related Plan: [Thinking Capture and Display](plan.md)
> Authority: Archived delivery contract; current authority transferred to Architecture and Stable Specifications
> Current phase: Chat Completions / Responses；Anthropic专项Deferred

## 1. Purpose and observable outcome

用户在模型返回可读Thinking时能实时查看，在刷新、切换Session和加载旧页后仍能展开已保存文本；必要协议数据完整保存，不因展示功能破坏工具续轮。

验收优先级：**显示不丢、续轮不坏、opaque状态不外泄**。当前阶段已按本契约实施并完成离线、构建及浏览器组件级验证；§11的D1/D2原则已收敛，所有者于2026-10-02确认验收并归档。

## 2. Scope and non-goals

当前覆盖Built-in Chat Completions、Built-in Responses和Copilot Relay原生Responses，以及共同的Core内容/事件、Session、WebSocket/Web、CLI与上下文准备路径。网关Chat采用已核实的`reasoning_text`/`reasoning_opaque` dialect，不假定Relay扩展已有Chat Client，不承诺所有兼容API的私有字段。

- 保存并回放实际上游返回的完整Responses reasoning item或Chat消息级状态；可读展示与opaque回放分开。
- 不做生成开关、effort/budget设置、服务端conversation、previous_response_id缓存、任意跨账户迁移、耗时持久化或通用Replay Registry。
- 不将Thinking拼进UserPromptBuilder的用户文本，不依赖Client私有的跨调用缓存恢复历史。
- Anthropic thinking/signature/redacted及严格prefix方案暂缓，研究保留在[validation §5](validation.md#5-目标方案spike2026-09-30)和[研究草稿](../../../research/thinking-capture-and-display-design-draft.md)，不作为本阶段通用约束或验收阻塞。
- 本期保持现有Responses请求策略：不新增`store`、`include`、`reasoning.summary`或服务端关联参数。被动保留实际返回的状态，不承诺能恢复上游未返回或已失效的状态。增加主动获取密文的策略须单独评审，不能以隐藏重试实现。

这里的`<think>`来自本机Ollama 0.20.7运行已安装的`deepseek-r1:7b`时返回的普通回答文本，不是本项目定义的块，也不是5000端口网关的结构化字段；具体字段位置见[§7.6](#76-真实验证路径澄清)。

所有者明确：正文中的`<think>`/`</think>`及内部文本保持既有普通消息增量、持久化和回放。完整、跨chunk或未闭合标签均不提取、不剥离、不等待闭合、不转换成Thinking事件或卡片。跨chunk是行为约束，不冒称本地已实测流式分片。

## 3. Boundaries and dependency direction

| Owner | 职责 | 禁止事项 |
|---|---|---|
| Core Model Invocation | 强类型内容、流事件及输入检查结果 | 导入Provider SDK；任意metadata袋 |
| Concrete Provider | wire采集、结构校验、来源事实、兼容判断、请求投影及其预算信息 | 把协议/账户识别交给Runner；静默丢必需状态 |
| Runner / collector | 调用身份、共同的保序组装规则；Runner负责持久化及安全事件 | 解密、重编码opaque；按类型重排内容 |
| Session | 一次确定工具结果有效内容；完整Transcript及安全History | 返回内部块作为公开History；二次截短 |
| Context / Compaction | 改写前保护活动工具链，依据实际投影检查预算 | 裁剪密文；先破坏历史再让Client补救 |
| Channel / Runtime公开结果 | 仅消费安全展示类型和生命周期 | 接收内部回放来源或payload |

沿用[Provider边界](../../../architecture/providers.md)及[Model Resolution契约](../../../specifications/model-resolution.md)。当前架构和Stable Specifications在Delivery验收前不变更。

## 4. Content, identity and persistence

### 4.1 三个视图

1. **Internal Transcript**：完整结构化内容和最小调用来源，是恢复源。
2. **Provider projection**：目标请求所需原生消息/item，不改写Transcript。
3. **Presentation**：显式白名单，仅包含普通内容及Thinking的`id/text/status`；用于History、公开事件、Runner返回结果和Runtime返回/终态事件。

第三层不是只处理History。当前`RunResult.content`与`RunTurnResult.content`也引用内部内容类型；本Change须将它们改为安全展示类型，覆盖`AgentEvent.run_end`、`RuntimeEvent.turn_end.result`及Runtime调用返回值。`ModelInvocationResponse`仍是内部完整内容，不能当作公开运行结果透传。

公开类型不得包含`encrypted_content`、`reasoning_opaque`、来源绑定、原生item ID、请求快照或未来Anthropic的signature/redacted data。公共块ID由本地调用身份生成，不直接采用可能携带不透明数据的上游ID。

### 4.2 身份及事件

- 每次实际模型调用分配独立`invocationId`，包括同Turn工具续轮及重试；Runner与非流式collector复用同一组装器规则。
- Client发出调用内唯一`blockId`；持久/公共Thinking ID为`invocationId + ":" + blockId`。Provider将上游index/item ID映射为本地blockId，不直接拼接原生ID。
- 新增内部事件：`thinking_start { blockId }`、`thinking_delta { blockId, text }`、`thinking_end { blockId, completion }`。`completion`为§4.4的partial或complete判别联合，不是任意JSON。opaque-only块也在第一次观察到状态时发内部start以预留位置，但不产生公开事件。
- Client在第一次观察到内容时预留位置，text/tool/thinking共同保序。延迟完成的tool或reasoning item填回其原位置；必要的位置元数据仅在内部使用，不能等结束后把Thinking统一前置。
- 来源随内部`message_start`交付，最终usage/完成信息随`message_end`交付；产生Thinking的调用必须有合法来源。未采集Thinking的既有协议无需伪造来源。
- 公开start/delta/end采用下列固定形态，不含内部completion payload。仅在第一次得到非空可读文本时发start；opaque-only不生成公开事件或空卡片。
- 完成payload是最终权威；安全end始终携带完整最终展示文本，客户端替换而非追加。若最终文本为空，客户端删除仅由临时增量创建的卡片。Abort/error以`partial`封闭活动展示，不伪造正常完成。

```ts
type PresentationThinkingEvent =
  | {
      type: 'thinking_start';
      sessionId: string;
      turnId: string;
      thinkingId: string;
    }
  | {
      type: 'thinking_delta';
      sessionId: string;
      turnId: string;
      thinkingId: string;
      text: string;
    }
  | {
      type: 'thinking_end';
      sessionId: string;
      turnId: string;
      thinkingId: string;
      text: string;
      status: 'partial' | 'complete';
    };
```

内部新增事件形态固定如下；既有text/tool/error事件保持原义。Client遇到Abort/error/EOF时先为所有已start但未end的块产生partial end，再交付错误或终止，保证collector没有悬空块：

```ts
type ModelThinkingStreamEvent =
  | {
      type: 'message_start';
      invocation?: {
        id: string;
        source: InvocationSource;
      };
    }
  | { type: 'thinking_start'; blockId: string }
  | { type: 'thinking_delta'; blockId: string; text: string }
  | {
      type: 'thinking_end';
      blockId: string;
      completion: ThinkingCompletion;
    }
  | {
      type: 'message_end';
      stopReason: string;
      usage: InvocationUsage;
    };
```

能产生Thinking的Client必须在message_start提供invocation；未采集Thinking的既有Client可暂时缺省。若后续出现thinking事件而start没有invocation，collector按invalid_state失败，不生成本地来源。

### 4.3 调用来源

携带Thinking的assistant消息附带一次`invocation`，块不重复整份来源。目标类型固定如下；`invocation`只允许出现在assistant消息，v1合法消息可缺省，v2中含Thinking的消息必须存在：

```ts
type ThinkingWireProtocol =
  | 'openai-chat-completions'
  | 'openai-responses';

interface InvocationSource {
  providerId: string;
  connectionId: string;
  requestModelId: string;
  responseModelId?: string;
  wireProtocol: ThinkingWireProtocol;
}

interface InvocationUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

type InvocationCompletion =
  | {
      status: 'partial';
      stopReason: 'aborted' | 'error';
      usage?: InvocationUsage;
    }
  | {
      status: 'complete';
      stopReason: string;
      usage: InvocationUsage;
    };

interface AssistantInvocation {
  id: string;
  source: InvocationSource;
  completion: InvocationCompletion;
}

interface AssistantChatMessage {
  role: 'assistant';
  content: string | ChatContentBlock[];
  invocation?: AssistantInvocation;
}
```

`MessageRecord.message`对assistant使用同一`invocation?`字段；user/toolResult记录禁止该字段。Provider输入的assistant消息沿用该结构，Concrete Provider只读取其支持的内部字段并构建wire projection。

- `id`：本地invocationId。
- `source.providerId`、`source.requestModelId`、`source.wireProtocol`：实际Provider、请求模型及`openai-chat-completions`或`openai-responses`，不能把逻辑router名称当wire协议。
- `source.connectionId`：Provider提供的稳定、非秘密连接标识，重载后可比较；配置位置/连接标识不等于账户证明，不以Client对象地址或Session ID代替。
- `source.responseModelId?`：仅在上游返回时保存，与请求别名分开。
- `completion.stopReason`及实际可获得的reasoning usage信息：不伪造未知值；reasoningTokens未知时缺省，usage按调用保存一次，不能对多个item重复累计。正常完成必须有基础input/output usage；Abort/error发生在usage到达前时允许partial缺省usage。错误后的可读partial随assistant记录保存并标记`stopReason: 'error'`，但不携带或回放不完整opaque。

Provider必须在比较连接时考虑实际路由变化，不能仅比较一个不变的配置标签。不得保存API Key、其指纹、认证头或带凭证URL。账户身份未知保持未知；来源结构用于本地支持范围判断，最终鉴权和opaque有效性由上游负责。

不保存每轮完整请求、全会话system/tools快照或原型的保护摘要。没有证据把Anthropic全prefix要求强加给本期两协议。

### 4.4 最小内容契约

Core仅定义协议无关的展示文本、完成状态和Provider-owned replay envelope。Chat/Responses原生字段及item结构留在具体Client内，不进入Core、Runner、Session公开类型或Channel。

```ts
type ReplayJsonValue =
  | null
  | boolean
  | number
  | string
  | ReplayJsonValue[]
  | { [key: string]: ReplayJsonValue };

interface ProviderReplayState {
  // Provider-owned codec identifier; Core persists but never interprets it.
  format: string;
  payload: { [key: string]: ReplayJsonValue };
}

type ThinkingCompletion =
  | { status: 'partial'; text: string }
  | {
      status: 'complete';
      text: string;
      replay: ProviderReplayState;
    };

type ThinkingContentBlock = {
  type: 'thinking';
  id: string;
} & ThinkingCompletion;

interface PresentationThinkingBlock {
  type: 'thinking';
  id: string;
  text: string;
  status: 'partial' | 'complete';
}
```

- `text`是Client归一化后的唯一展示文本。Responses Client按summary数组顺序用两个换行连接；Chat Client使用reasoning text原值。最终文本为空时Presentation删除该块，但完整replay仍可留在Transcript。
- `format`及`payload`只由创建它的Provider Client解释。Core只验证它们是非空格式标识和有限JSON值，按顺序持久化/透传，不分支识别Chat或Responses字段。
- Responses item ID、summary/content/encrypted state和Chat opaque均封装在对应Client的payload codec中；两种payload不互相转换。opaque字符串不trim、不截断、不解码、不重新编码。
- partial块只有`text`，不得携带replay；complete块必须同时携带最终`text`和replay。
- 未建模且影响回放的字段须在对应Client的私有codec与fixture中补充，不扩展Core为任意协议metadata模型。
- Core与Session共用相同的内部内容语义；Presentation独立列举安全字段，删除`SessionHistoryContentBlock = ContentBlock`式直通别名。新契约通过现有Extension API出口导出。

### 4.5 Transcript格式

- 提议将新Transcript根版本提升至2；读取合法v1无Thinking记录，不补造状态。含新Thinking的记录必须通过v2运行时校验。
- 已有v1会话首次写入v2数据前，在既有Session串行写入边界内原子升级根与新记录；保留旧entry ID、parent、turnId和普通内容。不得先追加新块、稍后改版本。
- 原子升级采用同卷临时文件重写：持有Session写锁，序列化升级后的root、全部既有记录及首条v2记录，flush并关闭临时文件后替换原Transcript；只有替换成功才更新内存state。任一步失败均删除或留待启动清理临时文件，原v1文件及内存leaf保持不变。升级时不得遗漏Compaction及异步工具生命周期记录。
- 新版本加载器支持v1/v2；旧版本程序应拒绝v2，不能误读后经旧History直通路径暴露opaque。升级失败保留原文件且不继续依赖该写入的模型请求。
- 校验消息角色、非空身份、块联合、payload字段、来源、每调用Chat状态唯一性以及完成状态的一致性；未知版本/损坏新块明确报Session数据错误，不当作旧记录忽略。
- Fork复制所保留消息的完整调用来源和内容，保持块ID与消息关系，不留悬空引用。格式升级、崩溃原子性及Fork均需生产集成测试，现有Spike没有证明它们。

## 5. Protocol collection and replay

### 5.1 Responses

- SSE以`response.output_item.done`的完整reasoning item为完成依据，非流式以终态output中的完整item为依据；added/文本delta不替代完整item。流式added/done优先按item ID关联；兼容网关在两事件间更换ID时，仅允许用唯一相同的`output_index`回退关联，完成item中的ID仍按原值保存和回投。
- 接受status缺省或completed；显式in_progress/incomplete只保留可读partial，不能改成completed或用半截密文续轮。响应异常中断时，已经完整结束的其他块不一律降级。
- 已完整返回的item按原位置进入下一请求，与function_call及function_call_output保持关系；不因空summary删除，不在新user出现时一律删除更早item。
- Built-in与Relay分别复用各自实际请求投影、分别验证；不从官方默认值推断网关store行为。不新增生成请求或主动获取summary来补展示。
- 正常完成却缺少该路径必需的状态属于明确错误；不能删块后重试。仅返回id而没有ciphertext不自动视为损坏，也不承诺服务端状态失效后仍可恢复。

### 5.2 网关Chat Completions

- `delta.reasoning_text`按接收顺序追加；非流式取assistant.reasoning_text。合并为本次assistant的消息级可读内容，不伪装为Responses item。
- 本期dialect支持**每assistant响应最多一个非空reasoning_opaque值**。空字符串/null/缺省不提供状态；其他非字符串值非法。非空字符串原样保存，空白也不擅自trim。
- 第二个非空值无论是否相同都明确报不支持的流形态，不拼接、不覆盖、不按相等值去重。这个边界是本地保守支持策略，不是宣称上游协议禁止重复或分片。
- opaque到达不代表assistant完成。只有合法终止且工具参数等普通内容也收集完整后，才提交消息级complete状态；EOF、Abort、错误或截断不能把半个assistant冒充正常完成。
- 回投时在该assistant消息上写一次实际reasoning_text/reasoning_opaque，不复制到各tool block。无opaque的可读状态不补造opaque；无可读文本不从usage、密文或另一模式响应猜文本。
- 单值策略依据本地样本及固定版本竞品客户端实现，见[validation §7补充](validation.md#流字段单值边界的补充证据)。尚未取得多值/分片的正式上游规范，遇到新形态先失败并补证据，不隐藏兼容逻辑。

## 6. Completion, errors and Abort

- duplicate/unknown block、错配结束、非法字段和重复opaque通过既有错误链显式报告；无正常终态的流不能返回成功形状的完整响应。
- partial只保存已收到的可读文本用于展示，不带可回放opaque；不执行缺少必需完整状态的工具续轮，不重跑已经执行的工具来重造Thinking。
- 所有UI终态必须结束活动Thinking；终态History合并仍按Turn及持久块ID收敛，不重复展示。
- 本地结构/支持范围校验与上游鉴权、签名有效性分开，不能声称本地已验证密码学状态。

本期沿用现有ModelInvocationError与Session数据错误，不增加跨Core/Runtime的replay专用错误协议；不借用`providerErrorCode`冒称服务端返回：

| 来源 | 类别 | 行为 |
|---|---|---|
| 上游流形态非法 | provider_failure | 结束本次调用；不提交伪完整状态、不自动宽松重试 |
| 本地请求缺必需状态 | provider_failure | 发送前拒绝 |
| 来源尚不支持或已知不兼容 | provider_failure | 发送前拒绝，不猜测翻译 |
| Transcript损坏 | 既有Session数据错误 | 加载失败，不发送请求 |
| 上游实际拒绝 | 按实际结构化错误分类 | 不改成虚构的本地兼容结论 |
| 输入预算不足 | 既有预算/Compaction错误 | 不删必需块伪造可发送 |

公开错误使用既有固定安全说明，不附原始chunk、请求body、opaque或含这些数据的cause；本地具体校验信息不直接进入Runtime/Channel。若未来确实需要用户可区分的恢复动作，再单独评审白名单诊断字段。

## 7. Recovery and context preparation

### 7.1 工具结果只有一个有界化owner

保留Session现有工具结果head/tail配置及有界化所有权；**不在Runner先prune新结果再交给Session cap**。

1. `SessionManager.appendMessage`返回已持久化的规范MessageRecord，而非只返回entry ID；需要ID的调用者取record.id。
2. Session对新toolResult确定一次有效内容，持久化成功后返回；Runner将返回记录的内容加入当前messages，不能先加入工具原始输出。
3. 当前请求、保存后读取、新SessionManager读取使用同一有效内容；持久化失败不提交内存消息、不发送依赖消息的请求。
4. 活动工具链的已提交结果不再动态prune。旧的可裁剪历史仍可按预算准备请求，但不修改Transcript，不对已截短内容再执行落盘cap。
5. 不靠截短标记字符串猜测是否处理过；不顺带实施独立Tool Result状态Change。

### 7.2 Provider输入检查与预算

本期不新增通用`inspectInput` Port或四态估算框架。Context预算在发现complete Thinking replay时返回第四条最小路由`unavailable`；`estimatedTokens`仅表示可估算内容下界，不能称为预算已通过。

- `unavailable`允许一次正常上游请求并写安全warning，由上游执行最终context enforcement。
- Core不以opaque字符数估算token；仅按归一化可读文本计算下界，避免未知块落入既有default=0/`fits`路径。
- 明确context overflow继续复用现有至多一次Compaction/retry；无合法候选、Compaction失败或二次overflow时停止。
- 每个Client在实际请求投影时验证自己创建的`format`、payload结构、provider、wire protocol、稳定connectionId及invocation/block关系。Runner和Context不读取协议字段、不比较modelId、不维护厂商矩阵。
- partial Thinking不回投；来源不兼容或payload损坏明确失败，不静默删除状态。

### 7.3 保护范围及Compaction

- 至少保护当前活动Turn和历史尾部尚待模型续接的工具链：关联assistant、所有Thinking、tool_use/tool_result及其顺序一起保留，不能只保留最后一次Thinking。
- 用持久turnId、tool调用关系及完成状态判断边界，不把role=user的tool_result或steering误当作可切断链路的新问题。
- 手动、预防性、溢出Compaction和单条/聚合prune采用相同边界；受保护内容不可计入“可释放预算”。
- 完整结束的旧Turn可作为整体进入既有Compaction；不只删其中的opaque而保留需要它的工具续轮。摘要请求及摘要文本均不带opaque；保留消息中的合法item仍完整回投。
- 不施加全会话append-only，不因本功能全局禁用Compaction；本期不要求恢复旧system/tools快照。正常配置更新仍生效，不发送旧schema却执行新工具。
- 受保护链本身超过预算时明确停止，不自动丢状态或重跑工具。新user出现不触发“删除所有旧reasoning”。
- `unavailable`时先发送一次原样请求，由上游执行最终context enforcement。若上游返回明确context overflow，只允许压缩已结束旧Turn，重新inspect后最多重试一次；没有合法候选、Compaction失败或重试后仍overflow时停止。不得以删除opaque、拆开活动链或无限重试换取成功。

### 7.4 恢复矩阵

以下是目标契约，**不是已通过生产认证**。

| 场景 | 处理 |
|---|---|
| 刷新、切Session、旧页 | 仅从Presentation History恢复文本；不依赖上游状态仍有效 |
| 同配置连续工具调用、Session重载、进程重启 | 从Transcript完整重建状态及有效工具结果；不依赖旧Client缓存；上游失效/鉴权拒绝明确报错 |
| 当前system/tools更新 | 使用当前配置，不因Anthropic原型统一冻结；保持活动链及真实工具定义一致 |
| 同协议切模型 | Provider依据已验证规则判断；§7.8两组请求modelId切换实测成功，不能仅因ID变化拒绝。无已知规则时按D1明确停止，不静默剥离状态 |
| 换连接/账户/协议 | 不翻译opaque；已知不兼容明确拒绝。来源相等不保证账户或服务端状态有效；未知范围见D1 |
| Compaction、预算改变 | 按§7.2–7.3；旧完整Turn可压缩，当前必需链不被拆散 |
| Abort后继续 | partial可显示但不参与回放；已完成块独立保留；不能补造缺失状态继续工具链 |
| Fork | 复制保留消息及调用来源；新Session ID本身不是不兼容理由 |

### 7.5 前期严格prefix原型的地位

候选A“一份有效消息＋一次实际system/tools上下文”的结构、25项测试和限制集中在[validation §5](validation.md#5-目标方案spike2026-09-30)。它证明了受控条件下的确定性恢复及冲突检查，不证明本期两协议必须保存上下文快照、同模型全等或全会话append-only。该测试专用原型不直接升级为生产格式。

### 7.6 真实验证路径澄清

2026-09-30本机Ollama 0.20.7＋已安装的deepseek-r1:7b在**无工具、非流式**短请求中返回字面`<think>`，低输出上限下标签未闭合：

- Chat：`choices[0].message.content`。
- Responses：message item的`content[].text`，type=output_text。
- Messages：`content[].text`，type=text。

这不是项目插入的标记，也不代表所有Ollama模型；该模型包显式thinking/tools请求均400。实验及限制见[validation §6](validation.md#6-所有者指定的ollama真实探测)。这里只说明§2普通文本非目标的来源，不把Messages路线恢复为本阶段实施范围。

### 7.7 当前两协议证据

指定5000端口网关的gemini-3.5-flash（Chat）和gpt-5.4-mini（Responses）已各自以原生字段完成两次工具调用并最终回答3。Chat工具SSE为opaque-only；Responses完成item的summary/content为空而有encrypted_content。完整目录、12次请求、字段及证明边界见[validation §7](validation.md#7-5000端口网关目录与原生协议验证)。

证据只证明样本回传被接受，不证明删状态必然失败、所有模型兼容、推理质量等价或生产Runner/Session已经接线。

### 7.8 D1兼容性受控Spike

所有者认可“兼容性未确认时明确停止”的保守原则，同时要求先做Spike，不能假定换模型必然不兼容。新增[受控实测](validation.md#d1兼容性spike2026-09-30)使用同一网关、默认Thinking设置：

- Chat请求模型gemini-3.5-flash → gemini-3.6-flash、Responses请求模型gpt-5.4-mini → gpt-5-mini均接受完整原生状态；活动工具链续接及已结束旧Turn后的新问题都成功。
- 同模型对照均成功；Chat删除或单字符破坏opaque仍成功。Responses仅删除encrypted_content、保留item ID/其他字段时成功，单字符破坏密文时400。
- 因而不采用“modelId不同就拒绝”或“删opaque一定报错”规则；也不因删除对照成功就在生产请求中自动删除状态。
- HTTP接受性不证明服务端使用了旧推理；Responses保留ID可能影响删除对照，Chat的宽容结果不能推断为无校验或推理等价。400只记录到状态码，未取得可用于细分原因的安全诊断，不宣称已证明密码学验签失败。
- 支持证据只覆盖该连接、请求模型对、方向和合成消息形状；不认证反向切换、其他网关/账户、后端实际模型身份或生产接线，不把样本写成全局硬编码模型白名单。

对证据范围外的必需回放，D1仍要求明确unsupported_source，不自动删状态、摘要重开或重跑工具。如何由Concrete Provider表达已核实规则须随实现接线测试，不由Runner比较modelId或维护厂商表代替。

## 8. Channel and history UX

- Web有可读增量时展开Thinking并追加纯文本；块结束或正文/Tool开始时停止实时计时，正文/Tool开始后自动折叠。
- 历史默认折叠且可展开；不持久化耗时，不从时间戳推测时长。
- 空summary、opaque-only不生成空卡片；不得通过额外模型请求补造文本。
- 文本插值，不经v-html；折叠、分组不改变Transcript。CLI区分Thinking与正文，结束/错误时恢复样式。
- Child Thinking沿用合法受众路由，不广播到其他Session、不写入Root Transcript，不改Subagent生命周期。
- History与实时终态采用既有Turn收敛路径及稳定块ID，分页/切换后不重复。
- 当本次运行包含不可估算的完整replay时，Runner写一次固定类别的安全warning并继续正常请求。warning只包含Session/Turn、可估算下界和可用预算，不包含opaque、密文长度、请求正文或payload。本期不为此扩展`RunResult`、Runtime事件或Channel协议。

## 9. Data and diagnostics boundary

内部可读文本及opaque均为会话数据，沿用既有存储访问边界；只有Presentation白名单可离开内部恢复链路。History、run_end、Runtime turn_end/返回值、错误对象、普通日志都必须做负向泄漏测试。

诊断可记录安全类别、类型、计数及长度，不记录原始payload/认证信息。真实验证仅用合成提示和无副作用工具；不因本功能提高生成预算或改变数据保留策略。

## 10. Acceptance and validation

| ID | 场景 | 必须观察到 |
|---|---|---|
| TCD-A1 | Anthropic连续工具调用 | Deferred；后续验证完整Thinking/签名/redacted链 |
| TCD-A2 | Anthropic分chunk/空摘要 | Deferred；后续验证原值关联及往返 |
| TCD-A3 | Anthropic缺块/Abort | Deferred；不冒充本期通过 |
| TCD-O1 | Responses空/非空summary、done与非完成item | 完成item无损回投；partial不伪装完整；缺省/null/status独立覆盖 |
| TCD-O2 | Built-in与Relay请求策略 | 各自验证；store/include/关联参数未被偷偷改变 |
| TCD-I1 | 多调用、重试重复index | 持久/公共ID不碰撞，不直接暴露原生item ID |
| TCD-H1 | 实时到历史、分页、切Session | 文本恢复、默认折叠，无重复或推测耗时 |
| TCD-S1 | 所有公开出口和日志 | History、run_end、Runtime终态/返回值、错误无opaque/来源泄漏 |
| TCD-R1 | 重载、重启及来源变化 | 符合矩阵及D1；不靠Client缓存，不猜测账户 |
| TCD-C1 | Compaction与预算 | 当前必需链保留；预算对应请求投影，unknown不当0 |
| TCD-B1 | 无Thinking、旧会话及格式升级 | 原有行为保持；v1合法读取、原子升级v2；损坏新块失败关闭 |
| TCD-R2 | 长/短工具结果的发送与磁盘重载 | 当前请求、保存后、新实例恢复使用相同有效内容 |
| TCD-R3 | system/tools更新及Fork | 不冻结全部配置、不用旧schema执行新工具；来源关联完整 |
| TCD-C2 | 所有prune/Compaction入口 | 改写前保护；不能只改一个入口或只保护最后一个item |
| TCD-I2 | Runner与非流式collector | 同一组装规则及内容顺序；partial/完成语义一致 |
| TCD-R4 | 一次有界化与写入失败 | 无二次截短；失败不推进内存或依赖请求 |
| TCD-C3 | 来源冲突及预算边界 | 已知冲突零发送；N允许/N-1拒绝；unavailable单独覆盖D2 |
| TCD-Q1 | Chat工具SSE opaque-only | 消息级状态只回投一次，无空卡片 |
| TCD-Q2 | 两协议无可读文本 | 仍保留状态、完成续轮，不增发请求造文本 |
| TCD-Q3 | 正文完整/分片/未闭合think标签 | 普通文本语义不变，不提取、不等待、不生成Thinking |
| TCD-Q4 | Chat单值/重复/空值/非法值/中断 | 单值原样保存；重复包括相同值均安全报错；异常终止不提交伪完整状态 |
| TCD-E1 | 回放错误跨Core/Extension/Runtime/UI | 使用既有安全类别，不伪造providerErrorCode、不回显原始数据 |
| TCD-R5 | 同协议切模型的原值/缺失/损坏对照 | 同模型基线成立；已核实兼容范围不被ID差异误拒；未知范围明确失败，不由HTTP成功推断推理等价 |
| TCD-C4 | unavailable预算及上游overflow恢复 | 首次原样发送并记录安全warning；明确overflow复用既有有界Compaction且最多重试一次；无候选、Compaction失败或二次overflow停止；不泄漏或按密文长度伪造估算 |

验证依次覆盖Client/collector/Runner/Session/Context聚焦测试、真实Session到请求的集成、Runtime/Channel投影、Web交互、多Session隔离、Extension导出及Fitness；最终运行相关lint/build和回归，再独立评审并由所有者验收。文档检查不替代这些生产验证；现有Spike结果及历史检查均见[validation](validation.md)。

## 11. Remaining decisions before acceptance

除整体设计批准外，下列决定分别记录原则确认与尚未解决的边界，不能将Spike结果冒充生产验收：

| 决策 | 建议与替代项 | 影响 / G0要求 |
|---|---|---|
| D1 未核实的同协议模型/连接兼容性 | 所有者已认可保守原则，要求先Spike而非想当然；本轮已完成§7.8受控实测。Client发送前校验provider、connection、wire protocol及invocation/block关系；不静默剥离状态，不新增摘要重开路径 | 两组同协议切模型成功，不能按modelId不同一律拒绝。结果限定该连接/方向/形状，未知账户及连接仍不承诺 |
| D2 opaque推理用量不可估算 | 所有者方向已确认：正常运行优先，不因不确定性默认停止。Provider有可解释usage/上界时使用；否则标记`unavailable`并允许一次上游裁决，记录安全warning。明确overflow后复用既有有界Compaction并最多重试一次；失败后停止 | 与Codex/OpenCode/OpenAI Agents SDK/OpenClaw的公开实现对照见[validation §8](validation.md#8-opaque预算的主流实现对照2026-10-02)。不可判定不冒充通过，不使用通用密文长度公式，不破坏活动链 |

具体类型、v2升级、Session返回值、Client/Provider边界及最小预算路由均已落地并验证。D1/D2不再是开放实现选项；未追加真实计费网关复测不影响本次所有者验收，后续扩大Provider/模型范围须重新取证。
