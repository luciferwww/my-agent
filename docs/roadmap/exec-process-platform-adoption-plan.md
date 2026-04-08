# 给 my-agent 的 Exec / Process 落地改造建议

> 创建日期：2026-04-06  
> 适用项目：`C:\dev\my-agent\my-agent`  
> 详细依据：[openclaw-exec-process-platform-analysis.md](../analysis/openclaw/openclaw-exec-process-platform-analysis.md)

> 当前定位：这份文档定义的是当前最小版 `v2` 之后的下一步实现计划。更细的运行时实现设计见 [exec-process-platform-runtime-design.md](../architecture/exec-process-platform-runtime-design.md)。

> 更新状态：截至 2026-04-06，本文里的 P0、P1 已完成并进入代码与测试；当前真正剩余的事项主要是 P2 级别的 resolver / shebang 补强，而不是继续补最小 kill-tree 或显式 shell wrapper。

---

## 1. 结论

`my-agent` 现在的 `exec + process` 已经具备最小版 `v2` 的主体能力，但下一阶段的重点仍然应该分成两类：

1. 所有平台都要补的运行时底座。
2. Windows 需要额外处理的兼容细节。

最值得补的不是更多高层动作，而是 4 个底层能力：

1. 跨平台进程树终止，而不是只结束主进程。
2. Linux / macOS 下按进程组终止，而不是只 kill 单个 pid。
3. 保留 `command: string` shell 文本 API，但改用显式平台 shell wrapper，而不是依赖通用 `shell: true`。
4. Windows 退出状态补偿，而不是完全相信一次 `close` 事件就够了。

换句话说，下一阶段不应该扩展 `process` 的动作面，而应该先把底层运行时补强。

---

## 2. 当前实现与主要差距

当前本地实现的核心文件：

- [../../src/tools/builtin/exec.ts](../../src/tools/builtin/exec.ts)
- [../../src/tools/builtin/process.ts](../../src/tools/builtin/process.ts)
- [../../src/tools/builtin/run-command.ts](../../src/tools/builtin/run-command.ts)
- [../../src/tools/builtin/process-registry.ts](../../src/tools/builtin/process-registry.ts)

当前代码已经具备的最小版 `v2` 能力：

- 前台 / yield / 立即后台三种执行模式
- `list` / `status` / `log` / `kill` 四个 `process` 动作
- 后台 registry 和基本生命周期管理
- 真实集成脚本验证，包括 [../../scripts/test-exec-background.ts](../../scripts/test-exec-background.ts)、[../../scripts/test-exec-yield.ts](../../scripts/test-exec-yield.ts)、[../../scripts/test-process-kill.ts](../../scripts/test-process-kill.ts)

和 OpenClaw 相比，当前最明显的剩余差距不在 tool schema，而在更进一步的运行时细节：

1. 当前仍未吸收 OpenClaw 那套基于 `program + argv` 的 Windows command shim 重写。参考 [../../../openclaw/src/process/exec.ts](../../../openclaw/src/process/exec.ts) 和 [../../../openclaw/src/process/windows-command.ts](../../../openclaw/src/process/windows-command.ts)。
2. 非 Windows 路径还没有显式建模更完整的 shebang / wrapper resolution。参考 [../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../openclaw/extensions/acpx/src/runtime-internals/process.ts)。
3. 还没有进入 ACPX runtime 那种更完整的 wrapper policy / host-aware resolution。

---

## 3. 改造原则

这轮改造建议保持 3 个原则：

1. 只补底层运行时，不扩 `process` 动作面。
2. 只引入最小 helper，不搬 OpenClaw 的 supervisor、session-console、ACPX runtime 全套抽象。
3. 保持现有 `exec.ts` / `process.ts` 对外接口不变，优先做内部实现增强。

不建议这轮直接引入的内容：

- PTY / stdin 交互扩展
- approval / allowlist / sandbox
- 多宿主 / node host / gateway 路由
- OpenClaw 那套完整 wrapper policy 系统

---

## 4. 按平台看该改什么

### 4.1 所有平台都要先补的共通层

这一层应该作为下一步先做的内容，因为它决定 `process.kill` 和 timeout / abort 的语义是否稳定。

需要补的点：

1. 把“结束进程”升级成“结束整棵任务树”。
2. 把 kill 逻辑集中到单独 helper，而不是散落在 `process.ts` 和 `run-command.ts`。
3. 让 timeout、abort、manual kill 复用同一套终止策略。

### 4.2 Windows 需要重点补强的部分

Windows 仍然是这一步里最值得优先补强的平台特判区域，原因不是“只支持 Windows”，而是当前差距主要集中在这里。

需要补的点：

1. 显式的 Windows shell wrapper，而不是继续依赖 `shell: true`。
2. `windowsHide` 统一处理。
3. `close` / `exitCode` settle 补偿。
4. 为未来可能出现的结构化 `program/args` 路径预留 resolver 扩展点。

### 4.3 Linux / macOS 需要明确补上的部分

Linux 和 macOS 在这里可以先合并看作 Unix 语义，重点不是命令 shim，而是进程组和信号语义。

需要补的点：

1. kill 时优先针对 process group，而不是单 pid。
2. timeout 和 abort 也尽量沿用相同的 Unix 终止策略。
3. 后续如果发现脚本直启场景多，再考虑补 node shebang 脚本识别。

### 4.4 当前可以延后的平台能力

下面这些能力暂时不需要按平台展开：

1. node host / gateway 按远端平台构造命令
2. ACPX runtime 的完整 wrapper resolution pipeline
3. 更复杂的 shebang / wrapper / provider env policy

---

## 5. 已完成与剩余事项

### 5.1 P0：跨平台进程树 kill（已完成）

目标：

- Windows 下 kill 走 `taskkill /T`，必要时再 `/F /T`
- Linux / macOS 下优先按进程组发送 `SIGTERM` / `SIGKILL`
- `process.kill` 不再只是“尽量 kill 当前 child”，而是明确地终止整棵后台任务树

当前落点：

- 新增 `src/tools/builtin/kill-process-tree.ts`
- 在 [../../src/tools/builtin/process.ts](../../src/tools/builtin/process.ts) 的 `kill` 路径里改用它
- 在 [../../src/tools/builtin/run-command.ts](../../src/tools/builtin/run-command.ts) 里复用同一 helper 处理 timeout / abort 路径

参考实现：

- [../../../openclaw/src/process/kill-tree.ts](../../../openclaw/src/process/kill-tree.ts)
- [../../../openclaw/src/agents/bash-tools.process.ts](../../../openclaw/src/agents/bash-tools.process.ts)

验收结果：

1. `process.kill` 在 Windows 上能结束子孙进程，而不是只结束父进程。
2. Linux / macOS 下 kill 优先按 process group 生效，而不是只打到父进程。
3. [../../scripts/test-process-kill.ts](../../scripts/test-process-kill.ts) 继续通过。
4. 已补一个树状终止的集成测试。

### 5.2 P1：显式平台 shell invocation（已完成）

目标：

- Windows 下显式走 `cmd.exe /d /s /c`
- Unix 下显式走 `/bin/sh -c`
- 不再继续依赖 Node 的 `shell: true`
- Windows 路径统一设置 `windowsHide`

当前落点：

- 在 [../../src/tools/builtin/run-command.ts](../../src/tools/builtin/run-command.ts) 前面引入 invocation resolver
- 新增 `src/tools/builtin/resolve-command-invocation.ts`

参考实现：

- [../../../openclaw/src/process/exec.ts](../../../openclaw/src/process/exec.ts)
- [../../../openclaw/src/process/windows-command.ts](../../../openclaw/src/process/windows-command.ts)

说明：

- OpenClaw 的 `.cmd/.bat`、`npm/npx`、`pnpm/yarn` shim 解析，建立在它能控制 `program + argv` 的前提上。
- 当前 `my-agent` 仍然是 shell 文本 API，因此 `v2.1` 的最小实现不强求直接复制那套 shim 解析，而是先把 Node 隐式 shell 切成显式 wrapper。
- 如果未来引入结构化 `program/args` 路径，再把这些 shim 策略接进 resolver 会更稳。

验收结果：

1. `runCommand()` 不再依赖 `shell: true`。
2. Windows / Unix 都通过显式 wrapper 保持当前 shell 文本语义。
3. [../../scripts/test-exec-list-cwd.ts](../../scripts/test-exec-list-cwd.ts) 和 [../../scripts/test-exec-background.ts](../../scripts/test-exec-background.ts) 继续通过。
4. Windows 条件下已补 wrapper 回归测试。

### 5.3 P1：Windows 退出状态 settle 兼容（已完成）

目标：

- 避免 Windows 下 `close` 先触发，但 `exitCode` 还没稳定时把结果判错
- 给 `run-command.ts` 增加一层很短的补偿等待

当前落点：

- [../../src/tools/builtin/run-command.ts](../../src/tools/builtin/run-command.ts)

参考实现：

- [../../../openclaw/src/process/exec.ts](../../../openclaw/src/process/exec.ts) 中的 Windows close-state settle 逻辑

验收结果：

1. Windows 下短命令退出码更稳定。
2. 没有引入非 Windows 上的额外等待回归。
3. 对已有 exec 单测行为无破坏。

### 5.4 P2：再考虑非 Windows shebang 和更完整 resolver

这部分有价值，但不是当前最紧急。

目标：

- 非 Windows 下识别 node shebang 脚本
- 如后续 Windows wrapper 分支继续变多，再把 resolver 做成独立模块

参考实现：

- [../../../openclaw/extensions/acpx/src/runtime-internals/process.ts](../../../openclaw/extensions/acpx/src/runtime-internals/process.ts)

这一步适合在 P0 / P1 都稳定以后再做，不建议一开始就追求 ACPX 那种完整 resolution pipeline。

---

## 6. 推荐的最小代码组织方式

为了不把复杂度重新塞回一个文件里，建议把运行时增强拆成 3 个 helper：

1. `run-command.ts`  
作用：统一 stdout / stderr、timeout、完成态聚合。

2. `kill-process-tree.ts`  
作用：封装 Windows / Linux / macOS 不同 kill 策略。

3. `resolve-command-invocation.ts`  
作用：封装 Windows / Unix 的显式 shell wrapper、`windowsHide`，并为未来更细的 command shim 扩展预留落点。

这样改的好处是：

- [../../src/tools/builtin/exec.ts](../../src/tools/builtin/exec.ts) 继续只做模式选择和结果映射
- [../../src/tools/builtin/process.ts](../../src/tools/builtin/process.ts) 继续只做动作分发和 registry 访问
- 平台分支集中在 helper 里，后续测试也更容易单独补

---

## 7. 测试建议

这轮改造后，建议测试分三层：

### 7.1 单测

- 给 invocation resolver 补 Windows 条件分支测试
- 给 kill-tree helper 补 Windows / Unix 分支测试
- 保持 [../../src/tools/builtin/exec.test.ts](../../src/tools/builtin/exec.test.ts)、[../../src/tools/builtin/process.test.ts](../../src/tools/builtin/process.test.ts)、[../../src/tools/builtin/run-command.test.ts](../../src/tools/builtin/run-command.test.ts) 继续通过

### 7.2 集成脚本

- 继续保留：
  - [../../scripts/test-exec-list-cwd.ts](../../scripts/test-exec-list-cwd.ts)
  - [../../scripts/test-exec-platform-shell.ts](../../scripts/test-exec-platform-shell.ts)
  - [../../scripts/test-exec-background.ts](../../scripts/test-exec-background.ts)
  - [../../scripts/test-exec-yield.ts](../../scripts/test-exec-yield.ts)
  - [../../scripts/test-exec-timeout-tree.ts](../../scripts/test-exec-timeout-tree.ts)
  - [../../scripts/test-exec-abort-tree.ts](../../scripts/test-exec-abort-tree.ts)
  - [../../scripts/test-process-kill.ts](../../scripts/test-process-kill.ts)
  - [../../scripts/test-process-kill-tree.ts](../../scripts/test-process-kill-tree.ts)

- 当前已新增：
  - shell wrapper 语义脚本
  - timeout tree-kill 脚本
  - abort tree-kill 脚本
  - 一个树状 kill 脚本
  - process.kill 无输出路径脚本
  - process.kill 已结束任务幂等脚本
  - process.kill fast-exit race 脚本
  - process.kill yielded tree 脚本
  - process.list 生命周期可见性脚本

- 后续仍建议新增：
  - 一个更贴近真实 CLI 包管理器 shim 的 Windows wrapper 回归测试

### 7.3 平台覆盖建议

如果后续要把这套能力做稳，建议至少形成下面的验证矩阵：

1. Windows：重点验证 command shim、kill-tree、close-state settle。
2. Linux：重点验证 process group kill 和 timeout / abort 终止路径。
3. macOS：重点验证 process group kill，不要求一开始就做单独 shim 逻辑。

### 7.4 回归重点

重点盯这几个回归点：

1. 后台任务 kill 后状态仍然能稳定保留为 `aborted`
2. kill 后历史日志仍然可读
3. 前台短命令不会因为新增 resolver 而变慢或变脆弱
4. 非 Windows 路径不要被 Windows 特判污染