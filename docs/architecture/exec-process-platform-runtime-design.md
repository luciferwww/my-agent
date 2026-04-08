# Exec / Process v2.1 平台运行时设计

> 创建日期：2026-04-06  
> 适用项目：`C:\dev\my-agent\my-agent`  
> 上游参考：[openclaw-exec-process-platform-analysis.md](../analysis/openclaw/openclaw-exec-process-platform-analysis.md)  
> 计划位置：[exec-evolution-roadmap.md](../roadmap/exec-evolution-roadmap.md) 中的 `v2.1`
> 回归命令清单：[exec-process-platform-regression-checklist.md](../roadmap/exec-process-platform-regression-checklist.md)

> 当前状态：截至 2026-04-06，本文中的 `v2.1` 核心底座已经落地到 `src/tools/builtin/resolve-command-invocation.ts`、`kill-process-tree.ts`、`run-command.ts`、`process.ts`，并补了对应单测和集成脚本。本文保留为实现后的运行时设计基线。

---

## 1. 目标

这份设计回答 4 个问题：

1. 当前 `exec + process` 在跨平台运行时上缺什么。
2. 在不改 `exec/process` 外部接口的前提下，`v2.1` 应该怎么补。
3. Windows 和 Unix 的平台差异各自应该落在哪些 helper 里。
4. 哪些 OpenClaw 能力现在吸收，哪些暂时不吸收。

本阶段的结论：

- `v2.1` 的核心不是新增工具动作，而是补强运行时底座。
- 当前 API 仍然是 `command: string` 的 shell 命令文本，因此不能直接照搬 OpenClaw 的 `program + argv` 模型。
- `v2.1` 应优先把 Node 的隐式 `shell: true` 行为收敛成显式平台 wrapper、显式 kill-tree 和 Windows close-state settle。
- 只有在未来引入结构化 `program/args` 路径时，才需要继续吸收 OpenClaw 那套更完整的 Windows command shim 解析。

---

## 2. 当前代码约束

当前最小版 `v2` 的核心文件：

- [../../src/tools/builtin/exec.ts](../../src/tools/builtin/exec.ts)
- [../../src/tools/builtin/process.ts](../../src/tools/builtin/process.ts)
- [../../src/tools/builtin/run-command.ts](../../src/tools/builtin/run-command.ts)
- [../../src/tools/builtin/process-registry.ts](../../src/tools/builtin/process-registry.ts)
- [../../src/tools/builtin/resolve-command-invocation.ts](../../src/tools/builtin/resolve-command-invocation.ts)
- [../../src/tools/builtin/kill-process-tree.ts](../../src/tools/builtin/kill-process-tree.ts)

当前实现已经具备：

- foreground / yield / immediate background 三种执行模式
- `process.list / status / log / kill`
- background registry、可见性切换、基础生命周期回写
- `runCommand()` 的 `onStdout / onStderr / onSpawn / onExit` 回调入口
- Windows / Unix 显式 shell wrapper，而不是依赖 Node 隐式 `shell: true`
- `process.kill`、timeout、abort 复用同一套 kill-tree 终止策略
- Windows close-state settle 的补偿等待
- resolver、kill-tree、Windows settle 的单元测试，以及树状终止集成脚本

当前仍然保留的边界：

1. 还没有引入 OpenClaw 式的结构化 `program + argv` 路径，因此不会做完整的 Windows command shim 重写。
2. 非 Windows 的 shebang / wrapper resolution 仍然没有展开到 ACPX 那种完整 runtime pipeline。
3. 还没有进入 PTY / stdin write / send-keys / paste 这类会话控制台能力。

---

## 3. 非目标

本阶段不做下面这些事情：

- 不增加新的 `process` 动作
- 不引入 PTY、stdin write、send-keys、paste
- 不引入 approval、allowlist、sandbox、多宿主路由
- 不把 `command: string` 改成结构化 `program/args`
- 不复制 OpenClaw 的 supervisor、session-console、ACPX runtime 全套抽象

也就是说，`v2.1` 仍然服务于当前这套“任务管理器式 process”，而不是会话控制台模型。

---

## 4. 核心设计决策

### 4.1 保留 shell 命令文本 API

`exec` 继续接受 `command: string`，因为输入里天然可能出现管道、重定向、`&&` / `||` 和 shell 内建命令。

### 4.2 去掉隐式 `shell: true`

`shell: true` 的问题不是不能跑，而是：

- 平台差异隐藏在 Node 默认行为里
- 很难精确挂上 `windowsHide`
- 很难统一 timeout / abort / manual kill 的进程树语义
- Windows close-state 兼容无法放到明确的运行路径上

因此 `v2.1` 的做法是：

- 仍然执行 shell 命令文本
- 不再让 Node 自动选择 shell
- 由我们自己先解析出显式 invocation，再用 `shell: false` 的 `spawn(file, args, options)` 启动

### 4.3 kill、timeout、abort 统一走一套终止策略

这三种场景本质上都是“主动结束进程”，区别只在最终状态：

- manual kill -> `aborted`
- external abort -> `aborted`
- timeout -> `timed_out`

它们不应该各自走不同实现，而应该共用一个 `killProcessTree()` helper。

### 4.4 平台分支下沉到 helper

平台差异集中在两个 helper：

1. `resolve-command-invocation.ts`
2. `kill-process-tree.ts`

`exec.ts` 和 `process.ts` 只负责模式选择、动作分发、结果映射和 registry 访问。

---

## 5. 目标架构

```text
exec.ts
  -> run-command.ts
       -> resolve-command-invocation.ts
       -> kill-process-tree.ts
       -> process-registry.ts

process.ts
  -> kill-process-tree.ts
  -> process-registry.ts
```

职责边界：

- `exec.ts`：参数归一化、foreground / yield / background 分流
- `process.ts`：`list / status / log / kill` 动作分发
- `run-command.ts`：启动、输出聚合、完成态收敛、timeout / abort、Windows settle
- `resolve-command-invocation.ts`：把 shell 文本转成平台明确的 `file + args + options`
- `kill-process-tree.ts`：提供 Windows / Unix 不同的整棵任务树终止策略

---

## 6. 显式 invocation 设计

建议的数据结构：

```ts
interface ResolvedCommandInvocation {
  file: string;
  args: string[];
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    windowsHide?: boolean;
    detached?: boolean;
    signal?: AbortSignal;
    windowsVerbatimArguments?: boolean;
  };
}
```

### 6.1 Windows 路径

Windows 统一走：

```text
cmd.exe /d /s /c <command>
```

规则：

1. `file = process.env.ComSpec ?? 'cmd.exe'`
2. `args = ['/d', '/s', '/c', command]`
3. `windowsHide = true`
4. `windowsVerbatimArguments = true`
5. `shell = false`

这样可以保留当前 shell 字符串语义，同时把 wrapper 显式放到我们自己的运行路径里。

### 6.2 Unix 路径

Unix 统一走：

```text
/bin/sh -c <command>
```

规则：

1. `file = '/bin/sh'`
2. `args = ['-c', command]`
3. `shell = false`
4. 默认开启独立 process group（`detached = true`），这样 foreground / yield / background 的 timeout 和 abort 都能复用同一套 Unix kill-tree 语义；仅在未来确有特殊场景时再显式关闭

这里明确选 `/bin/sh -c` 而不是“当前用户 shell”，因为行为更可预测，也更接近工具执行 shell 命令的最小语义。

### 6.3 为什么暂时不做更完整的 shim

更完整的 `.cmd/.bat`、`npm/npx`、`pnpm/yarn` shim 处理，通常建立在调用方能明确控制 `program + argv` 的前提上。当前 `my-agent` 的输入仍然是 shell 文本，因此：

- 直接对 shell 文本做包管理器 shim 重写并不稳
- 容易和用户原本写的管道、重定向、复合命令冲突

因此 `v2.1` 的设计决策是：

- 先显式化 wrapper
- 先统一 kill-tree
- 不在这一阶段重写 shell 文本本身

---

## 7. kill-tree 设计

### 7.1 Windows

策略：

1. 先执行 `taskkill /T /PID <pid>`
2. 等一个短暂 grace period
3. 如仍存活，再升级到 `taskkill /F /T /PID <pid>`

内部执行 `taskkill` 时也应带 `windowsHide: true`。

### 7.2 Unix

策略：

1. 优先对 `-pid` 发 `SIGTERM`
2. 失败时回退到单 pid 的 `SIGTERM`
3. grace period 后仍存活，则升级到 `SIGKILL`
4. 同样优先尝试进程组，再回退到单 pid

关键前提：background / yield 路径下 child 最好以独立 process group 启动。

### 7.3 状态语义分离

kill helper 只负责“尽力结束任务树”，不负责决定最终业务状态。最终状态仍由调用方决定：

- manual kill -> `aborted`
- abort -> `aborted`
- timeout -> `timed_out`

---

## 8. Windows close-state settle

当前实现只在 Windows 上启用一个很短的 settle 窗口，目前默认值是 `100ms`。

建议逻辑：

1. `close` 触发时，如果 `code` 或 `signal` 已明确，直接结算
2. 如果两者都不明确，则在极短时间内轮询 `child.exitCode / child.signalCode`
3. 一旦获得稳定值立即结算
4. 超过窗口仍拿不到值，再按保底路径收敛

约束：

- settle 不应改变 foreground / yield / background 的高层行为
- 只影响 Windows 的完成态结算稳定性

---

## 9. 三种执行模式的语义

### 9.1 foreground

foreground 不进 registry，行为保持当前模式，只是终止策略不再只依赖 `child.kill()`。

### 9.2 yield

yield 保持当前语义：

1. 先创建 provisional record
2. 等一个较短时间窗口
3. 已完成则直接返回结果
4. 未完成则转为后台 record

### 9.3 background

background 继续在 `started` 成功后立即返回 `runId`。`v2.1` 的新增要求是：

- Unix 下尽量为后台任务建立独立 process group
- `process.kill`、timeout、abort 都能结束整棵任务树
- Windows completion 结算更稳

---

## 10. 建议的代码落点

### 10.1 新增文件

- [../../src/tools/builtin/resolve-command-invocation.ts](../../src/tools/builtin/resolve-command-invocation.ts)
- [../../src/tools/builtin/kill-process-tree.ts](../../src/tools/builtin/kill-process-tree.ts)

### 10.2 修改文件

- [../../src/tools/builtin/run-command.ts](../../src/tools/builtin/run-command.ts)
- [../../src/tools/builtin/process.ts](../../src/tools/builtin/process.ts)
- [../../src/tools/builtin/exec-types.ts](../../src/tools/builtin/exec-types.ts)

### 10.3 `run-command.ts` 的职责边界

`run-command.ts` 应保留：

- spawn orchestration
- stdout / stderr 聚合
- start / completion promise
- `onSpawn` / `onExit` 回调

`run-command.ts` 不应继续内嵌：

- 直接写 `shell: true`
- 手写平台分支 kill 细节
- 手写 `cmd.exe` / `/bin/sh` wrapper 细节

---

## 11. 测试设计

### 11.1 单元测试

当前已补：

- Windows invocation 解析测试
- Unix invocation 解析测试
- `shell` 固定为 `false` 的断言
- `AbortSignal` 取消映射到 `aborted` 的回归测试
- Windows `taskkill` 路径测试
- Unix process-group 路径测试
- grace period 后升级 force kill 的测试
- Windows close-state settle 的针对性测试

### 11.2 集成测试

保留现有：

- [../../scripts/test-exec-list-cwd.ts](../../scripts/test-exec-list-cwd.ts)
- [../../scripts/test-exec-platform-shell.ts](../../scripts/test-exec-platform-shell.ts)
- [../../scripts/test-exec-background.ts](../../scripts/test-exec-background.ts)
- [../../scripts/test-exec-yield.ts](../../scripts/test-exec-yield.ts)
- [../../scripts/test-exec-timeout-tree.ts](../../scripts/test-exec-timeout-tree.ts)
- [../../scripts/test-exec-abort-tree.ts](../../scripts/test-exec-abort-tree.ts)
- [../../scripts/test-process-kill.ts](../../scripts/test-process-kill.ts)
- [../../scripts/test-process-kill-no-output.ts](../../scripts/test-process-kill-no-output.ts)
- [../../scripts/test-process-kill-after-exit.ts](../../scripts/test-process-kill-after-exit.ts)
- [../../scripts/test-process-kill-race.ts](../../scripts/test-process-kill-race.ts)
- [../../scripts/test-process-kill-tree.ts](../../scripts/test-process-kill-tree.ts)
- [../../scripts/test-process-kill-yield-tree.ts](../../scripts/test-process-kill-yield-tree.ts)
- [../../scripts/test-process-list-lifecycle.ts](../../scripts/test-process-list-lifecycle.ts)

后续仍值得补：

1. Windows 条件下更贴近真实 npm / pnpm shim 的平台脚本测试
2. Unix 条件下专门验证 process-group kill 的宿主平台脚本测试

---

## 12. 验收口径

`v2.1` 的完成标准：

1. `process.kill` 不再直接依赖 `child.kill()` 作为唯一终止路径
2. timeout / abort / manual kill 复用同一套 kill helper
3. `runCommand()` 不再依赖 Node 的隐式 `shell: true`
4. Windows 的 foreground / yield / background 基础流程保持可用
5. 现有最小版 `v2` 测试和脚本回归不下降