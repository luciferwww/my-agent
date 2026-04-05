# Exec 演进路线图

> 创建日期：2026-04-05  
> 适用项目：C:\dev\my-agent\my-agent  
> 背景：当前 `src/tools/builtin/exec.ts` 已满足最小可用需求，但我们已经明确后续需要支持 background。这样的话，架构设计必须现在就按“前台 + 后台”统一模型考虑，而不是先做一个纯同步版再整体推翻。

> 详细运行与交互流程见：`docs/exec-process-flow-design.md`。

---

## 1. 目标

这份路线图的目标不是“复制 OpenClaw 的 exec”，而是以最小复杂度补齐我们当前实现最容易遇到的扩展点。

演进原则：

- 保持 Tools 模块的简单职责边界
- 从一开始就按 background 场景设计内部抽象
- 优先做低成本高收益的内部整理
- 把后台执行和 process 管理视为既定方向，但分阶段落地
- 不把审批、allowlist、sandbox 等平台级能力带进当前项目

这里的关键区分是：

- **设计上**，现在就要为 background 预留模型
- **实现上**，可以分阶段把前台执行、后台执行、process 管理逐步补齐

---

## 2. 当前状态

当前 `exec` 已具备：

- `command` / `cwd` / `timeout` / `env` 参数
- 使用 `spawn(..., { shell: true })` 执行命令
- 分别监听 stdout / stderr，并按时间顺序合并输出
- 超时 kill
- 通过 `ToolResult` 返回 `content + isError`

当前主要限制：

- 运行逻辑全部堆在一个工具实现里，可扩展性一般
- 成功、失败、超时、取消没有内部统一结果模型
- 没有增量输出接口
- 没有后台执行和进程句柄管理
- 当前结果结构默认假设“一次调用就结束”，这会和 background 模式天然冲突
- 文档和实现容易再次漂移

---

## 3. 非目标

以下内容不在这份路线图的近期范围内：

- 危险命令审批
- allowlist / durable approval
- Docker / sandbox / gateway / node 多宿主路由
- PTY 和交互式终端控制
- 多租户或 owner-only 权限模型

这些能力属于 OpenClaw 那种 agent 平台级基础设施，不适合当前项目直接引入。

---

## 4. 设计前提：从现在开始按 background-first 设计

在这个前提下，我们不应该继续把 `exec` 理解成“同步命令 -> 直接返回完整字符串”的单一路径，而应该把它理解成：

- 一个统一的命令启动入口
- 前台模式下，等待命令结束后返回结果
- yield continuation 模式下，先等待一小段时间，未结束再转入 `process`
- 后台模式下，立即返回运行句柄或 session id
- 后续再通过 `process` 工具读取状态、输出和终止命令

这意味着即使 v1.1 还不真正暴露 `background` 参数，内部抽象也应该先围绕这个模型整理。

### 4.1 现在就应该固定下来的抽象

建议现在就把下面几个概念固定下来：

1. **运行结果和运行句柄分离**
   - 前台执行返回完成态结果
   - 后台执行返回可追踪的运行 id

2. **需要预留第三种运行语义：yield continuation**
   - 先前台运行一小段时间
   - 未完成时平滑切到后台
   - 避免短命令和长命令都走极端模式

3. **命令运行状态是联合类型，不是布尔值**
   - `running`
   - `completed`
   - `failed`
   - `timed_out`
   - `aborted`

4. **exec 和 process 是一对能力**
   - `exec` 负责启动
   - `process` 负责后续控制和观测

5. **输出聚合和输出流是两层概念**
   - 内部可以持续接收 chunk
   - 对外可以在不同阶段决定返回最终聚合内容还是增量内容

如果这些抽象不先定下来，后面从同步版改到后台版时，确实很可能接近“重做一遍”。

---

## 5. v1.1：内部整理版

### 5.1 目标

把当前 `exec` 从“单文件内直接完成所有事情”，调整成“工具入口 + 运行 helper + 可扩展运行状态模型”的结构。对外仍然先保持前台行为，但内部不再假设所有命令都必须同步结束。

### 5.2 计划变更

建议把现有逻辑拆成两层：

1. `execTool.execute()`
   - 参数校验
   - 默认值归一化
   - 调用底层 helper
   - 将底层执行结果映射为 `ToolResult`

2. `runCommand()` helper
   - 启动子进程
   - 收集 stdout / stderr
   - 处理 timeout / abort / close / error
    - 返回统一的内部执行结果
    - 内部预留 background 所需的运行句柄扩展点

建议新增一个内部结果类型，例如：

```typescript
type CommandRunOutcome =
  | { status: 'completed'; output: string; exitCode: 0 }
  | { status: 'failed'; output: string; exitCode: number | null }
  | { status: 'timed_out'; output: string; timeoutSeconds: number }
   | { status: 'aborted'; output: string }
   | { status: 'running'; runId: string };
```

如果觉得 v1.1 里直接放 `running` 分支太早，也至少要把类型组织成可自然扩展到 `running`，而不是后续再整体改签名。

### 5.3 预期收益

- 工具层和进程运行层职责更清晰
- 失败分支更容易统一处理
- 为后续流式输出和后台执行留出稳定切入点
- 避免把“同步执行完成态”写死进整个实现结构

### 5.4 对外 API 影响

- 无新增参数
- 无破坏性变更
- `ToolResult` 结构保持不变

### 5.5 验收标准

- 现有 `exec.test.ts` 全部继续通过
- `exec.ts` 主体长度明显下降，主要只保留工具入口逻辑
- 启动失败、非零退出、超时、取消都能通过统一路径构造结果
- 内部 helper 的类型和职责划分不阻碍后续接入 `background + process`

---

## 6. v1.2：为流式输出和后台注册预留接口

### 6.1 目标

在不把 Tools 模块复杂化的前提下，同时为长命令输出、yield continuation 和后台注册逻辑预留扩展点。

### 6.2 计划变更

只在内部 helper 层引入可选回调，例如：

```typescript
interface CommandUpdate {
  stream: 'stdout' | 'stderr';
  chunk: string;
  timestamp: number;
}

interface RunCommandOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onUpdate?: (update: CommandUpdate) => void;
  onSpawned?: (handle: { pid?: number }) => void;
   onYield?: (runId: string) => void;
}
```

现阶段不要求 agent-runner 立刻消费 `onUpdate`、`onSpawned` 或 `onYield`，只要求 helper 层已经支持这类扩展点。

### 6.3 预期收益

- 后续接 Web UI、日志面板或进度推送时，不必重写 exec 主逻辑
- 保持当前同步返回模式不变，同时减少未来改动面
- 为将来把“启动后注册进程表”接进来留出明确入口
- 为将来支持 `yieldMs` 留出明确入口，避免再改主流程

### 6.4 对外 API 影响

- `Tool.execute()` 签名可暂时不变
- 如需上传递，可后续在 `ToolContext` 中增加可选 update callback，但不作为 v1.2 的硬性要求

### 6.5 验收标准

- 默认调用路径与当前行为完全一致
- 打开 `onUpdate` 时，可拿到按到达顺序推送的 stdout/stderr chunk
- 输出最终仍能稳定聚合成单个 `ToolResult.content`
- 后续如要注册后台任务，不需要推翻 `runCommand()` 的函数边界

---

## 7. v2：落地后台执行与 process 工具

### 7.1 背景

和旧版思路不同，这里不再把 background 看成“是否需要再决定”的方向，而是看成已经确认的目标能力。v2 的问题不再是“要不要做”，而是“什么时候开始把设计落成可用能力”。

合适的落地时机通常包括：

- 需要启动 dev server 并在后续轮次继续查询状态
- 需要运行持续时间明显长于普通工具调用的命令
- 需要“启动”和“查询/终止”拆开的生命周期管理

### 7.2 计划变更

v2 不建议只给 `exec` 增加一个 `background: true` 参数然后草率返回。更稳妥的方案是同时引入一组 process 能力：

1. `exec`
   - 新增 `background` 参数
   - 新增 `yieldMs` 参数
   - 前台模式继续返回普通 `ToolResult`
   - yield continuation 模式下，超出窗口后返回进程 id
   - 后台模式返回一个可追踪的进程 id

2. `process` 工具
   - `list`
   - `poll` 或 `status`
   - `log`
   - `kill`
   - 后续如有必要再加 `write` / `send-keys`

3. 进程注册表
   - 维护运行中的子进程
   - 保存启动参数、状态、最近输出、开始时间、结束时间

这里建议先做一个**最小版 process tool**，不要一开始就追 OpenClaw 的完整动作集。

### 7.3 预期收益

- 长命令不会阻塞普通工具调用模型
- agent-runner 可以把“启动”和“后续观察”分开处理
- 为 dev server / watch task 这类场景提供稳定支撑

### 7.4 风险

- 进程清理、超时和异常退出处理复杂度明显上升
- 需要考虑 session 生命周期结束后的清理策略
- 需要补更多测试，不再是单个工具的局部修改

### 7.5 验收标准

- 能启动一个后台命令并拿到进程 id
- 能查询进程状态和最新输出
- 能显式终止进程
- 会话结束或测试结束时不会遗留僵尸进程

---

## 8. v3：可选的交互式会话能力

这一阶段不是默认要做的内容，但建议明确保留为后续扩展方向。

### 8.1 触发条件

只有出现下面这些明确需求时，才进入这一阶段：

- 需要和后台进程继续进行 stdin 交互
- 需要支持 REPL、CLI wizard、terminal UI 之类的持续会话
- 需要发送回车、方向键、快捷键或粘贴文本

### 8.2 可能新增的能力

- `process.write`
- `process.submit`
- `process.paste`
- `process.send-keys`
- 如有必要，再评估 PTY 支持

### 8.3 风险判断

这一阶段的复杂度不再是“扩几个 action”，而是引入从任务管理器到会话控制台的抽象升级。因此不建议提前实现，但值得在设计上预留。

---

## 9. 推荐实施顺序

建议按以下顺序推进，而不是跨阶段并行：

1. 先完成 v1.1，把内部运行逻辑拆清楚，并按 background-first 模型组织类型。
2. 再完成 v1.2，把输出更新和后台注册扩展点留出来。
3. 然后进入 v2，落地最小版 `background + process`。
4. 只有在真实交互式进程需求出现后，再进入 v3。

这个顺序的核心原因是：background 已经是确定方向，但仍然不应该把“内部抽象准备”和“完整后台能力落地”混成一次大改。

---

## 10. 测试建议

### v1.1 需要补的测试

- 进程启动失败
- `AbortSignal` 取消
- 无 stdout 只有 stderr
- exit code 为 `null` 的分支

### v1.2 需要补的测试

- `onUpdate` 能收到 stdout chunk
- `onUpdate` 能收到 stderr chunk
- 开启 `onUpdate` 后最终聚合输出不变
- `onSpawned` 能拿到子进程句柄信息

### v2 需要补的测试

- 后台启动成功
- 后台进程状态查询
- 后台进程输出读取
- 后台进程 kill
- 测试结束后的进程清理

### v3 需要补的测试

- 后台进程 stdin 写入
- 回车/按键事件发送
- 粘贴长文本
- 交互式会话异常中断恢复

---

## 11. 一句话结论

当前更正确的方向不是先做一个纯同步版 `exec` 再回头重构，而是从现在就按 `exec + process` 的 background-first 模型设计内部结构，再分阶段把前台执行、扩展点和最小后台能力逐步落地。