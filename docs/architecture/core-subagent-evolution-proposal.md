# Subagent 演进建议

> 文档日期：2026-08-28
> 状态：**PROPOSAL**（建议稿，尚未批准为实施 Spec）
> 适用基线：Subagent v1 已实现，用户主动 Abort 已实现，Subagent v2 并发 Spec 尚未实现
> 关联文档：`core-subagent-spec.md` · `core-subagent-impl.md` · `core-subagent-v2-spec.md` · `core-abort-spec.md`

---

## 1. 目的

本文基于 my-agent 当前架构，提出 Subagent 的分阶段演进建议。重点回答：

1. my-agent 应支持哪些 Subagent 运行方式；
2. 哪些能力适合当前单进程、可嵌入 Runtime；
3. 如何以较低风险实现阻塞式并发；
4. 如何处理共享 Workspace、失败、取消和并发预算；
5. Background、Fork、Handoff 和 Agent Team 应如何取舍；
6. 各阶段的预估实现成本和风险。

本文不修改现有实现契约。若接受本文路线，应先修订 `core-subagent-v2-spec.md`，再进入代码实施。

---

## 2. 当前能力与边界

### 2.1 已实现

- Main Agent 可通过 `task` 工具调用一个 Subagent。
- Library 可通过 `RuntimeApp.runSubagentTurn(...)` 调用 Subagent。
- Subagent 使用独立 `sessionKey`、`turnId`、Session、System Prompt、工具集和 LLM 调用预算。
- Subagent 完成后只把最终文本返回父 Agent。
- Approval 按子 `turnId` 复用父 Turn 的 Channel 路由。
- 父 Turn 的 `AbortSignal` 可级联到 Subagent。
- `subagent_start` / `subagent_end` 和子 Agent 内部事件可被观测。
- 不同 Session 可以自然并发。

### 2.2 当前限制

- `AgentRunner` 对同一轮中的多个 Tool Use 使用 `for...of + await` 串行执行。
- `task` 是阻塞工具；同一父 Turn 中的多个 Subagent 严格串行。
- `RunLifecycle` 只有 `blocking`。
- 没有 Batch API、并发 Gate、Background Handle 或运行注册表。
- 没有 Fork 父历史、Worktree 隔离、跨 Agent 通信或 Handoff。
- Subagent Session 隔离，但 Workspace 默认共享。

---

## 3. 设计判断

### 3.1 不把所有能力归为“并发模式”

主流 Agent 系统通常支持多种组合能力。它们应拆成正交维度，而不是不断向一个 `task` 工具添加参数：

| 维度 | 候选模式 |
|---|---|
| 编排方式 | single / batch parallel / sequence / graph |
| 生命周期 | blocking / background / durable detached |
| 上下文来源 | isolated / summary / fork |
| 控制权 | manager / handoff / peer team |
| 执行隔离 | shared workspace / read-only / worktree / remote sandbox |

my-agent 当前最适合继续采用 **Manager + Subagent-as-Tool**：Main Agent 保持用户会话和最终回答的所有权，Subagent 处理边界明确的任务并返回结果。

### 3.2 推荐的核心模型

近期目标采用阻塞式 fan-out / fan-in：

```text
Main Agent 创建 Subtask Inputs
    ↓ fan-out
受并发 Gate 控制地运行多个 Subagent
    ↓
每个 Subagent 独立处理并返回结果
    ↓ fan-in / join（allSettled）
Main Agent 获得稳定排序的结果集合
    ↓
Main Agent 综合结果并继续执行
```

理想情况下：

$$
T_{batch} \approx \max(T_1, T_2, \ldots, T_n)
$$

实际活跃数量受并发上限约束：

$$
activeSubagents \le \min(n, maxConcurrent, maxSiblingParallel)
$$

### 3.3 Subagent 数量不必与输入数量固定相等

常见映射包括：

- 一个输入对应一个 Subagent；
- 固定数量 Worker 从输入队列领取任务；
- 同一个输入交给多个 Subagent 做投票或选优；
- 一个 Subagent 批量处理多个小输入。

MVP 采用“一项 Batch Input 对应一次 Subagent Run”，但 API 不应把物理 Worker 数与 Input 数绑定。

---

## 4. 核心建议：先实现显式 Batch

### 4.1 为什么不先改通用 Tool 执行循环

现有 v2 Spec 计划给 `Tool` 增加 `parallelSafe`，并把 `AgentRunner` 工具循环改成 barrier-based parallel execution。该方案更通用，但会修改执行热路径，并扩大以下回归面：

- Tool Use / Tool Result 的顺序和配对；
- Hook 并发行为；
- Approval 并发路由；
- 混合读写工具的 barrier 语义；
- 异常隔离与 Abort 收敛；
- Tool Result Pruning 和 Compaction；
- Feature Flag 关闭后的行为等价性。

建议先增加显式 Subagent Batch，不修改 `AgentRunner` 的通用工具循环。它能直接覆盖最主要的并发需求，并复用现有 `SubagentRunner.run()`。

### 4.2 Runtime 原语

建议逐步建立以下 API：

```ts
interface SubagentService {
  run(request: SubagentRunInput): Promise<SubagentRunResult>;

  runBatch(
    request: SubagentBatchInput,
  ): Promise<SubagentBatchResult>;

  // 后续 Background 阶段再增加
  spawn(request: SubagentRunInput): Promise<SubagentHandle>;
  wait(handles: SubagentHandle[]): Promise<SubagentBatchResult>;
  cancel(handle: SubagentHandle): Promise<void>;
}
```

Runtime 原语负责调度和生命周期；LLM Tool 只是适配器，不应成为唯一可用入口。

### 4.3 Batch 类型建议

```ts
interface SubagentBatchItemInput {
  id: string;
  subagentType: string;
  description: string;
  prompt: string;
  timeoutMs?: number;
}

interface SubagentBatchInput {
  items: SubagentBatchItemInput[];
  maxConcurrency?: number;
  signal?: AbortSignal;
}

interface SubagentBatchItemResult {
  id: string;
  status: 'ok' | 'error' | 'aborted' | 'max_llm_calls' | 'timeout';
  text: string;
  usage: TokenUsage;
  durationMs: number;
  reason?: string;
}

interface SubagentBatchResult {
  items: SubagentBatchItemResult[];
  usage: TokenUsage;
  durationMs: number;
}
```

结果必须按 Input 顺序或稳定 `id` 返回，不能按完成顺序暴露给 Main LLM。

### 4.4 LLM 工具建议

保留现有 `task`，新增显式 `task_batch`：

```json
{
  "tasks": [
    {
      "id": "auth",
      "subagent_type": "reviewer",
      "description": "Review authentication",
      "prompt": "Review the authentication module and report risks."
    },
    {
      "id": "database",
      "subagent_type": "reviewer",
      "description": "Review database access",
      "prompt": "Review database access and report risks."
    }
  ]
}
```

`task_batch` 内部调用与 Library API 相同的 Batch Executor，避免产生两套并发语义。

### 4.5 Join 策略

MVP 固定采用 `allSettled`：

```text
A → ok
B → error
C → max_llm_calls
D → aborted
```

Main Agent 应获得全部结果。单项失败不能丢弃其他成功输出。

未来可按真实需求增加：

- `all`：全部成功，否则整体失败；
- `first-success`：第一个有效结果完成后取消其他任务；
- `quorum`：达到有效结果数量后继续；
- `streaming-reduce`：结果完成一个处理一个。

这些策略不建议进入 MVP。

---

## 5. 并发安全与 Workspace 隔离

### 5.1 当前 v2 Spec 的关键风险

当前 v2 Spec 计划把 `task` 标记为 `parallelSafe: true`，理由是子 Session、JSONL 和路由相互隔离。该论证不足：

> Session 隔离不等于 Workspace 隔离。

两个 Subagent 可能同时：

- 修改同一个文件；
- 一个读取另一个的中间状态；
- 同时安装依赖或修改 Lockfile；
- 同时运行影响共享环境的命令；
- 让测试读取不一致的工作树。

### 5.2 MVP 安全策略

建议按 Profile 的有效工具权限决定是否允许并发：

| Profile 能力 | 默认策略 |
|---|---|
| 只读工具 | 允许并发 |
| 文件写入、进程或其他共享副作用 | 默认串行 |
| 写工具 + 独立 Worktree/Sandbox | 允许受控并发 |
| 无法判断的第三方/MCP 工具 | 默认串行 |

不要仅依赖 `Tool.parallelSafe` 推导一个 Subagent 是否安全，因为 Subagent 在一次 Run 中可能调用多个工具，其风险由完整 Profile 和隔离环境共同决定。

### 5.3 后续写入隔离

写任务并发建议采用以下一种模式：

1. 每个 Subagent 使用独立 Worktree/Sandbox，完成后由 Main Agent Merge；
2. Subagent 只返回 Patch 或修改建议，由 Main Agent 串行应用；
3. 任务按不重叠文件集预分区，并由 Runtime 做冲突检测。

优先级建议为 Worktree/Sandbox > 返回 Patch > 依赖 Prompt 保证不冲突。

---

## 6. 并发 Gate 与资源治理

至少需要两个 Gate：

```text
global maxConcurrent
    ↓
per-parent-turn maxSiblingParallel
    ↓
SubagentRunner.run()
```

推荐初始配置：

```yaml
subagents:
  maxConcurrent: 4
  maxSiblingParallel: 4
  maxBatchSize: 8
```

建议额外设置硬上限，例如 `maxBatchSize <= 32`，避免 Main LLM 一次生成过多任务放大 API 成本。

Gate 必须满足：

- FIFO 或明确的公平策略；
- `finally` 中释放名额；
- 等待 Gate 时可响应 Abort；
- Library API 与 LLM Tool 共享全局 Gate；
- 记录排队时间、运行时间和拒绝原因；
- Runtime shutdown 时不再接收新任务。

---

## 7. Abort、Timeout 与失败语义

### 7.1 Abort

复用现有 Signal 链：

```text
Parent AbortController
    ↓
SubagentBatch signal
    ↓ fan-out
所有 active / queued Subagent items
```

父 Turn Abort 默认取消整个 Batch。后续若增加 `SubagentHandle`，可再支持取消单个 Item。

### 7.2 Timeout

建议使用 per-item timeout，而不是只有 Batch 总超时：

- 单个慢任务超时不影响其他任务；
- 结果明确标记为 `timeout`；
- Runtime 通过派生 `AbortController` 中止对应 Run；
- 不依赖 `Promise.race` 后丢弃仍在后台运行的任务。

### 7.3 错误隔离

- Profile 不存在：Library API 在启动 Batch 前拒绝该 Item；LLM Tool 可按现有 `task` 规则 fallback，或统一改为显式错误，需单独决策。
- 单项异常：转为该 Item 的 `status='error'`。
- Batch 基础设施异常：仅在无法继续调度时抛出整体错误。
- Partial Output：在 `error`、`aborted`、`timeout` 时尽量保留，但必须标记为非完整结果。

---

## 8. Background 与 Detached

### 8.1 两者必须区分

**Background**：任务在当前 Runtime 进程中继续运行；Runtime shutdown 时中止或等待。

**Durable Detached**：父 Turn 或进程结束后任务仍可恢复，需要持久化任务状态和结果。

建议先做 Background，不把 Durable Detached 混入同一阶段。

### 8.2 Background API

```ts
interface SubagentHandle {
  runId: string;
}

spawn(request): Promise<SubagentHandle>
status(handle): SubagentRunStatus
wait(handles): Promise<SubagentBatchResult>
cancel(handle): Promise<void>
```

Runtime 需要维护 Active Run Registry：

```ts
Map<string, {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted';
  promise: Promise<SubagentRunResult>;
  controller: AbortController;
  result?: SubagentRunResult;
  createdAt: number;
  completedAt?: number;
}>
```

还需定义：

- Result 保留和清理时间；
- 父 Turn 结束后的 Usage 归属；
- Completion Event；
- Handle 跨 Turn 的可见性；
- Runtime shutdown 策略；
- Channel 如何显示和取消指定任务。

不建议 MVP 通过向父 Session 自动注入伪 User Message 来通知完成。优先采用结构化 Event 和显式 `wait`。

---

## 9. Context、Handoff 与 Team

### 9.1 Context 模式

建议未来采用三档：

```ts
type SubagentContextMode = 'isolated' | 'summary' | 'fork';
```

| 模式 | 语义 | 建议 |
|---|---|---|
| isolated | 当前模式，只接收明确任务输入 | 保持默认 |
| summary | Main Agent 生成受控摘要 | 优先增加 |
| fork | 复制完整父 Conversation History | 按需求后置 |

`summary` 通常能覆盖大多数需要父上下文的任务，同时减少无关信息、Token 和隐私扩散。

### 9.2 Handoff

Handoff 不应作为 Subagent 生命周期值：

```text
Subagent: Main → Specialist → Main
Handoff:  Main → Specialist 接管用户会话
```

Handoff 会改变活跃 Agent、Channel 路由、Session 身份和 Prompt，应建立独立 Spec。

### 9.3 Nested Subagent

近期保持 `maxDepth=1`。放开前必须解决：

- 分层并发配额；
- 父子级联取消；
- 总 LLM 调用和 Token 预算；
- 循环委派检测；
- 深层结果压缩；
- Gate 获取顺序和死锁问题。

### 9.4 Agent Team

当前不建议实施 Peer-to-Peer Agent Team。共享任务队列、Agent 间消息、Leader 选举和终止判断会把 my-agent 从 Manager Runtime 推向多 Agent 协调系统，成本和运行风险明显高于当前收益。

---

## 10. 推荐实施路线

### Phase 1：阻塞式 Batch MVP

- `runSubagentBatch(...)` Library API；
- `task_batch` LLM Tool；
- `allSettled` Join；
- 稳定结果顺序；
- 全局/per-parent Gate；
- Batch Size 限制；
- 父 Abort 级联；
- 只读 Profile 默认并发；
- Usage 与 Duration 聚合。

### Phase 2：写任务隔离

- Worktree 或 Sandbox；
- Main Agent 统一 Merge/Apply；
- 文件冲突检测；
- 隔离环境的清理和失败保留策略。

### Phase 3：进程内 Background

- `spawn/status/wait/cancel`；
- Active Run Registry；
- Completion Event；
- Result Retention；
- Runtime shutdown 中止或等待策略。

### Phase 4：Context 扩展

- 优先 `summary`；
- 按真实需求增加 `fork` 和 Resume。

### 独立方向

- Handoff；
- Durable Detached；
- Nested Orchestrator；
- Agent Team；
- 通用 Tool `parallelSafe` 执行。

---

## 11. 实现成本估算

以下估算以一名熟悉项目的工程师为基准，包含实现、单元测试、集成测试和文档，不包含排队 Review 时间。合理误差约为 `±40%`。

| 能力 | 预估成本 | 风险 |
|---|---:|---|
| Library `runSubagentBatch()` | 2–4 人日 | 低 |
| LLM `task_batch` | 额外 2–3 人日 | 低到中 |
| 阻塞式 Batch 完整 MVP | 5–8 人日 | 中低 |
| 当前 v2 Spec 的通用 Tool 并发 | 7–12 人日 | 中高 |
| 只读/写入并发策略 | 2–4 人日 | 中 |
| Worktree 写入隔离 | 8–15 人日 | 中高 |
| 进程内 Background Handle | 7–12 人日 | 中高 |
| Durable Detached + 重启恢复 | 15–30 人日 | 高 |
| Context Summary | 3–5 人日 | 中低 |
| 完整 Fork 父历史 | 7–12 人日 | 中高 |
| Handoff | 10–20 人日 | 高 |
| Agent Team | 20–40+ 人日 | 很高 |

### 11.1 Batch MVP 细分

| 工作项 | 预估成本 |
|---|---:|
| Batch 类型与 Executor | 1 人日 |
| Semaphore/Gate 与配置 | 1 人日 |
| Runtime/Library API | 0.5–1 人日 |
| `task_batch` Tool | 1–2 人日 |
| 单元与集成测试 | 1.5–2 人日 |
| 文档同步 | 0.5 人日 |

### 11.2 当前架构带来的成本优势

以下现有能力可直接复用：

- `SubagentRunner.run()` 执行单元；
- 独立 Session / Turn 标识；
- 跨 Session 并发能力；
- Approval 路由；
- AbortSignal 链；
- Agent Event Fanout；
- Library API 模式；
- Session Store 锁。

主要新增工作集中在 Batch 调度、Gate、结果结构和安全策略，而不是重写 Agent 执行内核。

---

## 12. 与现有 v2 Spec 的关系

现有 `core-subagent-v2-spec.md` 的目标是：让同一个 LLM Assistant Message 中连续的 `parallelSafe` Tool Use 并发执行。它覆盖 Subagent，也覆盖 Read/Search/Web Fetch 等通用工具。

本文建议的差异：

| 维度 | 现有 v2 Spec | 本建议 |
|---|---|---|
| 并发入口 | 同轮多个原生 Tool Use | 显式 `task_batch` / `runSubagentBatch` |
| 修改范围 | `AgentRunner` 通用工具热路径 | Subagent Orchestration 层 |
| 适用工具 | 所有 `parallelSafe` Tool | 仅 Subagent |
| Barrier | 需要 | MVP 不需要 |
| Workspace 风险 | `task` 统一视为并发安全 | 按 Profile 权限和隔离级别判定 |
| 回归面 | 中高 | 中低 |
| 后续扩展 | 通用 Tool 并发 | Background Handle / Worktree |

建议在实施前做一次路线决策：

1. **采用本文路线**：先做显式 Batch，再按收益决定是否实施通用 Tool 并发；
2. **保留原 v2 路线**：先修正 `task.parallelSafe` 对共享 Workspace 风险的判断；
3. **组合路线**：Batch Executor 作为底层，原生多个 `task` Tool Use 后续复用同一 Executor。

推荐选项 3，但实施顺序仍为“显式 Batch 优先，通用 Tool 并发后置”。

---

## 13. 验收重点

Batch MVP 至少覆盖：

- 多个 Subagent 确实存在时间重叠；
- Active 数不超过 Global 和 Sibling Gate；
- 输出按 Input Index/ID 稳定排序；
- 单项失败不取消 Sibling；
- 父 Abort 同时覆盖 Running 和 Queued Items；
- 等待 Gate 时 Abort 不泄漏名额；
- Usage 等于所有 Item Usage 之和；
- 不同父 Turn 共享 Global Gate；
- Runtime shutdown 不接受新 Batch；
- Profile 不存在、Batch 为空、ID 重复和超出 Size Limit 均有确定行为；
- 只读并发不会改变现有单任务 `task` 行为；
- 有共享副作用的 Profile 默认不会并发。

Worktree 阶段额外覆盖：

- 每个 Subagent 写入独立目录；
- Main Workspace 不被中间状态污染；
- Merge Conflict 可观测且不会静默覆盖；
- Abort/异常后 Worktree 按策略清理或保留。

---

## 14. 待确认决策

进入实施 Spec 前需确认：

1. 是否接受“显式 Batch 优先于通用 Tool 并发”；
2. LLM Tool 使用 `task_batch`，还是扩展现有 `task` 接受单项/数组双形态；
3. 只读 Profile 的判定采用工具 allowlist、显式配置，还是二者结合；
4. `maxConcurrent`、`maxSiblingParallel`、`maxBatchSize` 的默认值；
5. LLM Tool 遇到未知 Profile 时 fallback 还是返回单项错误；
6. MVP 是否包含 per-item timeout；
7. 有写权限但无 Worktree 的 Batch 是整体串行，还是拒绝执行；
8. 是否保留现有 v2 Spec 的 `parallelSafe` 作为后续独立能力；
9. Background shutdown 默认 abort 还是 graceful wait；
10. Completion Result 的保留时间和 Usage 归属。

---

## 15. 推荐结论

my-agent 当前最合适的 Subagent 核心是：

> **单个阻塞调用 + 受控并发 Batch + 显式 Background Handle，并保持 Main Agent 对最终结果和用户会话的所有权。**

近期优先实现 `runSubagentBatch + task_batch`，复用现有 `SubagentRunner.run()`，采用 `allSettled`、稳定排序和两级 Gate。只读 Profile 默认允许并发；写任务在 Worktree/Sandbox 落地前默认串行。Background、Fork、Handoff 和 Agent Team 分别进入后续独立阶段，不与 Batch MVP 绑定。