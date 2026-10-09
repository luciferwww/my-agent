# Automation 系统设计草稿

> Status: Non-authoritative design draft
> Date: 2026-10-08
> Authorization: 仅记录调研结论与设计方向，不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications、已批准的 Active Change 或源代码

## 1. 问题

当前 `my-agent` 主要响应实时输入，没有持久的计划任务能力：

- Session 保存对话，但不负责未来何时运行；
- Runtime 执行当前工作，但不持久保存未来工作；
- `ProcessRegistry` 管理进程内命令，不是计划任务存储；
- Subagent 必须由活跃 Parent Turn 发起，不能代表一个独立计划任务。

如果希望 Agent 主动、定期工作，需要一个持久的 Automation 能力。

## 2. 基本结论

### 2.1 Automation 不等于 Scheduler

Automation 是完整能力，至少包含：

- 保存任务定义；
- 判断任务何时到期；
- 发起一次 Agent 执行；
- 记录最近一次运行是否成功；
- 在重启后恢复。

Scheduler 只负责时间判断和到期唤醒，不拥有 Agent、Session、Tool 或结果交付。

### 2.2 持久 Automation 不等于 `/loop`

需要区分：

| 类型 | 生命周期 |
|---|---|
| 持久 Automation | 定义跨进程重启保存，由长期运行的 Runtime 执行 |
| Session Loop | 只在当前进程或 Session 存活期间重复执行 |

第一版面向本地 Runtime，因此机器或 Runtime 不在线时无法准时运行。未来若有云端 Runtime，可以复用同一 Job/Run 语义，但不在本草稿范围内。

### 2.3 一次计划运行是顶层 Agent 执行

计划任务到期时没有 Parent Turn，因此它不是 Subagent。

建议语义：

```text
Automation Job 到期
-> 创建 Automation Run
-> 创建新的 Session
-> 发起一次没有 Parent 的顶层 Agent Turn
-> 运行中可按现有规则创建 Subagent
```

当前 Runtime 中只有由 Channel 消息触发的顶层 Turn。它经过 Session 队列、generation capture、Model resolution、Prompt、`AgentRunner`、Abort 和终态清理。

Automation 不应伪造 `ChannelRunRequest`，也不能直接依赖当前私有的 `startRootTurn()`。正式设计时只需确定如何以最小改动复用其中与 Channel 无关的执行逻辑，不在 Research 阶段预先设计新的执行框架。

Subagent 和 Automation 应复用同一份 Configured Agent/Role 列表，而不是分别维护 `subagents.list[]` 与 `automationAgents.list[]`。建议将现有 `agents.list[]` 正式定义为唯一 Role Registry：

```text
agents.list[]
├── general-purpose
├── researcher
└── reviewer
        │
        ├── Subagent 通过 agentId 选择
        └── Automation Job 通过 agentId 选择
```

共享 Role 只定义“谁来做、具有什么基础行为与能力”，包括：

- `id` 和描述；
- Context/Instructions；
- 可选 Model 覆盖；
- Tool policy；
- Memory、Context budget 和 Compaction 等可覆盖的 Agent 能力。

两种入口使用同一个 `agentId` 和同一套 Role 解析规则：

- 显式 Model 覆盖在两种执行方式中含义一致；
- 未配置 Model 表示不覆盖当前执行入口的基础 Model，不再使用依赖 Parent 的 `model: inherit`；
- Role Tool policy 只能在执行入口已有能力上继续收窄，不能恢复上层 deny；
- Role 不包含 Schedule、Session、Approval route、depth 或运行次数限制。

Subagent 与 Automation 的执行 Envelope 仍然分开：

- Subagent 拥有 Parent/Child、depth、Parent Abort、Tool Result 返回和 transient Session 生命周期；
- Automation 拥有 Job/Run、Schedule、Scheduled Session、独立 Approval route 和恢复语义。

现有 Subagent Profile 中依赖 Parent 的 `model: inherit`、allow 替换语义和生命周期规则不能原样提升为共享 Role。正式设计需要迁移这些 Parent-relative 语义，而不是给 `agents.list[]` 再套一层 Subagent Profile。

### 2.4 默认使用新 Session

第一版每个 Run 创建一个在运行期间持久化的 Session：

- 不隐式继承旧 Transcript；
- Run 非终态时，用户可以从 Scheduled 组打开该 Session；
- 跨 Run 状态通过 Git、Workspace、Memory 或未来的结构化 Job State 延续。
- Run 进入终态后，保存该 Job 的最近运行时间、状态和必要错误，再删除该 Session 和 Transcript。

Automation Session 与普通 Session 并列，没有 parent Session。客户端按来源分组展示：

```text
Session List
├── 普通 Session
└── Scheduled
    └── Automation Run · Waiting for approval
```

Session 需要持久化最小来源标识：

```text
普通 Session：沿用现状，不写 provenance

automation {
  jobId
  runId
}
```

当前 Subagent 使用 transient Transcript 根记录中的 `provenance: subagent` 区分，且没有 `SessionEntry`，因此不会出现在 Session List。Automation Session 需要在运行期间出现在列表中，不能完全照搬 Subagent 的 transient 机制；其 Automation provenance 必须能进入 Session 列表投影。具体存放在 `SessionEntry` 还是由 Runtime 合并 Automation Run 信息，留到正式设计确定。

`waiting_approval`、`running` 等状态不复制到 Session metadata，由关联的 Automation Run 提供。Session 来源只用于客户端分组、Approval 定位和终态清理。

`Scheduled` 只是展示分组。Job 不绑定创建 Job 的普通 Session；删除普通 Session 不影响 Job。Job 保存 `agentId` 并在每次 Run admission 时从 `agents.list[]` 解析对应 Role。Job 不复制 Role 配置，因此后续 Run 使用当前有效配置；若 Role 已删除，Run 必须明确失败，不能静默回退到其他 Role。

`Scheduled` 只显示运行中和等待审批的 Automation Session。已结束 Run 不保留长期 Session；Job 详情只显示最近运行时间、状态和必要错误。Automation Session 是运行期交互载体，第一版不提供完整 Run History。

暂不支持继续任意现有 Session，也暂不引入独立 `sessionKey`。

### 2.5 全局 Agent 执行策略

Role 不应拥有各自的 LLM 调用次数或 Subagent 嵌套深度。这些是整个 Runtime 的安全与编排边界，建议从现有 `runner` 和 Agent-scoped `subagents` 配置中提升到 `agents` 顶层：

```json
{
  "agents": {
    "steeringEnabled": false,
    "maxLlmCallsPerTurn": 20,
    "maxSubagentDepth": 1,
    "defaults": {
      "memory": {},
      "tools": {},
      "context": {},
      "compaction": {}
    },
    "list": []
  }
}
```

语义如下：

- `agents.steeringEnabled`：所有 Agent Turn 共用的 Steering 策略；
- `agents.maxLlmCallsPerTurn`：每个独立 Root 或 Child Turn 的 Model 调用上限，每个 Turn 独立计数；
- `agents.maxSubagentDepth`：所有普通 Root Turn 和 Automation Root Turn 共用的 Child 嵌套上限；
- `agents.defaults` 与 `agents.list[]`：只保存可按 Role 继承或覆盖的 Agent 能力配置。

这些字段进入 `agents` 配置结构，不改变默认值 ownership：

- `core/runner` 定义 `steeringEnabled` 和 `maxLlmCallsPerTurn` 的默认语义；
- `core/subagent` 定义 `maxSubagentDepth` 的默认值和合法范围；
- Memory、Tools、Agent Context 和 Compaction 继续分别定义自己的默认配置；
- 未来 `core/automation` 定义 Automation 自己的默认值。

`platform/config` 不写任何上述 leaf literal。它只加载文档、调用 owner validation、应用 precedence/merge，并像现有 `createDefaultAgentConfig()` 一样克隆和组装各模块导出的不可变默认值。

公开配置边界统一为 `agents`，不再暴露独立的 `runner` section。现有 `platform/config` 已拥有 `AgentEntry`、`agents.defaults/list`、文档加载、precedence/merge 和 `resolveAgentConfig()`，因此共享 Role Registry 继续沿用该组合边界，不为它新增 `Core Agent` 目录。内部 `core/runner` 已通过 `AgentRunner` 负责一次 Agent Turn 的 Model/Tool loop、Hook、Compaction、Steering safe point 和执行事件，也不需要仅为命名迁移目录。

`maxLlmCallsPerTurn` 应覆盖同一 Turn 的 Compaction retry，不能在新的 `runAttempt()` 中重置。是否将 Compaction 摘要调用计入该上限需在正式 Specification 中明确；若不计入，文档必须明确该字段只计算 Agent loop Model calls。

现有 `subagents` 配置 section 在该模型下不再需要：

```text
subagents.list[]
-> agents.list[]

subagents.maxDepth
-> agents.maxSubagentDepth

subagents.enabled
-> 由 task Tool policy 表达
```

禁用 Subagent 使用现有最终 deny：

```json
{
  "agents": {
    "defaults": {
      "tools": {
        "deny": ["task"]
      }
    }
  }
}
```

运行时只需同时判断：

1. 当前有效 Tool policy 是否允许 `task`；
2. 当前 Child depth 是否小于全局 `agents.maxSubagentDepth`。

达到全局深度上限时，Runtime 移除 `task` capability；任何 Role policy 都不能将其恢复。Subagent Runtime、Task Tool 和 Parent/Child 概念继续存在，删除的只是重复的公开配置 section。

## 3. 与现有项目模块对齐

Automation 不新增与 `Core / Runtime / Platform / Builtins / Extension / Hosts` 并列的架构层。

当前结构已经有可演进的 owner：

```text
src/platform/config/
  AgentEntry、agents.defaults/list、文档加载、precedence/merge、
  owner defaults 组合和 resolveAgentConfig()

src/core/runner/
  AgentRunner、一次 Agent Turn 的执行及其 leaf defaults/validation

src/core/subagent/
  Parent/Child capability、全局 depth defaults/validation、委派准备和 Child 执行

src/runtime/
  Agent 解析结果与具体 Root/Subagent/Automation Envelope 的组合
```

因此不新增 `src/core/agent/` 或 `src/core/agent-runner/`。共享 Role 的最小结构调整是：

1. 扩展现有 `AgentEntry`，承载描述、可选 Model 覆盖和现有 Agent 能力覆盖；
2. 让 `platform/config` 继续加载并解析唯一的 `agents.list[]`，但不接管 leaf 默认值；
3. 将 `core/subagent` 中通用的 Profile 定义和配置加载移回上述共享配置路径，只保留 Child 特有的执行语义；
4. 保持 `core/runner` 目录和 `AgentRunner` 名称不变；
5. Runtime 为 Subagent 和 Automation 按 `agentId` 取得同一份已解析 Agent 配置，再添加各自 Envelope。

Automation 本身只建议增加两个符合现有分层的模块：

```text
src/core/automation/
  Job、Run、Schedule、配置、时间计算和持久化

src/runtime/automation/
  到期检查、Run admission、执行编排、恢复和 shutdown 收敛
```

`agent-context`、Model Resolution、Tools、Memory、Session 和 `AgentRunner` 继续保持现有 owner，不因共享 Role 或 Automation 调整目录。

模块职责建议调整为：

| 模块 | Automation 相关职责 |
|---|---|
| Platform Config | 扩展现有 `AgentEntry`，加载并解析共享 Role，组合各 owner 的默认值，不定义 leaf literal |
| `AgentRunner`（现有 `src/core/runner/`） | 执行一次 Agent Turn；所在模块定义相关 leaf defaults/validation，但不拥有 Role 选择或 Session 生命周期 |
| Core Subagent | 定义全局 depth defaults/validation，只拥有 Parent/Child capability、委派准备和 Child 执行 |
| Core Automation | 定义 Automation defaults/validation，保存 Job/Run，计算下一次 occurrence |
| Runtime Automation | 维护 timer，创建到期 Run，按 `agentId` 解析 Role 并提交顶层 Agent 执行 |
| RuntimeApp | 组合 Root、Subagent 和 Automation 执行 Envelope，管理 Turn admission |
| Session | 继续拥有 Session 和 Transcript |
| Channel | 提供创建、查看、启停任务的界面，不拥有任务 |
| Standalone Host | 保持进程存活并处理 process shutdown，不拥有 Scheduler |

可选的结构调整建议只有一项：如果未来 `platform/config` 同时承担文件 I/O 和越来越多的 Agent 领域解析，可再将纯 Agent 配置类型与解析函数提取到现有 Core owner；当前共享 Role 与 Automation 不足以证明需要这次拆分，不纳入第一版。

不预先拆分 `AutomationExecutor`、`AutomationRecovery`、`AutomationRunStore` 等顶层组件。是否需要内部类或文件，由后续正式设计和实现复杂度决定。

## 4. 最小领域模型

### 4.1 Job

Job 表示用户希望未来发生什么，至少需要：

- `jobId`；
- 名称；
- `agentId`，引用 `agents.list[]` 中的共享 Role；
- Schedule；
- Prompt；
- enabled 状态；
- 下一次运行时间；
- revision。

第一版 Schedule：

- `at`：一次性；
- `every`：固定间隔；
- `cron`：带显式时区的 Cron。

### 4.2 Run

Run 表示某个 occurrence 实际发生了什么，至少需要：

- `runId`；
- `jobId` 和当时的 Job revision；
- `occurrenceAt`；
- 状态；
- 实际开始和结束时间；
- `sessionId`、`turnId`；
- 运行期间需要的错误信息。

Job 与当前 Run 必须分开。修改 Job 不能改变已经 admission 的 Run。

Run 在非终态时必须持久化，用于重启恢复、等待审批、overlap 判断和避免重复 admission。第一版不无限保留终态 Run；每个 Job 只保留最近运行时间、状态和必要错误，不保存任务输出。完整历史留待出现明确审计需求后再设计。

候选终态包括：

- succeeded；
- failed；
- cancelled；
- timed out；
- skipped；
- interrupted。

具体状态机留到正式 Specification。

## 5. 持久化与调度原则

建议使用独立的：

```text
<agentHome>/automations.sqlite
```

同一个 Automation 持久化模块同时管理 Job 和 Run，不再拆成两个 Store。

需要保证：

1. 同一个 `jobId + occurrenceAt` 最多创建一个 Run identity；
2. 创建 Run 与推进 Job 下一次时间在同一事务完成；
3. Timer 唤醒后重新读取持久状态，不执行捕获的旧 Job；
4. 周期任务离线后不补跑所有错过的 occurrence；
5. 重启时不自动重放副作用未知的 interrupted Run。

第一版建议：

- overlap：`skip`；
- missed recurring run：`skip` 或最多补最近一次；
- 一个 Runtime 只维护一个最近到期 timer。

这些原则需要后续用 Fake Clock 和 SQLite 测试验证，但本草稿不规定具体类或 SQL Schema。

## 6. Tool Approval

第一版不在创建 Job 时预测或保存一套独立权限，也不要求 LLM 准确判断未来会使用哪些 Tool。

Automation Run 使用所选 Role 的基础 Tool policy，并与 Runtime 和 Session 的现有 Tool policy 共同收窄有效能力。Role 不能恢复上层已经 deny 的 Tool。真正调用仍有资格但需要 Approval 的 Tool 时：

```text
Tool 请求 Approval
-> Run 进入 waiting_approval
-> Scheduled 组显示等待状态
-> 用户打开该 Run 的 Session，查看实际 Tool 和参数
-> approve 后执行当前 Tool Call
-> deny 后当前 Tool Call 返回 denied，Agent Turn 可继续或结束
```

这样三个示例自然得到不同结果：

- 删除文件：实际删除调用等待审批；
- 获取股票并通知：实际网络和通知调用分别按现有规则审批；
- 本地提醒：不调用受限 Tool，不产生审批。

第一版只需要批准当前调用，不提供“永久允许此 Job”、风险等级、权限预测或独立 capability envelope。现有 deny policy 仍然最终生效，Approval 不能越过 deny。

Approval 属于 Automation Run 自己的 Session，不发送到创建 Job 的旧 Session。候选共享路由、Session 列表提醒、切换 Session 时 replay、多 Channel first-settlement-wins 和 process-local 边界见 [Session-addressed Approval 设计草稿](session-addressed-approval-design-draft.md)。

Automation 本身不拥有专用 Approval manager、Tool policy 或 wire protocol。第一版不增加独立的全局 Approval Inbox，也不恢复 Runtime 重启前 suspended Tool Call。

等待审批期间不占用 CPU，但该 Run 仍是非终态，因此同一 Job 后续 occurrence 按 overlap policy 跳过。若 Runtime 在等待期间关闭，Run 记为 interrupted；第一版不设计跨重启恢复的 pending Approval。

## 7. 生命周期

Runtime 启动时：

- 打开 Automation 持久化；
- 处理错过的 occurrence；
- 将无法确认仍在执行的旧 Run 标记为 interrupted；
- 启动最近到期 timer。

Runtime 关闭时：

- 停止接纳新的到期 Run；
- 取消 timer；
- 等待或中止正在执行的 Automation Turn；
- 记录仍未收敛的 Run；
- 关闭持久化。

Standalone Host 仍只负责 process signal 和 exit policy。

## 8. 第一版范围

包含：

- `at`、`every`、`cron`；
- Job 通过 `agentId` 选择 Subagent 与 Automation 共用的 `agents.list[]` Role；
- Job/Run 持久化；
- 每个 Run 使用新的 Session，终态保存最近运行状态后删除；
- Tool 调用按现有策略等待用户审批；
- enable、disable、delete、run now；
- 每个 Job 的最近一次运行状态；
- 重启恢复；
- 本地长期运行的 Runtime。

交付顺序先用 `run now + at` 打通 Job、Run、Scheduled Session 和 Approval，再增加 `every` 与 `cron`，避免同时验证时间计算和执行链路。

暂缓：

- 继续已有 Session；
- `/loop`；
- Webhook 和事件触发；
- 外部通知与 Delivery；
- Command/Script Payload；
- 分布式 Scheduler；
- 外部副作用 exactly once；
- Dreaming 的具体实现。

未来 Dreaming 可以使用 Automation 基础设施，但不应影响第一版边界。

## 9. 仍待确认

1. 本地 Runtime 以什么方式长期运行。
2. Cron 库及其 DST 行为。
3. 一次性 Job 成功后是保留为 disabled，还是删除。

## 10. 后续正式化

本草稿不授权实现。

如果决定继续，应先：

1. 将工作分类为 Architecture Slice；
2. 明确共享 Role Registry 对现有 `subagents.list[]` Stable Contract 的迁移方式；
3. 从本草稿提取最小 Plan、ADR 和 Specification；
4. 只对 Cron/DST、SQLite 并发和 Runtime 执行入口等真实未知做 Spike；
5. 由项目所有者接受设计后，再进入 `docs/changes/active/`。
