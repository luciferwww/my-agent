# OpenClaw Exec / Process 平台差异分析

> 分析日期：2026-04-06  
> 参考项目：`C:\dev\my-agent\openclaw`  
> 目标：整理 OpenClaw 在 `exec / process` 相关实现中，针对不同平台做了哪些特殊处理，并标出对应源码入口。

---

## 1. 先说结论

OpenClaw 对平台差异的处理，主要集中在 3 层：

1. `exec` 启动层：重点解决 Windows 的命令解析、`.cmd/.bat` 包装、`npm/npx` 兼容、退出码稳定性。
2. `process` 生命周期层：重点解决不同平台下的“整棵进程树终止”问题。
3. runtime helper / host 适配层：把 Windows wrapper 解析、非 Windows shebang 脚本处理、按远端节点平台构造命令这些差异收敛到底层。

如果只看高层工具接口，`exec` 和 `process` 的平台差异并不显眼；真正关键的分支基本都在底层 helper 里。

---

## 2. 分析范围

本次整理重点覆盖这些文件：

- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts)
- [../../../../openclaw/src/process/windows-command.ts](../../../../openclaw/src/process/windows-command.ts)
- [../../../../openclaw/src/process/kill-tree.ts](../../../../openclaw/src/process/kill-tree.ts)
- [../../../../openclaw/src/agents/bash-tools.process.ts](../../../../openclaw/src/agents/bash-tools.process.ts)
- [../../../../openclaw/src/agents/bash-tools.exec.ts](../../../../openclaw/src/agents/bash-tools.exec.ts)
- [../../../../openclaw/src/agents/bash-tools.exec-host-node.ts](../../../../openclaw/src/agents/bash-tools.exec-host-node.ts)
- [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts)

---

## 3. 总体分层

可以把 OpenClaw 的平台处理理解成下面这张分层图：

```text
exec/process 高层工具
  -> process session / registry / supervisor 协调
  -> process/exec 启动与 kill helper
  -> ACPX runtime spawn resolver / node host shell builder
  -> Windows / Unix / node-host platform behavior
```

其中：

- 高层工具负责暴露统一能力。
- 平台差异尽量下沉到 `src/process/*` 和 runtime helper。
- `node host` 路径还会额外考虑“远端节点的平台”，而不只是当前本机平台。

---

## 4. Windows 在 `exec` 路径上的特殊处理

### 4.1 `.cmd` / `.bat` 不能按普通二进制直接跑

OpenClaw 会先判断当前平台是不是 Windows，再判断目标命令是否为 `.cmd` 或 `.bat`。如果是，就不直接 `spawn(command, argv)`，而是改成通过 `cmd.exe /d /s /c ...` 包装执行。

对应源码：

- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `isWindowsBatchCommand()`
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `resolveChildProcessInvocation()`

### 4.2 `cmd.exe` wrapper 路径带参数安全限制

当 OpenClaw 必须走 `cmd.exe /c` 路径时，它不会无条件把参数直接拼接成命令行，而是先检查危险字符，例如 `&`、`|`、`<`、`>`、`^`、`%` 和换行。如果检测到这类字符，就直接报错。

对应源码：

- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `WINDOWS_UNSAFE_CMD_CHARS_RE`
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `escapeForCmdExe()`
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `buildCmdExeCommandLine()`

### 4.3 对 `npm` / `npx` 有单独兼容逻辑

OpenClaw 明确处理 Windows 下 `npm` / `npx` 的特殊情况。它优先尝试把调用改写成：

```text
node.exe npm-cli.js ...
node.exe npx-cli.js ...
```

只有在找不到对应 cli 脚本时，才退回 `npm.cmd` / `npx.cmd`。

对应源码：

- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `resolveNpmArgvForWindows()`

### 4.4 `pnpm` / `yarn` 会自动补 `.cmd`

对于 `pnpm`、`yarn` 这类常见命令，OpenClaw 会在 Windows 下自动补成 `.cmd`。

对应源码：

- [../../../../openclaw/src/process/windows-command.ts](../../../../openclaw/src/process/windows-command.ts)
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `resolveCommand()`

### 4.5 Windows 上统一设置 `windowsHide`

无论是 `execFile` 还是 `spawn` 路径，底层 invocation 都会带 `windowsHide`，避免执行命令时弹出额外控制台窗口。

对应源码：

- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `resolveChildProcessInvocation()`
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `runExec()`
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `runCommandWithTimeout()`

### 4.6 Windows 的 `close` / `exit` 状态同步有额外补偿

OpenClaw 发现 Windows 下有一种情况：`close` 事件先到了，但 `exitCode` / `signalCode` 还没有稳定落到 child 上。为避免误判退出状态，它会在一个很短的时间窗口内继续轮询，等待 exit state settle。

对应源码：

- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS`
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中 `child.on("close", ...)` 后的补偿逻辑
- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `resolveProcessExitCode()`

---

## 5. Unix / 非 Windows 在 `exec` 路径上的特殊处理

### 5.1 非 Windows 会识别 node shebang 脚本

在 ACPX runtime helper 里，OpenClaw 对非 Windows 平台做了一条单独分支：如果目标命令其实是一个带 node shebang 的脚本，就会把它改写成 `node script.js ...` 的形式启动。

对应源码：

- [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts) 中的 `resolveNodeShebangScriptPath()`
- [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts) 中 `runtime.platform !== "win32"` 分支

### 5.2 默认不依赖 `shell: true`

OpenClaw 在底层 `exec` helper 里明确把 `shell` 关闭，注释里直接写了这是安全决策，尤其是为了避免 Windows 上 `cmd.exe` 把 argv 重新解释成注入入口。

对应源码：

- [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts) 中的 `shouldSpawnWithShell()`

---

## 6. Windows 在 `process` 终止路径上的特殊处理

### 6.1 `process.kill` 最终会落到整棵进程树终止

高层 `process` 工具本身不直接写很多平台判断，但在 kill 路径上它会先尝试 supervisor 管理取消；如果当前 session 不在 supervisor 里，就回退到基于 pid 的树状终止。

对应源码：

- [../../../../openclaw/src/agents/bash-tools.process.ts](../../../../openclaw/src/agents/bash-tools.process.ts) 中的 `cancelManagedSession()`
- [../../../../openclaw/src/agents/bash-tools.process.ts](../../../../openclaw/src/agents/bash-tools.process.ts) 中的 `terminateSessionFallback()`
- [../../../../openclaw/src/agents/bash-tools.process.ts](../../../../openclaw/src/agents/bash-tools.process.ts) 中 `case "kill"`

### 6.2 Windows 用 `taskkill /T`，必要时再 `/F /T`

这是 OpenClaw 最明确的 Windows 专属逻辑。

对应源码：

- [../../../../openclaw/src/process/kill-tree.ts](../../../../openclaw/src/process/kill-tree.ts)

具体策略：

1. 先执行 `taskkill /T /PID <pid>`，尝试优雅地把整个进程树都停掉。
2. 等一个 grace period。
3. 如果 pid 还活着，再执行 `taskkill /F /T /PID <pid>` 强杀。

### 6.3 Windows 的 kill helper 也带 `windowsHide`

OpenClaw 在内部启动 `taskkill` 时，也同样带 `windowsHide: true`。

对应源码：

- [../../../../openclaw/src/process/kill-tree.ts](../../../../openclaw/src/process/kill-tree.ts) 中的 `runTaskkill()`

---

## 7. Unix 在 `process` 终止路径上的特殊处理

在非 Windows 平台，OpenClaw 会优先对 `-pid` 发信号，也就是优先杀进程组，而不是直接杀单个 pid。

对应源码：

- [../../../../openclaw/src/process/kill-tree.ts](../../../../openclaw/src/process/kill-tree.ts) 中的 `killProcessTreeUnix()`

具体顺序：

1. 先对进程组发 `SIGTERM`
2. 如果进程组不存在或权限不够，再退回对单 pid 发 `SIGTERM`
3. grace period 后，如果还活着，再尝试对进程组发 `SIGKILL`
4. 最后再退回对单 pid 发 `SIGKILL`

---

## 8. Runtime helper 对平台差异的进一步封装

### 8.1 Windows wrapper 解析被抽象成单独流程

ACPX runtime 不是直接在调用点写一堆 `if (win32)`，而是把 Windows 命令选择过程拆成：

1. `resolveWindowsSpawnProgramCandidate()`
2. `applyWindowsSpawnProgramPolicy()`
3. `materializeWindowsSpawnProgram()`

然后再产出最终的 `command + argv + shell + windowsHide`。

对应源码入口：

- [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts) 中的 `resolveSpawnCommand()`

### 8.2 `strictWindowsCmdWrapper` 控制 shell fallback

runtime helper 里有 `strictWindowsCmdWrapper` 这个开关，它会影响 policy 层是否允许 shell fallback。

对应源码：

- [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts) 中的 `SpawnCommandOptions`
- [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts) 中 `allowShellFallback: !strictWindowsCmdWrapper`

### 8.3 abort 走 `SIGTERM -> SIGKILL` 递进式终止

runtime helper 的 abort 逻辑是：先 `SIGTERM`，延迟一小段时间，如果进程还没退出，再 `SIGKILL`。

对应源码：

- [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts) 中 `spawnAndCollect()` 的 `onAbort`

---

## 9. 高层 `exec` 的额外平台处理

### 9.1 Windows 路径分词要保留反斜杠

在高层 `bash-tools.exec.ts` 里，OpenClaw 为命令预分析单独加了一条 Windows tokenizer 分支。如果检测到命令字符串里含有典型 Windows 路径，它会改用一个保留反斜杠的拆分器，而不是直接用通用 shell 分词。

对应源码：

- [../../../../openclaw/src/agents/bash-tools.exec.ts](../../../../openclaw/src/agents/bash-tools.exec.ts) 中的 `splitShellArgsPreservingBackslashes()`
- [../../../../openclaw/src/agents/bash-tools.exec.ts](../../../../openclaw/src/agents/bash-tools.exec.ts) 中的 `shouldUseWindowsPathTokenizer`

### 9.2 Node host 看的是远端节点平台

当 exec 走 node host 路径时，OpenClaw 不是只看当前本机平台，而是调用 `buildNodeShellCommand(command, nodeInfo?.platform)`，按远端节点平台来构造最终命令。

对应源码：

- [../../../../openclaw/src/agents/bash-tools.exec-host-node.ts](../../../../openclaw/src/agents/bash-tools.exec-host-node.ts)

---

## 10. 平台差异汇总表

| 层次 | Windows 特殊处理 | Unix / 非 Windows 特殊处理 | 关键源码 |
|------|------------------|----------------------------|----------|
| `exec` 启动 | `.cmd/.bat` 走 `cmd.exe`，`npm/npx` 改写，`pnpm/yarn` 补 `.cmd`，`windowsHide`，退出码 settle 补偿 | node shebang 脚本改写为 `node script.js` | [../../../../openclaw/src/process/exec.ts](../../../../openclaw/src/process/exec.ts), [../../../../openclaw/src/process/windows-command.ts](../../../../openclaw/src/process/windows-command.ts), [../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../../openclaw/extensions/acpx/src/runtime-internals/process.ts) |
| `process` kill | `taskkill /T`，必要时 `/F /T`，覆盖整棵树 | 优先对进程组发 `SIGTERM` / `SIGKILL` | [../../../../openclaw/src/process/kill-tree.ts](../../../../openclaw/src/process/kill-tree.ts) |
| 高层命令解析 | Windows 路径保留反斜杠分词 | 通用 shell 分词 | [../../../../openclaw/src/agents/bash-tools.exec.ts](../../../../openclaw/src/agents/bash-tools.exec.ts) |
| host 路由 | 可按远端 Windows 节点构造命令 | 可按远端 Unix 节点构造命令 | [../../../../openclaw/src/agents/bash-tools.exec-host-node.ts](../../../../openclaw/src/agents/bash-tools.exec-host-node.ts) |

---

## 11. 对我们自己实现的启发

### 11.1 最值得优先吸收的部分

1. Windows 进程树 kill，而不是只 kill 主进程。
2. Windows 下 `.cmd/.bat`、`npm/npx`、`pnpm/yarn` 的显式命令解析。
3. Windows 退出码 / close 事件的兼容补偿。

### 11.2 可以后续再考虑的部分

1. 更完整的 Windows spawn program resolution 抽象。
2. 按远端 host 平台构造 shell 命令。
3. 非 Windows node shebang 脚本改写。

### 11.3 当前不必机械照搬的部分

1. supervisor / session-console 的完整管理模型。
2. ACPX runtime 的整套 provider / wrapper policy。
3. 多宿主、多节点路由和审批体系。