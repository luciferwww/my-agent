# Agent Run Turn 流程改造 Spec

## 背景

当前 `AgentRunner.run()` 在入口处一次性持久化 user message,然后通过外层 retry 循环重试 `runAttempt()`。这种设计在压缩重试、preflight 失败、LLM 调用失败等场景下存在以下问题:

1. **user message 落盘点过早**:在所有 retry 之前就写入 session,无法配合 preflight 检查"先判断、后落盘"的语义
2. **retry 时无法增强 prompt**:已落盘的 user message 是固定的,为未来根据失败原因注入 steering 指令预留空间(steering 本身不在本次范围)
3. **delay-append 写法脆弱**:`runAttempt` 内部 `[...loadHistory, params.message]` 依赖"loadHistory 末尾恰好不是新 user"这个隐式约定,易出 bug
4. **失败语义不对称**:user message 已落盘但 LLM 未回复时,session 末尾留下孤立 user message,影响下一个 turn 的 role alternation

## 目标

参考 openclaw `runEmbeddedPiAgent` / `runEmbeddedAttempt` 的成熟实现,把 user message 的落盘点下沉到 `runAttempt` 内部,并在每次 `runAttempt` 开头清洗孤立的 trailing user message,从而:

- preemptive 压缩失败时不留下脏数据
- 压缩重试时不重复写入 user message
- 不破坏 SessionManager 的 append-only JSONL 约定
- 不引入新的 SessionManager API

## 范围

本 spec 仅覆盖:
- `AgentRunner.run()` 与 `AgentRunner.runAttempt()` 的 user message 持久化时机
- `runAttempt` 开头的脏历史清洗逻辑

不覆盖:
- 压缩(compaction)算法本身
- tool result 裁剪策略
- hooks 系统
- retry 上限与 backoff 策略

## 改造概览

### 落盘点迁移

**改造前**:
```
run()
  appendMessage(user) ← 一次性
  while (retry):
    runAttempt()
      loadHistory
      preflight
      [...history, user] ← delay-append(内存)
      LLM loop
```

**改造后**:
```
run()
  while (retry):
    try:
      runAttempt()
        sanitizeSessionTail ← 清洗点 #1
        loadHistory
        preflight
        appendMessage(user) + push to messages ← 落盘点下沉
        LLM loop
      break  // 成功退出重试循环
    catch ContextOverflowError:
      compactHistory()
        sanitizeSessionTail ← 清洗点 #2
        loadHistory
        compactMessages (LLM 摘要)
        appendCompactionRecord(firstKeptEntryId)
      // 进入下一轮 while 迭代
```

### 关键性质

| 性质 | 说明 |
|---|---|
| 每次 retry 都 append | 不需要 flag 协调"是否已落盘",语义统一 |
| append 在 preflight 之后 | preemptive `compact` 抛出时 user message 未落盘,下一轮 retry 干净 |
| 清洗两处都调 | runAttempt 开头 + compactHistory 开头,两处都是"即将读取/使用当前分支历史"的入口,必须保证入口处干净 |
| SessionManager 无新 API | 完全复用现有 `branch(key, entryId)` 能力 |

## 脏历史清洗:Spec 详述

### 清洗目标

丢弃 session 当前分支末尾的孤立 user message,使后续流程(append 新 user / 压缩 LLM 调用 / loadHistory 截断)拿到一个干净、一致的分支快照。

**孤立 user message 的定义**:
当前分支(`getMessages(sessionKey)` 返回的线性链)的最后一条 entry,其 `message.role === 'user'`。

**为什么会出现**:
1. 上一轮 `runAttempt` 在 LLM 调用之后才抛错(ContextOverflowError、网络错误、API 错误):user message 已 append 但 assistant 未回复
2. 上一轮 `runAttempt` 在 append user 之后到 LLM 调用之前抛错(罕见,如序列化错误)
3. 进程崩溃 / 异常退出后重启

### 为什么两处都需要清洗

调用点 #1 与 #2 面对的问题不同，不能互相替代。

#### 调用点 #1：`runAttempt` 开头

**问题**：本轮通过 preflight 后会无条件 append 新 user message。若末尾已是孤立 user，造成：
- session 出现重复用户消息
- 消息链出现连续两条 user role
- LLM API 报错（Anthropic："messages: roles must alternate"）

**清洗后效果**：新 append 的 user 挂在上一个 assistant 之后，role 不冲突。

#### 调用点 #2：`compactHistory` 开头

**问题**：压缩流程会调用 `appendCompactionRecord(firstKeptEntryId)` 写入压缩记录，`firstKeptEntryId` 是保留区第一条 entry 的 ID。

若进入压缩时末尾是孤立 user，且压缩会把这条孤立 user 划入保留区（很可能，因为是最近的消息），`firstKeptEntryId` 会指向这条孤立 user。随后：

1. compactHistory 完成，压缩记录已落盘（`firstKeptEntryId` 指向孤立 user）
2. 外层 retry 进入下一轮 `runAttempt`
3. **调用点 #1** 生效，清洗 leaf：leafId 回退，孤立 user 脱离当前分支
4. `loadHistory` 执行 `records.findIndex(r => r.id === firstKeptEntryId)`，因为孤立 user 已不在当前分支，返回 **-1**
5. 截断条件 `if (keptIndex >= 0)` 不满足，`effectiveRecords` 保持全量历史
6. 最后 LLM 收到的 messages = `[摘要] + [全量历史]`，**摘要与历史重叠**

**清洗后效果**：压缩输入不包含孤立 user，`firstKeptEntryId` 指向一个稳定且在当前分支内的 entry，后续 `loadHistory` 的截断逻辑正常生效。

#### 为什么不是"语义污染"

一个直觉担忧是：孤立 user 进入压缩会被摘要 LLM 写进摘要文本（如"用户问了 X"），造成不可逆的语义污染。

实际不会发生：my-agent 的 `splitForCompaction`（与 openclaw 的 `splitPreservedRecentTurns` 同理）会把最近 `keepRecentTurns` 个 user 轮次划入保留区，不进摘要 LLM。孤立 user 必然在保留区，**不会进入摘要文本**。

所以调用点 #2 的理由是纯技术正确性（`firstKeptEntryId` 与 leaf 指针一致性），不是语义污染。

### 清洗范围决策

**只清 trailing user,不清 trailing toolResult**。

| 末尾 role | 是否清 | 理由 |
|---|---|---|
| `user` | ✅ 清 | 上一轮 LLM 未触达或未回复,丢弃无损失 |
| `toolResult` | ❌ 不清 | 工具已执行(可能有副作用如写文件、发消息),保留 toolResult 可让下一轮 LLM 继续基于已有进度推理,避免重复 tool 调用、节省 token 与时间 |
| `assistant` | ❌ 不清 | 正常结束状态 |

**与方案"清到最近 assistant"的对比**:
该备选方案会一并清掉 trailing toolResult,实现更简单且无 role 冲突,但代价是丢失工具进度。本 spec 选择"只清 trailing user",保留 openclaw 同款的进度延续能力。

### 清洗算法

```
sanitizeSessionTail(sessionKey):
  records = sessionManager.getMessages(sessionKey)
  if records 为空: return
  last = records[最后一项]
  if last.message.role !== 'user': return
  sessionManager.branch(sessionKey, last.parentId)
```

**仅操作内存**：`branch` 仅修改内存中的 `leafId`，不写 JSONL 文件、不删除任何记录。

**幂等性**:清洗一次后末尾不再是 user(变为 assistant、toolResult 或 session 根),再调一次直接 return。

### 不清 trailing toolResult 的副作用与缓解

**副作用**:本轮 append 新 user 后,messages 末尾出现 `[..., toolResult, user(new)]`。`loadHistory` 把 toolResult 转成 user role,LLM 看到 `[..., user(=toolResult), user(=new)]`,仍会触发 role alternation 错误。

**何时会发生**:仅当上一轮在"toolResult 写入完成 → 下一次 LLM 调用开始"之间异常中断。
- 主循环正常路径:执行 tool → 写 toolResult → 立即进入下一次 LLM 调用 → 写 assistant
- 中断窗口很小,只有进程崩溃 / 主循环抛非预期错误时才会留下 trailing toolResult

**缓解策略**:
- 阶段一(本次实施):不主动清,出现时记 warn 日志,人工排查
- 阶段二(若高频发生):在清洗逻辑中扩展,识别 trailing toolResult 后采取"附加 user prompt 而非新 user"或"trailing toolResult 也清"的策略,届时另写 spec

### 边界场景

| 场景 | 行为 |
|---|---|
| session 刚 create,无 message | `getMessages` 返回空,清洗 return,无副作用 |
| 末尾就是 assistant | 清洗 return,无副作用 |
| 末尾是 toolResult | 清洗 return,不动(留 warn,见上节) |
| 末尾 user 是 session 第一条 message | `parentId` 指向 session 根节点 id(`byId` 中存在),`branch` 合法,清洗后 `getMessages` 返回空数组,等同新会话 |
| 连续两次 retry,两次都在 LLM 后失败 | 第二轮 runAttempt 开头清掉第一轮的孤立 user → preflight 后 append 第二轮 user → 仍可能失败 → 第三轮再清。每轮一对一,不累积 |
| 压缩重试进入 compactHistory 时末尾有孤立 user | compactHistory 开头清洗 → 压缩输入不含孤立 user → `firstKeptEntryId` 指向稳定 entry → 下轮 loadHistory 截断生效 |

### 文件层面的不变量

- JSONL append-only 不破坏:`branch` 仅修改内存 `leafId`,不重写文件
- 被清洗的 user message 仍保留在 JSONL 中(脱离当前分支但可审计)
- `byId` map 不变,仅 `leafId` 指针回退
- **多轮 retry 会在 JSONL 中留下多份同内容 user entry**:如失败 3 次后成功,JSONL 会有 4 条 entry 内容相同但 ID 不同的 user message(前 3 条脱离当前分支)。这是 append-only 设计的必然成本,考虑到 retry 不频繁发生(主要是压缩重试),存储增量可接受;未来若需压缩 JSONL 可走纯隐藏路径,不影响本 spec

### 与 openclaw 的对比

| 项 | openclaw | my-agent |
|---|---|---|
| 清洗调用点 | 仅 `runEmbeddedAttempt` 开头（1 处） | `runAttempt` + `compactHistory`（2 处） |
| compact 路径上为什么 openclaw 不需清洗 | 压缩仅靠保留区索引，不持久化 `firstKeptEntryId` 这种指针 | `appendCompactionRecord` 会写入 `firstKeptEntryId`，leaf 回退后会造成截断逻辑失效 |
| 保留区机制 | `splitPreservedRecentTurns`（隐式保护，孤立 user 不进摘要） | `splitForCompaction`（同理） |
| 语义污染风险 | 无（被保留区隔离） | 无（被保留区隔离） |

### 与压缩(compaction)的交互

- 调用点 #1（runAttempt）在 `loadHistory` 之前执行，`loadHistory` 内部的 `firstKeptEntryId` 截断逻辑不受影响
- 调用点 #2（compactHistory）在 `compactMessages` 之前执行，保证 `firstKeptEntryId` 不会指向一个即将被下轮清洗脱离分支的 entry
- 压缩记录(`appendCompactionRecord`)不更新 `leafId`,与清洗逻辑独立,无冲突

### 可观察性

- 清洗发生时通过 `emit` 触发新的 AgentEvent: `session_tail_sanitized`
- 字段:`discardedEntryId`, `discardedRole`(阶段一始终为 `'user'`);`sessionKey`/`turnId` 由 emit 机制自动注入
- 末尾是 trailing toolResult 的场景:不 emit 事件,但记一条 warn 日志(供后续观察频率)
- 不阻塞调用方继续执行

## API 变更

### AgentRunner

新增私有方法:
```
private sanitizeSessionTail(sessionKey: string): void
```

语义:检查当前分支末尾,若为孤立 user message 则回退 leaf 指针,若为 trailing toolResult 则仅记 warn 日志不动数据。阶段一范围如上;未来扩展(如 trailing toolResult 主动处理、tool_use/tool_result 配对修复)需单独写 spec,但名称本身足够通用,无需改名。

修改方法:
- `run()`:删除入口处的 `sessionManager.appendMessage(user)` 调用
- `runAttempt()`:
  - 开头调用 `sanitizeSessionTail`(清洗点 #1)
  - preflight 通过后调用 `sessionManager.appendMessage(user)` 落盘
  - 删除原 delay-append 行 `messages = [...messages, { role: 'user', content: params.message }]`(改为 append 后 push)
- `compactHistory()`:
  - 开头调用 `sanitizeSessionTail`(清洗点 #2)

### AgentEvent

新增变体(在 `src/core/runner/types.ts`)。`sessionKey` 与 `turnId` 由 `AgentRunner.emit()` 从 `currentParams` 自动注入(完全复用现有事件机制)，变体定义只需声明业务字段:

```
{
  type: 'session_tail_sanitized';
  sessionKey: string;       // 由 emit 注入
  turnId: string;           // 由 emit 注入
  discardedEntryId: string;
  discardedRole: 'user';    // 阶段一始终为 'user',未来若扩展 trailing toolResult 处理再放宽为 union
}
```

### SessionManager

**无变更**。完全复用现有 `getMessages` 与 `branch` API。

## 验收标准

### 单元测试

| 用例 | 期望 |
|---|---|
| session 空,调用 `sanitizeSessionTail` | 无副作用,`getLeafId` 不变 |
| session 末尾是 assistant | 无副作用,`getLeafId` 不变 |
| session 末尾是 toolResult | 无副作用,`getLeafId` 不变,记 warn 日志 |
| session 末尾是 user | `getLeafId` 回退到该 user 的 parentId,`getMessages` 末尾不再是该 user,emit `session_tail_sanitized` |
| 末尾 user 是 session 第一条 message | `getLeafId` 回退到 session 根,`getMessages` 返回空数组 |
| 连续调用两次 | 第二次无副作用（幂等），不重复 emit |

### 集成测试

| 用例 | 期望 |
|---|---|
| `run()` 触发一次 preemptive 压缩重试 | session 中只有一条 user message(本次的),无重复 |
| `run()` 触发一次 LLM API context overflow 后压缩重试 | session 中只有一条本次 user message;原 LLM 失败那条 user 已脱离当前分支(JSONL 中仍可见但 `getMessages` 不返回) |
| compactHistory 输入带孤立 trailing user | 压缩前清洗生效，`firstKeptEntryId` 不指向孤立 user；下轮 loadHistory 的 `findIndex(firstKeptEntryId)` 能命中，截断逻辑正常 |
| 模拟连续 3 次压缩重试 | session 当前分支只保留一条 user + 一条最终 assistant,无累积重复 |
| `run()` 正常完成,无重试 | 行为与改造前一致 |
| `run()` 失败但已落盘 user → 下一轮新 `run()` 调用 | 新 turn 开头清掉上一轮孤立 user,正常进行 |

### 不应破坏的现有行为

- 压缩记录的 `firstKeptEntryId` 计算正确
- 压缩摘要消息正确注入到 messages 头部
- tool result 裁剪(Layer 1 / 1.5)逻辑不变
- `getMessages` 在无清洗场景下返回与改造前完全一致的结果

### hooks 触发语义变化(需明确留意)

改造前:user-append 相关 hook(若有)在 `run()` 入口只触发一次;改造后:**每轮通过 preflight 的 retry 都会调 `appendMessage(user)`,因此 user-append hook 也会被触发多次**(与 retry 次数一致)。

需要实施前调研:
- 现有 hooks 是否在 `appendMessage` 调用处触发某些以"一轮 turn 一次"为语义的逻辑
- 若有,需明确选择:(a) 保留多次触发语义(hooks 自行去重);(b) 把该 hook 移到 "进入 run()" 或 "runAttempt 最终成功" 的位置;(c) 在 hook 负载里增加 `attemptIndex` 让下游自行判断
- **本 spec 不预设选项**。实施者在 step 2 之前检查、记录决定

## 不在本次范围

- trailing toolResult 的智能处理
- 多 user message 排队 / steering message 注入策略改造
- 压缩算法本身的优化
- 进程崩溃恢复的更强保证(如 transaction log)

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| trailing toolResult 实际发生频率高于预期,导致 role alternation 错误 | 通过 warn 日志收集线上数据;若频繁出现,启动阶段二改造 |
| `branch(parentId)` 在边界场景(parentId 指向 session 根)行为不符合预期 | 单元测试覆盖;`SessionManager.branch` 当前实现只校验 `byId.has`,session 根节点在 byId 中,合法 |
| 清洗事件干扰现有事件流消费者 | 新增事件类型为附加,现有消费者不订阅则无感知 |
| compactHistory 仅清 trailing user，未处理 trailing toolResult，可能留下其他脱离节点 | trailing toolResult 本身会被保留区机制隔离在压缩输入之外，不会进入摘要。阶段一无需额外处理 |

## 实施计划

1. 调研现有 hooks:确认 user-append 相关 hook 是否需要调整触发位置(见"hooks 触发语义变化")
2. 新增 `sanitizeSessionTail` 私有方法(纯函数,可独立单测)
3. 新增 `AgentEvent` 变体 `session_tail_sanitized`
4. 修改 `AgentRunner.run()`:删除入口 append
5. 修改 `AgentRunner.runAttempt()`:开头加清洗(调用点 #1),preflight 后 append
6. 修改 `AgentRunner.compactHistory()`:开头加清洗(调用点 #2)
7. 单元测试 + 集成测试
8. 跑现有测试套件确认无回归
