# OpenClaw agentCommand 方法完整流程

> 分析日期：2026-04-01  
> 源文件：`src/agents/agent-command.ts`

---

## 1. 入口

```
agentCommand(opts, runtime, deps)
  │  senderIsOwner 默认 true，allowModelOverride 默认 true
  │
agentCommandFromIngress(opts, runtime, deps)
  │  senderIsOwner 必须显式传入，allowModelOverride 必须显式传入
  │
  ▼
agentCommandInternal(opts, runtime, deps)
```

---

## 2. agentCommandInternal 完整流程

```
agentCommandInternal(opts, runtime, deps)
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Phase 1：执行准备                                    │
  │  │  prepareAgentCommandExecution(opts, runtime)          │
  │  │                                                      │
  │  │  ├─ 验证消息不为空                                    │
  │  │  ├─ prependInternalEventContext()                     │
  │  │  │   └─ sub agent 完成通知注入                        │
  │  │  ├─ loadConfig() + 密钥解密                           │
  │  │  ├─ resolveSession()                                 │
  │  │  │   └─ 已有 → 复用 | 新建 → 创建                    │
  │  │  ├─ resolveSessionAgentId()                          │
  │  │  ├─ ensureAgentWorkspace()                           │
  │  │  │   └─ 首次 → 创建模板文件                           │
  │  │  ├─ 解析 ACP（高级协调平台）                          │
  │  │  └─ 返回 prepared 参数包                              │
  │  └──────────────────────────────────────────────────────┘
  │
  ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Phase 2：发送策略检查                                    │
  │                                                          │
  │  if (opts.deliver === true)                              │
  │    resolveSendPolicy() → 'deny' → 抛出错误               │
  └──────────────────────────────┬───────────────────────────┘
                                 │
                                 ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Phase 3：路径分支                                        │
  │                                                          │
  │  ACP 路径（acpResolution.kind === 'ready'）?             │
  │  ├─ YES → ACP 路径（Phase 3A）                           │
  │  └─ NO  → 标准路径（Phase 3B）                           │
  └──────────────────────────────────────────────────────────┘
```

### Phase 3A：ACP 路径

```
  ACP 路径
  │
  ├─ registerAgentRunContext()            ← 注册运行上下文
  ├─ emitAgentEvent({ phase: 'start' })  ← 生命周期：开始
  │
  ├─ resolveAcpDispatchPolicyError()     ← 策略检查
  ├─ resolveAcpAgentPolicyError()        ← Agent 策略检查
  │
  ├─ acpManager.runTurn()                ← ACP 执行
  │   └─ onEvent 回调
  │       ├─ text_delta → visibleTextAccumulator.consume()
  │       │               → emitAgentEvent({ stream: 'assistant' })
  │       └─ done → 记录 stopReason
  │
  ├─ emitAgentEvent({ phase: 'end' })    ← 生命周期：结束
  │
  ├─ persistAcpTurnTranscript()          ← 持久化会话
  │
  └─ deliverAgentCommandResult()         ← 结果回传
      └─ return
```

### Phase 3B：标准路径

```
  标准路径
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 1：思考/详细级别                                │
  │  │                                                      │
  │  │  resolvedThinkLevel =                                │
  │  │    thinkOnce ?? thinkOverride ?? persistedThinking   │
  │  │  resolvedVerboseLevel =                              │
  │  │    verboseOverride ?? persistedVerbose ?? default    │
  │  │                                                      │
  │  │  registerAgentRunContext()                            │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 2：技能快照                                     │
  │  │                                                      │
  │  │  if (新 Session 或 无快照)                             │
  │  │    buildWorkspaceSkillSnapshot()                     │
  │  │    persistSessionEntry() → 存入 Session              │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 3：持久化 /command 覆盖                         │
  │  │                                                      │
  │  │  if (有 thinkOverride 或 verboseOverride)            │
  │  │    persistSessionEntry()  → 存入 Session             │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 4：模型选择                                     │
  │  │                                                      │
  │  │  默认模型 ← resolveDefaultModelForAgent()            │
  │  │                                                      │
  │  │  if (需要模型目录)                                    │
  │  │    loadModelCatalog()                                │
  │  │    buildAllowedModelSet() → 白名单                   │
  │  │                                                      │
  │  │  应用 Session 存储的模型覆盖                           │
  │  │    ├─ 在白名单内 → 使用覆盖模型                       │
  │  │    └─ 不在白名单 → 回退到默认模型，清除覆盖            │
  │  │                                                      │
  │  │  应用运行时模型覆盖（/model 命令）                     │
  │  │    ├─ allowModelOverride === false → 抛出错误         │
  │  │    ├─ 在白名单内 → 使用覆盖模型                       │
  │  │    └─ 不在白名单 → 抛出错误                           │
  │  │                                                      │
  │  │  验证 Auth Profile 和 Provider 匹配                   │
  │  │    └─ 不匹配 → clearSessionAuthProfileOverride()     │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 5：思考级别最终解析                              │
  │  │                                                      │
  │  │  if (还未解析)                                        │
  │  │    resolveThinkingDefault()                          │
  │  │                                                      │
  │  │  if (xhigh 但模型不支持)                              │
  │  │    ├─ 用户显式指定 → 抛出错误                         │
  │  │    └─ 自动降级 → high                                │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 6：Session 文件解析                              │
  │  │                                                      │
  │  │  resolveSessionTranscriptFile()                      │
  │  │    └─ 返回 sessionFile 路径（JSONL 文件）             │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 7：执行（核心）                                 │
  │  │                                                      │
  │  │  emitAgentEvent({ phase: 'start' })                  │
  │  │                                                      │
  │  │  resolveAgentRunContext()                             │
  │  │  resolveMessageChannel()                             │
  │  │  resolveEffectiveModelFallbacks()                    │
  │  │                                                      │
  │  │  runWithModelFallback({                              │
  │  │    provider, model, runId,                           │
  │  │    run: (providerOverride, modelOverride) => {       │
  │  │      fallbackAttemptIndex++                          │
  │  │      return runAgentAttempt({                        │
  │  │        providerOverride,                             │
  │  │        modelOverride,                                │
  │  │        isFallbackRetry: index > 0,                   │
  │  │        body, cfg, sessionEntry,                      │
  │  │        sessionId, sessionKey, sessionFile,           │
  │  │        workspaceDir, resolvedThinkLevel,             │
  │  │        timeoutMs, skillsSnapshot,                    │
  │  │        ... 其他参数                                   │
  │  │      })                                              │
  │  │    }                                                 │
  │  │  })                                                  │
  │  │    │                                                 │
  │  │    ├─ 成功                                           │
  │  │    │   ├─ result = fallbackResult.result             │
  │  │    │   ├─ fallbackProvider/Model 记录                │
  │  │    │   └─ emitAgentEvent({ phase: 'end' })          │
  │  │    │                                                 │
  │  │    └─ 失败                                           │
  │  │        └─ emitAgentEvent({ phase: 'error' })        │
  │  │            throw err                                 │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 8：Session 状态更新                             │
  │  │                                                      │
  │  │  updateSessionStoreAfterAgentRun()                   │
  │  │    ├─ 使用的模型/提供商                               │
  │  │    ├─ token 使用量和成本                              │
  │  │    ├─ 压缩次数                                       │
  │  │    └─ 中止状态                                       │
  │  └──────────────────────────────────────────────────────┘
  │
  │  ┌──────────────────────────────────────────────────────┐
  │  │  Step 9：结果回传                                     │
  │  │                                                      │
  │  │  deliverAgentCommandResult()                         │
  │  │    ├─ 分发计划解析（渠道、目标、线程）                 │
  │  │    ├─ 负载格式化（消息分块）                           │
  │  │    └─ 渠道分发（调用渠道 SDK）                        │
  │  └──────────────────────────────────────────────────────┘
  │
  │  finally:
  │    clearAgentRunContext(runId)                           ← 清理运行上下文
  │
  └─ return result
```

---

## 3. 关键分支决策图

```
agentCommandInternal
  │
  ├─ ACP 就绪? ─── YES ──→ ACP 路径（直接调用 ACP runtime）
  │                           └─ 不走模型选择/fallback
  │
  └─ ACP 就绪? ─── NO ───→ 标准路径
                              │
                              ├─ 模型选择
                              │   ├─ 默认模型
                              │   ├─ + Session 存储覆盖
                              │   └─ + 运行时覆盖（/model 命令）
                              │
                              └─ runWithModelFallback
                                  └─ runAgentAttempt
                                      │
                                      ├─ CLI provider? ─── YES ──→ runCliAgent()
                                      └─ CLI provider? ─── NO ───→ runEmbeddedPiAgent()
                                                                     └─ runEmbeddedAttempt()
```

---

## 4. 生命周期事件

整个过程通过 `emitAgentEvent` 发出生命周期事件：

```
phase: 'start'     ← 开始执行
  │
  ├─ stream: 'assistant'  ← 流式文本片段（可多次）
  │
  ├─ phase: 'end'         ← 正常结束
  └─ phase: 'error'       ← 异常结束

runId 在 finally 中被清理：clearAgentRunContext(runId)
```

---

## 5. 错误处理

| 错误类型 | 处理方式 |
|---------|---------|
| 发送策略拒绝 | 直接抛出 "send blocked by session policy" |
| ACP 状态过期 | 抛出 acpResolution.error |
| ACP 执行失败 | 包装为 AcpRuntimeError，发出 error 事件 |
| 模型覆盖不允许 | 抛出 "Model override is not authorized" |
| 模型不在白名单 | 抛出 "Model override not allowed for agent" |
| xhigh 不支持 + 用户显式指定 | 抛出错误说明仅限特定模型 |
| 模型 fallback 全部失败 | 发出 error 事件，抛出原始错误 |
| 任何未捕获异常 | finally 中 clearAgentRunContext 确保清理 |
