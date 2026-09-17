# Extension 独立包与统一模块加载验证

> 状态：已验证
> 日期：2026-09-17
> 所有者：项目所有者
> 契约：[Extension 独立包与统一模块加载设计](specification.md)
> 决策：[ADR-014](../../../decisions/adr-014-extension-packages-and-runtime-composition.md)

## 1. 验证结论

Extension 已迁移为根级 npm workspace packages；Host 侧支持归并到 `src/extension/{api,acquisition}`；外部导入名 `my-agent/extension-api` 保持不变。源码与已安装 package 均通过同一 Jiti Loader 加载，Runtime Unit staging、发布、retirement 与 shutdown 语义未改变。

项目所有者于 2026-09-17 完成实际运行验证：新 Session 中发送 `hello` 可正常响应，且修正 Agent Context 模板后不再因启动指令重复调用 `read_file`。

2026-09-17 重新打开本 Change，追加共享 Extension Acquisition、Runtime startup warning 与已发布 Channel failure 日志；附加工作已完成最终验证。

直接在 Standalone Host 输出日志或调用 Acquisition 的原型均已撤回：它们会使各 Host 复制相同加载知识。最终实现由 Runtime Bootstrap 从通用 `startupContext` 派生 Acquisition 参数，并由 `src/extension/acquisition` 统一记录开始、包含已加载 ID/count 的完成汇总和失败 warning；Host 源码不再出现 Extension Acquisition 参数。focused typecheck 与受影响测试 150/150 已通过。实际输出确认 Acquisition 位于 `bootstrap start` 与 `bootstrap complete` 之间，正常路径只有开始与完成汇总两条；Registry startup warning 由 `RuntimeBuilder` Logger 统一输出，不再经过 Host `stderr`。

后续收敛将已发布 Channel 的 completion failure 统一交给 `RuntimeCompositionManager` Logger，仅记录受控 `channelId` 与 `phase`。Standalone Host 继续拥有 controlling Channel 的退出状态与 shutdown 策略，但不再输出重复 failure warning，也不再仅为日志观察 secondary CLI completion。Runtime 将 rejected completion Promise 归一化为结构化 `failed/runtime`，避免原始 rejection 到达进程入口；启动期仍使用原始 Promise 保持 readiness/handoff 判定时序。最新相关 Channel lifecycle、Runtime Composition、Runtime Builder、RuntimeApp 与 Standalone Host focused tests 140/140 通过。

## 2. 交付证据

| 边界 | 证据 | 结果 |
|---|---|---|
| 入口格式 | Loader 测试覆盖 TypeScript 与构建后 JavaScript 入口 | 通过 |
| Package 依赖 | Loader 测试覆盖 Extension 自身声明的 package-local dependency | 通过 |
| 公共 API | Relay 只导入 `my-agent/extension-api`；隔离 consumer 可解析已安装声明闭包 | 通过 |
| 路径与诊断 | containment、reparse point、重复 ID、配置、导出与 Unit 验证 | 通过 |
| Runtime 生命周期 | Acquisition-to-Runtime integration 保持未创建 Unit handoff 和唯一 composition 路径 | 通过 |
| npm 发布 | 安装包包含官方 Relay package，Jiti 可加载其 TypeScript 入口，运行不修改安装树 | 通过，315 files |
| Host build | clean build 与静态 closure audit | 通过，304 files |
| 文档权威 | ADR-014、Current Architecture、稳定 Specification 与链接治理 | 通过 |
| 实际运行 | workspace Relay 启动与 `hello` 交互 | 通过 |
| Bootstrap 加载可观测性 | Runtime Bootstrap 编排、Acquisition 记录日志、无具体 Host 复制 | focused 与实际顺序通过 |
| Runtime warning 可观测性 | Runtime Logger 记录有界 startup diagnostic，同时保留 observer event | focused 与实际输出通过 |
| 独立审查 | 最终只读 implementation review | 无未解决 Critical、High、Medium 或 Low 问题 |

## 3. 最终 Gate

| 命令或检查 | 结果 |
|---|---|
| `npm test` | 通过，95 files / 1,034 tests |
| `npm run test:integration` | 通过，6 files / 18 tests |
| `npm run test:fitness` | 通过，12 files / 38 tests |
| `npm run lint` | 通过 |
| `npm run build` | 通过；Host audit 304 files；Relay 44/44 |
| `npm run verify:package` | 通过，315 files |
| `git diff --check` | 通过，无输出 |
| 最终独立审查 | 通过；review 意见均经事实核实、修复或拒绝，无未解决问题 |

## 4. 归档与删除

ADR-014 已接管 Extension package、公共 API、统一 Loader 与 Runtime Unit lifecycle 决策。原 ADR-005、旧 Extension Acquisition delivery plan，以及旧 source-layout plan/specification 已在有效入站链接清零后删除。AF-06 继续作为 Runtime staging 与生命周期历史证据。

后续 Marketplace、远程安装、签名、热加载和通用依赖注入仍不在本 Change 范围内。

流程依据：[Development Workflow](../../../governance/development-workflow.md)。