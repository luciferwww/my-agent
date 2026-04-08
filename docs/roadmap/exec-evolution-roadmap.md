# Exec 演进路线图

> 创建日期：2026-04-05  
> 适用项目：C:\dev\my-agent\my-agent  
> 背景：这份路线图最初写于“最小可用 exec”阶段；截至 2026-04-06，代码已经具备最小版 `v2` 和 `v2.1` 核心运行时底座。本文保留为演进记录，但其中凡是提到“未来要支持 background / process”的地方，都应理解为“这些能力已经落地，后续讨论的是继续增强什么”。

> 详细运行与交互流程见 [exec-process-flow-design.md](../architecture/exec-process-flow-design.md)。

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

- `command` / `cwd` / `timeout` / `env` / `yieldMs` / `background` 参数
- foreground / yield / immediate background 三种执行模式
- `process` 工具的 `list` / `status` / `log` / `kill` 动作
- 后台 registry、可见性切换和基本生命周期管理
- `runCommand()` 的 `onStdout` / `onStderr` / `onSpawn` / `onExit` 回调入口

当前主要限制：

- 还没有引入结构化 `program + argv` 路径，因此不会吸收 OpenClaw 那套完整 Windows command shim 重写
- 非 Windows 路径还没有更完整的 shebang / wrapper resolution
- 还没有进入交互式会话控制台能力，例如 stdin write / send-keys / paste
- 文档和实现容易再次漂移

另外，从当前代码映射到这份路线图时，更准确的判断是：代码已经具备“最小版 v2”与 `v2.1` 核心运行时底座，剩余事项主要是更进一步的 resolver / shebang / 会话能力扩展。

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

这些抽象现在已经基本落地，因此本节更适合被理解为“为什么当前实现最后会演进成这样”。

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

这一阶段的主要结构性目标已经大体体现在当前代码里；保留本节是为了说明当前实现是如何从单工具逻辑演进到“工具入口 + helper + registry”结构的。

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

这一阶段也已大体落地。当前代码虽然没有完全采用文中示例的 `onUpdate` / `onSpawned` / `onYield` 命名，但已经具备等价方向的回调扩展点。

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

当前代码实际采用的是更细粒度的回调形态：`onStdout` / `onStderr` / `onSpawn` / `onExit`。现阶段不要求 agent-runner 立刻消费统一的 update 接口，只要求 helper 层保留这类扩展点即可。

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

## 7. v2.1：平台运行时底座增强

这一阶段更准确地说，应该视为 **最小版 v2 已经落地之后** 的运行时硬化阶段，而不是 `v1.x` 的后续章节。

这里的“平台运行时底座”主要指：

1. 跨平台进程树终止
2. Windows 命令解析兼容
3. Windows 退出状态兼容

详细落地建议见 [exec-process-platform-adoption-plan.md](./exec-process-platform-adoption-plan.md)，实现设计见 [exec-process-platform-runtime-design.md](../architecture/exec-process-platform-runtime-design.md)。

把它归到 `v2.x` 里的原因是：

- 现有最小版 v2 的高层能力已经够用，短期瓶颈不在 tool schema
- 真正的稳定性风险集中在 kill、timeout、abort、Windows 命令调用这些底层路径
- 当前代码已经有最小版 `background + process`，所以这一步本质上是在给 v2 做运行时硬化

这一阶段的最低目标是：

1. Windows 下支持 `taskkill /T` 与必要时的 `/F /T`
2. Linux / macOS 下优先按 process group 终止
3. 在保持 `command: string` shell 文本 API 的前提下，改用显式 shell wrapper 取代 `shell: true`
4. Windows 下补 `close` / `exitCode` settle 兼容

截至 2026-04-06，这 4 项核心底座已经落地，并补了对应的 resolver / kill-tree / Windows settle 针对测试。当前如果还要继续扩展 `v2.1`，更准确地说是在补“更完整的 resolver 能力”，而不是重新实现最小运行时底座。

完成这一步之后，再决定是否继续扩展更完整的 `background + process` 能力，结构会更顺。

---

## 8. v2.2：继续扩展后台执行与 process 工具

### 8.1 背景

当前代码已经具备最小版 v2：

- `exec` 已支持 foreground / yield / background
- `process` 已支持 `list` / `status` / `log` / `kill`
- 已有后台 registry 和真实集成验证

因此这里讨论的不是“从 0 到 1 落地 v2”，而是：在最小版 v2 已经存在的前提下，是否还要继续扩展更完整的后台与 process 能力。

合适的落地时机通常包括：

- 需要启动 dev server 并在后续轮次继续查询状态
- 需要运行持续时间明显长于普通工具调用的命令
- 需要“启动”和“查询/终止”拆开的生命周期管理

### 8.2 计划变更

如果后续继续推进 `v2.x`，更合理的方向不是继续堆更多底层兼容逻辑，而是扩展更完整的后台与 process 能力：

1. `exec`
   - 保持现有 `background` / `yieldMs` 语义
   - 视需要补充更细的返回细节与状态语义

2. `process` 工具
   - 保留现有 `list` / `status` / `log` / `kill`
   - 仅在有真实需求时再考虑 `poll` / `write` / `send-keys`

3. 进程注册表
   - 在现有 registry 基础上继续增强生命周期信息与清理能力

这里仍然不建议一开始就追 OpenClaw 的完整动作集，而应该保持“最小版 process tool 已存在，按场景增量扩展”的策略。

### 8.3 预期收益

- 长命令不会阻塞普通工具调用模型
- agent-runner 可以把“启动”和“后续观察”分开处理
- 为 dev server / watch task 这类场景提供稳定支撑

### 8.4 风险

- 进程清理、超时和异常退出处理复杂度明显上升
- 需要考虑 session 生命周期结束后的清理策略
- 需要补更多测试，不再是单个工具的局部修改

### 8.5 验收标准

- 能启动一个后台命令并拿到进程 id
- 能查询进程状态和最新输出
- 能显式终止进程
- 会话结束或测试结束时不会遗留僵尸进程

---

## 9. v3：可选的交互式会话能力

这一阶段不是默认要做的内容，但建议明确保留为后续扩展方向。

### 9.1 触发条件

只有出现下面这些明确需求时，才进入这一阶段：

- 需要和后台进程继续进行 stdin 交互
- 需要支持 REPL、CLI wizard、terminal UI 之类的持续会话
- 需要发送回车、方向键、快捷键或粘贴文本

### 9.2 可能新增的能力

- `process.write`
- `process.submit`
- `process.paste`
- `process.send-keys`
- 如有必要，再评估 PTY 支持

### 9.3 风险判断

这一阶段的复杂度不再是“扩几个 action”，而是引入从任务管理器到会话控制台的抽象升级。因此不建议提前实现，但值得在设计上预留。

---

## 10. 推荐实施顺序

如果从**当前代码状态**继续往后推进，建议按以下顺序进行，而不是再把它理解成“先到 v2、再做别的”：

1. 当前 `v2.1` 核心底座已经完成；如需继续扩展，具体剩余边界见 [exec-process-platform-adoption-plan.md](./exec-process-platform-adoption-plan.md)。
2. 再视真实需求决定是否进入 `v2.2`，继续扩展更完整的后台与 process 能力。
3. 只有在真实交互式进程需求出现后，再进入 `v3`。

这个顺序的核心原因是：当前代码已经处在最小版 `v2`，所以现在更应该先补 v2 的运行时硬化，而不是把它错写成 v1.x 末尾或另一个尚未到达的阶段。

---

## 11. 测试建议

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

### v2.1 需要补的测试

当前已补：

- kill-tree 的 Windows / Unix 分支单测
- Windows 下 close-state settle 单测
- resolver 的 Windows / Unix 单测
- `test-exec-platform-shell.ts`
- `test-exec-timeout-tree.ts`
- `test-exec-abort-tree.ts`
- `test-process-kill-tree.ts`
- `test-process-kill-no-output.ts`
- `test-process-kill-after-exit.ts`
- `test-process-kill-race.ts`
- `test-process-kill-yield-tree.ts`
- `test-process-list-lifecycle.ts`

后续仍可补：

- Windows 下更贴近真实 CLI 的 wrapper / shim 回归测试
- Linux / macOS 下更显式的 process group 平台脚本测试

完整命令矩阵见 [exec-process-platform-regression-checklist.md](./exec-process-platform-regression-checklist.md)。

### v2.2 需要新增的测试

- 如果新增 `poll`，补 `poll` 与 `status/log` 的语义边界测试
- 如果增强 registry 清理策略，补长生命周期任务和会话结束清理测试
- 如果补充更多状态元数据，补 `list/status/log` 一致性测试
- 如果引入新的后台管理语义，补 yield/background 转换后的可见性与摘要测试

### v3 需要补的测试

- 后台进程 stdin 写入
- 回车/按键事件发送
- 粘贴长文本
- 交互式会话异常中断恢复

---

## 12. 一句话结论

当前更准确的说法是：代码已经具备最小版 `v2` 和 `v2.1` 核心底座，下一步不再是“把 background 做出来”，而是视需求决定是否继续补更完整的 resolver 细节，或进入 `v2.2` 的更丰富后台会话能力。