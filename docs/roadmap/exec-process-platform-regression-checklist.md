# Exec / Process 平台回归清单

> 创建日期：2026-04-06  
> 适用项目：`C:\dev\my-agent\my-agent`

这份清单的目标是把 `exec / process` 运行时相关的核心回归固定成一组可重复执行的命令，避免每次改 platform runtime 时再靠临时记忆拼测试矩阵。

---

## 1. 什么时候跑

下面这些改动之后，至少应重跑本清单中的核心子集：

- `run-command.ts`
- `resolve-command-invocation.ts`
- `kill-process-tree.ts`
- `exec.ts`
- `process.ts`
- `process-registry.ts`

如果改动触及平台 wrapper、kill-tree、timeout、abort、yield handoff、`process.kill` 或 `process.list` 的可见性语义，建议跑完整清单。

---

## 2. 单元测试

### 2.1 核心运行时单测

```bash
npx vitest run src/tools/builtin/resolve-command-invocation.test.ts src/tools/builtin/kill-process-tree.test.ts src/tools/builtin/run-command.test.ts
```

覆盖重点：

- Windows / Unix invocation 解析
- `shell: false` 约束
- Windows close-state settle
- timeout / abort 状态映射
- Windows `taskkill` / Unix process-group kill-tree

---

## 3. 集成测试矩阵

### 3.1 `exec` 基础与平台 wrapper

```bash
npx tsx scripts/test-exec-list-cwd.ts
npx tsx scripts/test-exec-platform-shell.ts
```

覆盖重点：

- `cwd` 解析
- 平台 shell builtin 语义
- 环境变量展开

### 3.2 `exec` 三种运行模式

```bash
npx tsx scripts/test-exec-background.ts
npx tsx scripts/test-exec-yield.ts
```

覆盖重点：

- immediate background
- yield handoff
- foreground / background 结果边界

### 3.3 timeout / abort 的整棵树终止

```bash
npx tsx scripts/test-exec-timeout-tree.ts
npx tsx scripts/test-exec-abort-tree.ts
```

覆盖重点：

- timeout 复用 kill-tree
- AbortSignal 复用 kill-tree
- Linux / Windows 下 shell 拉起的父子进程树都能被收敛

### 3.4 `process.kill` 核心行为

```bash
npx tsx scripts/test-process-kill.ts
npx tsx scripts/test-process-kill-no-output.ts
npx tsx scripts/test-process-kill-after-exit.ts
npx tsx scripts/test-process-kill-race.ts
npx tsx scripts/test-process-kill-tree.ts
npx tsx scripts/test-process-kill-yield-tree.ts
```

覆盖重点：

- 常规 kill
- 无输出任务 kill
- 已结束任务幂等 kill
- fast-exit 与 kill 竞争
- 树状任务 kill
- yielded handoff 后的 kill-tree

### 3.5 `process.list` 生命周期可见性

```bash
npx tsx scripts/test-process-list-lifecycle.ts
```

覆盖重点：

- foreground / short-yield 不泄露到 list
- running / completed / aborted 仍保持可见
- yielded handoff 后进入 list

---

## 4. 推荐执行顺序

### 4.1 最小回归

适用于小改动，例如只改状态文案、只改 `process` 输出格式：

```bash
npx vitest run src/tools/builtin/run-command.test.ts
npx tsx scripts/test-process-kill.ts
npx tsx scripts/test-process-list-lifecycle.ts
```

### 4.2 平台运行时回归

适用于改 wrapper、kill-tree、timeout、abort、yield 等运行时路径：

```bash
npx vitest run src/tools/builtin/resolve-command-invocation.test.ts src/tools/builtin/kill-process-tree.test.ts src/tools/builtin/run-command.test.ts
npx tsx scripts/test-exec-platform-shell.ts
npx tsx scripts/test-exec-timeout-tree.ts
npx tsx scripts/test-exec-abort-tree.ts
npx tsx scripts/test-process-kill-tree.ts
npx tsx scripts/test-process-kill-yield-tree.ts
npx tsx scripts/test-process-list-lifecycle.ts
```

### 4.3 完整平台回归

适用于改 `exec / process` 主流程、registry、或者准备提交前做集中验收：

```bash
npx vitest run src/tools/builtin/resolve-command-invocation.test.ts src/tools/builtin/kill-process-tree.test.ts src/tools/builtin/run-command.test.ts
npx tsx scripts/test-exec-list-cwd.ts
npx tsx scripts/test-exec-platform-shell.ts
npx tsx scripts/test-exec-background.ts
npx tsx scripts/test-exec-yield.ts
npx tsx scripts/test-exec-timeout-tree.ts
npx tsx scripts/test-exec-abort-tree.ts
npx tsx scripts/test-process-kill.ts
npx tsx scripts/test-process-kill-no-output.ts
npx tsx scripts/test-process-kill-after-exit.ts
npx tsx scripts/test-process-kill-race.ts
npx tsx scripts/test-process-kill-tree.ts
npx tsx scripts/test-process-kill-yield-tree.ts
npx tsx scripts/test-process-list-lifecycle.ts
```

---

## 5. 双平台建议

如果改动涉及平台 runtime，本清单建议至少在两个环境各跑一遍：

1. Windows 主机
2. WSL Linux

原因：

- Windows 侧重点在 `cmd.exe` wrapper、`taskkill`、close-state settle
- Linux 侧重点在 process-group kill、timeout / abort 收敛、yield 后台 handoff

---

## 6. 当前仍值得补的空白

当前清单已经覆盖了大多数高风险路径，但仍有两块空白值得后续补：

1. Windows 下更贴近真实 `npm / pnpm / yarn` shim 的平台脚本测试
2. 更宿主敏感的 Unix process-group 行为脚本测试