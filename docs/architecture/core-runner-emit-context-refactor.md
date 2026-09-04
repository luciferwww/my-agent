# core/runner emit-context 重构（AgentRunner.currentParams 拆除）

> **状态**：spec / impl，未实施。在 v2 周期或独立 PR 中落地。
> **触发**：v1 subagent 实测过程中两次 emit 上下文丢失，临时 stash-restore 补丁挂账（见 [AgentRunner.ts](../../src/core/runner/AgentRunner.ts) `FIXME(arch-debt, v2)`）。

---

## 1. 现在长什么样

`AgentRunner` 用一个实例字段当"当前正在跑哪个 turn"的存档：

```typescript
// src/core/runner/AgentRunner.ts
export class AgentRunner {
  private currentParams: RunParams | null = null;

  async run(params: RunParams): Promise<RunResult> {
    const previousParams = this.currentParams;   // ← v1 stash 补丁
    this.currentParams = params;
    try {
      this.emit({ type: 'run_start' });          // emit 从字段拿 sessionKey/turnId
      // ... 实际工作
    } finally {
      this.currentParams = previousParams;       // ← v1 restore 补丁
    }
  }

  private emit(event: AgentEventInput): void {
    if (!this.onEvent) return;
    if (!this.currentParams) return;             // ← 静默吞掉
    this.onEvent({
      ...event,
      sessionKey: this.currentParams.sessionKey,
      turnId: this.currentParams.turnId,
    } as AgentEvent);
  }
}
```

每个 `emit({ ... })` 调用点不带 `sessionKey/turnId`，由 emit 自己从字段读出来贴上去。

---

## 2. 为什么这样不行（6 个问题，从严重到轻）

### 2.1 嵌套靠 stash-restore 撑着，仅 LIFO 嵌套下正确
`SubagentRunner` 复用同一个 `AgentRunner` 实例做嵌套 `run()`，所以 v1 加了 stash-restore：进入时存上一层，退出时复原。这在父 → 子 → 父这种严格 LIFO 下能复原。

**但并发**就崩。考虑：
```ts
await Promise.all([runner.run(A), runner.run(B)]);
```
- A 设 `currentParams = A`；await 让出
- B 设 `currentParams = B`（覆盖了内存中的"当前"）
- A 恢复，调 `emit(...)` 拿到 **B 的 sessionKey/turnId**
- A 的 `finally` 把 `currentParams` 还原成 `null`（A 进入时是 null）
- B 还在跑，后续 emit 命中 `if (!this.currentParams) return` 全废

类架构上"只能跑一个 run"，但运行时没强制；一旦有人这么用，事件全错位，且**不报错**。

### 2.2 emit 静默吞掉事件
```ts
if (!this.currentParams) return;
```
这条防御线让"忘了设 currentParams"或者"父 run 期间嵌套调用清掉了"这类问题不抛错，直接丢事件。v1 live demo 跑真实 LLM 才抓出来：父的 `tool_result` / 第二轮 `llm_call` / 最终 `text_delta` / `run_end` 全被吞，session 还是正常跑完的，外部观察者完全不知道。

### 2.3 编译器拦不住忘记设 context
新加一个 `emit` 调用点 / 新加一个 AgentEvent variant，TS 不会要求传 sessionKey/turnId — 因为 emit 签名只收 event。重构时容易漏，且漏了之后看不出错（变成上一节那种静默吞）。

### 2.4 mock 单测测不出来
PR-3 所有 SubagentRunner 单测都 mock 了 `agentRunner.run`，所以"嵌套调用把 currentParams 清成 null"的行为永远不会被触发。单元层 593/593 全过，端到端一跑立刻挂。状态藏在实例里，测试边界就只能整个类一起跑 — 想单独测 emit 的 context 注入逻辑只能靠 e2e。

### 2.5 `callLLMStream` 也读 `this.currentParams`
emit 不是唯一调用点：
```ts
// AgentRunner.ts callLLMStream catch 分支
logger.warn('LLM API returned context overflow', {
  sessionKey: this.currentParams?.sessionKey,
  turnId: this.currentParams?.turnId,
  ...
});
```
还有一处直接读字段。同样的隐式依赖，同样的并发风险。

### 2.6 `as AgentEvent` cast 是被迫的
emit 内部不得不写：
```ts
this.onEvent({
  ...event,
  sessionKey: this.currentParams.sessionKey,
  turnId: this.currentParams.turnId,
} as AgentEvent);
```
TS 无法静态证明 "AgentEventInput + { sessionKey, turnId }" 恰好就是 AgentEvent — 因为这是个 mapped/conditional 类型。重构后这个 cast 可以由签名静态保证。

---

## 3. 修复原理 — 把 turn 上下文从实例字段改成函数参数

**核心改动**：让 `emit` 显式收一个 `turnCtx: { sessionKey: string; turnId: string }`，删掉 `currentParams` 字段。

```typescript
// 新签名
private emit(turnCtx: TurnContext, event: AgentEventInput): void {
  this.onEvent?.({ ...event, sessionKey: turnCtx.sessionKey, turnId: turnCtx.turnId });
}

interface TurnContext {
  readonly sessionKey: string;
  readonly turnId: string;
}
```

`run()` 在入口构造局部 `const turnCtx = { sessionKey: params.sessionKey, turnId: params.turnId }`，沿调用链透传给所有内部方法 (`runAttempt` / `compactHistory` / `callLLMStream` / `sanitizeSessionTail`)。

**为什么这样修干净**：
- 嵌套 / 并发**天然正确**：每次 `run()` 拿到自己栈上的 `turnCtx` 闭包，不会互相干扰
- 编译期强制：每个 `emit` 调用点必须传 ctx，少传一个编译报错
- `if (!this.currentParams) return` 静默吞可以直接删 — emit 永远有 ctx
- 单测能独立测 emit context 注入，不用整个类一起测
- `as AgentEvent` cast 可以消掉（详见 §4.1）
- `callLLMStream` 的隐式依赖也一并修

**与三个备选方案的对比**：

| 方案 | 代价 | 优势 | 劣势 |
|---|---|---|---|
| **B（本方案）：emit 显式 ctx** | 改 ~12 个 emit + 4 个内部方法签名 | stateless、编译期强制、并发 OK | 触面比 v1 任一 PR 大 |
| A：SubagentRunner 自己 new AgentRunner | 改 RuntimeApp 装配 | 物理隔离最彻底 | hook 注册/审批策略要复制；fanout 要复制 |
| C：AsyncLocalStorage 包 run() | 改 run() + emit | 现有 emit 签名不动 | 引入 ALS（async hooks）；嵌套语义不直观；运行时开销 |
| D：保留 stash-restore + 文档说明 | 0 | 改动最小 | 不解决任何根因；并发依然崩 |

选 B，因为只有它**编译期保证**正确，且把 mock 测试和 e2e 测试之间的鸿沟（§2.4）一起填了。

---

## 4. 具体改什么

### 4.1 `src/core/runner/types.ts`：新增 `TurnContext`

```typescript
/**
 * 一次 run 的最小事件标识。供 AgentRunner 内部沿调用链透传给 emit，
 * 替代以前的实例字段 currentParams。
 */
export interface TurnContext {
  readonly sessionKey: string;
  readonly turnId: string;
}
```

为什么独立成 type：`RunParams` 太重（含 message / tools / model / ...），不适合作为 emit 上下文到处传；`TurnContext` 只暴露 2 个字段，意图清晰。

### 4.2 `src/core/runner/AgentRunner.ts`：核心重构

| 改动点 | 现状 | 新形态 |
|---|---|---|
| `private currentParams` 字段 | 存活 | **删除** |
| `setToolExecutor` JSDoc 关于 `run()` 启动后的注释 | 不变 | 不变 |
| `emit(event)` 签名 | `private emit(event: AgentEventInput)` | `private emit(turnCtx: TurnContext, event: AgentEventInput)` |
| `emit` 内部 `if (!this.currentParams) return` | 静默吞 | **删除** |
| `emit` 内部 `as AgentEvent` cast | 必须 | **删除**（详见下文类型推导） |
| `run(params)` 顶部 stash-restore | `previousParams = ...; finally { ... }` | **删除**；改为局部 `const turnCtx = { sessionKey: params.sessionKey, turnId: params.turnId }` |
| `runAttempt(params, ...)` 签名 | 不变 | 加 `turnCtx: TurnContext` 参数 |
| `compactHistory(params, ...)` 签名 | 不变 | 加 `turnCtx: TurnContext` 参数 |
| `callLLMStream(params)` 签名 | 不变 | 加 `turnCtx: TurnContext` 参数 |
| `sanitizeSessionTail(sessionKey)` 签名 | 接 sessionKey | 改接 `turnCtx`（因为内部要 emit `session_tail_sanitized`） |
| `callLLMStream` 内部 `this.currentParams?.sessionKey` | 直接读 | 改读 `turnCtx.sessionKey` |
| 所有 12 个 `this.emit({...})` call sites | 不传 ctx | 全部改为 `this.emit(turnCtx, {...})` |

**emit 类型推导收尾**（消 `as AgentEvent`）：

```typescript
private emit<E extends AgentEvent>(
  turnCtx: TurnContext,
  event: Omit<E, 'sessionKey' | 'turnId'>,
): void {
  if (!this.onEvent) return;
  this.onEvent({ ...event, ...turnCtx } as E as AgentEvent);
}
```

或者用现有的 `AgentEventInput` distribution + cast — 选哪个看实际写出来哪种 TS 推断最干净，不强求消 cast；§2.6 是 nice-to-have，不是核心目标。

**call site 改动总数估计**：12 个 `this.emit` + 4 个内部方法签名 + 1 个字段删除 = 单文件 ~17 处改动；纯 mechanical（加参数 + 透传），无逻辑变化。

### 4.3 `src/core/runner/AgentRunner.test.ts`：测试调整 + 新增

- **现有 nested-run 回归测试**（commit `22fa5d9` 加的那个）：保留，依然有效，因为它测的是端到端行为。
- **新增**：直接测 emit context 注入
  ```ts
  it('emits with the turnCtx provided by the active run(), not stale state from a prior run', async () => {
    // 跑 run('A'), 拿到事件后 sessionKey 全部 = 'A'
    // 跑 run('B'), 事件 sessionKey 全部 = 'B'
    // 没有任何串号
  });
  ```
- **新增**：并发独立 run 不互相污染 emit context
  ```ts
  it('two concurrent run() calls do not pollute each other\'s emit context', async () => {
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    // 两个独立 AgentRunner 实例当然没问题，重点是同一个实例并发
    // 用 mock LLM 让两个 run 交错 await
    await Promise.all([
      runner.run({ sessionKey: 'A', ..., onEvent: e => eventsA.push(e) }),
      runner.run({ sessionKey: 'B', ..., onEvent: e => eventsB.push(e) }),
    ]);
    expect(eventsA.every(e => e.sessionKey === 'A')).toBe(true);
    expect(eventsB.every(e => e.sessionKey === 'B')).toBe(true);
  });
  ```
  > 注：当前 `AgentRunner` 把 `onEvent` 设在构造期，不接受 per-run override。如果决定**不**支持并发独立 onEvent（保持现状），这个测试可以改成"两次串行 run 之间 sessionKey 不串"。

- **删除 / 调整**：任何依赖 `currentParams` 字段名的测试（通过实例字段断言的）需要重写为通过 emit 输出断言；预计影响小，因为 currentParams 是 private，单测应该不会直接戳。

### 4.4 `src/core/subagent/SubagentRunner.ts`：受益方，不需要改

SubagentRunner 现在调 `this.deps.agentRunner.run(runParams)`。重构后 `run` 签名不变，行为正确（不再依赖 stash-restore）。**0 行改动**。

但加 1 个回归测试值得：
- `src/core/subagent/SubagentRunner.test.ts`：现有的 "preserves the parent run's emit context when a tool re-enters run()" 测试在新实现下应该**继续通过**（行为契约不变，只是底层机制变了）。如果失败，说明重构有 regression。

### 4.5 `scripts/test-subagent-e2e.ts` + `scripts/test-subagent-live.ts`：不需要改

两个 demo 都只看 `onAgentEvent` 输出，不直接戳 `currentParams`。重构后应继续通过。把它们当 e2e 验收门槛跑一次。

---

## 5. 改动文件清单

| File | 改动 | 行数估计 |
|---|---|---|
| [src/core/runner/types.ts](../../src/core/runner/types.ts) | 新增 `TurnContext` interface | +5 |
| [src/core/runner/AgentRunner.ts](../../src/core/runner/AgentRunner.ts) | 删字段 / 改 emit 签名 / 4 个内部方法加参数 / 12 处 emit call site | ~50 改动行（净增减接近 0） |
| [src/core/runner/AgentRunner.test.ts](../../src/core/runner/AgentRunner.test.ts) | 新增 2-3 个直接测 emit context 的 case | +60 |
| Former `src/core/subagent/SubagentRunner.ts`（Slice 2 deleted） | 0（受益方） | 0 |
| [src/core/subagent/SubagentRunner.test.ts](../../src/core/subagent/SubagentRunner.test.ts) | 0（现有回归 case 继续保护） | 0 |

总体：**单文件主战场 + 一个小 type 新增 + 测试加固**。

---

## 6. 验收

- [ ] `npx tsc --noEmit` 干净（除 [workflow.md](../../../../memories/repo/workflow.md) 记录的 3 个 pre-existing test 文件）
- [ ] `npx vitest run` 通过（v1 基线 593 个 → 加 2-3 → 约 595-596）
- [ ] `npx tsx scripts/test-subagent-e2e.ts`：3 / 3 通过
- [ ] `npx tsx scripts/test-subagent-live.ts`（需 LLM proxy）：两个场景都通过
- [ ] `grep -n "this.currentParams" src/core/runner/AgentRunner.ts` 返回 0 行
- [ ] `AgentRunner.ts` 顶部的 `FIXME(arch-debt, v2)` 注释块**删除**（连同 stash-restore 那段一起）
- [ ] AgentRunner 测试中加的"嵌套 run 不丢父 emit"回归 case 在新实现下**继续通过**（如果挂了说明新实现有问题）

---

## 7. 风险 / 兼容性

- **公共接口零变化**：`AgentRunner` 构造签名、`run(params)` 签名、`AgentEvent` 类型、`onEvent` callback shape 全都不变。RuntimeApp / SubagentRunner / 任何 channel adapter 都不需要改。
- **私有方法签名变更**：`runAttempt` / `compactHistory` / `callLLMStream` / `sanitizeSessionTail` 加参数。这些是 `private`，外部不可见，不算 breaking。
- **行为变化**：emit 不再静默吞事件。如果之前有某种"邪路径"依赖了"先 emit 后置 ctx → 被吞"的行为（极不可能），会暴露出来。
- **回归风险**：重构 12 个 emit call site 是 mechanical 但量大，容易在某一个 emit 漏传 ctx；TS 编译期能捕获 100% 此类遗漏（因为 ctx 是 required 参数）。

---

## 8. 实施顺序建议

1. 加 `TurnContext` 类型（独立改动，可先 commit）
2. emit 签名加 ctx + 内部方法签名加 ctx + 12 个 call site（一次大改）
3. 删字段 + 删 stash-restore + 删 `if (!this.currentParams)` + 删 FIXME 注释（最后一步）
4. 新增/补充测试
5. 跑 vitest + 2 个 E2E demo

预计单 PR 内完成，~150 行 diff（含测试）。

---

## 附录：v1 上下文丢失事故时间线

- **`commit 22fa5d9`（live demo 抓出）**：嵌套 run() 内层 finally 把 currentParams 设回 null → 父后续 emit 全废 → 临时加 stash-restore + nested-run 回归测试。
- **挂账于 `FIXME(arch-debt, v2)`**（[AgentRunner.ts:176](../../src/core/runner/AgentRunner.ts#L176)）：明确说明 v1 是补丁，v2 改为本文档描述的选项 B。

本文档即兑现 v2 承诺。
