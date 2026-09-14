# Extension Acquisition Readiness Spike Spec

## 1. 状态

- **状态：** Completed
- **版本：** 0.1
- **日期：** 2026-09-11
- **所有者：** 项目所有者
- **时间盒：** 1 个工作日；2 个工作日硬停止
- **关联计划：** [Extension Acquisition and Configuration Delivery Plan A0](../roadmap/extension-acquisition-delivery-plan.md)
- **关联设计：** [Extension Acquisition and Configuration Module Spec](extension-acquisition-configuration-module-spec.md)
- **工作流：** [Development Workflow](../development-workflow.md)
- **执行授权：** 2026-09-11 授权执行；项目所有者于 2026-09-14 接受 Results。

## 2. 单一问题

在不修改 production loader、supported Host 或 Runtime path 的条件下，当前 Node 22 / Windows / Ajv 环境是否足以为 Draft Spec 冻结的 Descriptor/Schema/module/path/artifact/redaction contract 提供可实施、可证伪的 readiness evidence？

## 3. 假设

可以通过 disposable temporary fixtures 证明：

1. Agent Home canonical root、direct-child candidate、symlink/junction/reparse rejection 与 lexical/real-path containment 可在 import 前判定；
2. path-to-file-URL ESM import 可从 relocated multi-file artifact 工作，且 import closure 可拒绝 artifact 外相对路径和 package lookup；
3. 当前 Ajv 可按 Draft-07、`strict/allErrors/useDefaults`、no coercion/no removal 编译并验证 scoped object，外部 `$ref` 可在 compile 前静态拒绝；
4. diagnostics 可只包含 bounded locator/reference/error category，而不包含 materialized secret、config object 或 raw Error。

## 4. 可解锁决策

支持假设时：

- Extension Acquisition Spec 可从 `Draft` 进入 `In Review`；
- A1/A2 production Contract 可以按既定边界规划；
- A3 artifact closure 可使用 Node/TypeScript 多文件 ESM 而不引入 bundler。

不解锁：Spec owner acceptance、production Delivery、Host migration、Relay deployment、C4、Marketplace 或 sandbox。

## 5. 方法与证据

- 在 repository 内创建一个 disposable `.tmp-extension-acquisition-readiness.mjs`，只写 OS temporary directory；
- 记录 Node、OS、Ajv version 和 filesystem observations；
- 创建真实 directory、file symlink 与 junction，记录 `lstat()`、`realpath()` 和 containment；权限不足则标记该 case blocked，不伪造通过；
- 创建多文件 ESM artifact，先从 build locator import，随后 relocate 到 temporary Agent Home direct child 再 import；扫描全部 JavaScript static/dynamic runtime specifier并判定 closure；
- 使用当前 Ajv 运行 defaults、unknown key、no coercion、internal `$ref` 与 external `$ref` preflight matrix；
- 构造含 sentinel secret 的失败输入，断言 retained diagnostic serialization 不包含 sentinel、raw config 或 stack；
- 结果写入独立 Results 后删除 disposable script 和全部 temporary directories。

## 6. 成功条件

- 全部支持平台能力的 case 有确定 observation 与 cleanup；
- disabled/invalid/path-escape/reparse candidate 在 import 前可拒绝；
- relocated ESM artifact 不依赖原路径；
- Ajv matrix 与 Draft contract 一致；
- secret sentinel 在 retained diagnostics 中出现次数为零；
- 不修改 `src/**`、supported Host、Runtime、package/lockfile 或 Agent Home。

## 7. 失败与停止条件

- Node/Windows 无法可靠区分 candidate reparse point 或 canonical containment；
- relocated artifact 必须依赖 repository、Host Core、package lookup 或 bundler；
- Ajv strict Draft-07 行为与 Spec 冲突且不能用局部 contract 调整解决；
- redaction 需要保留 raw Error/config；
- 需要管理员权限、网络、secret、长期进程、新 dependency 或 production seam；
- 到达 2 个工作日硬停止。

## 8. 约束与输出

- 不访问网络、credential 或 Agent Home；
- 不使用 wall-clock sleep；
- temporary cleanup failure 使 Spike 失败；
- 单一 Windows run 只证明 Windows observation；跨平台结论限于 pure path/import rules，Linux 仍由 CI/后续 platform test 验证；
- 输出 [Extension Acquisition Readiness Spike Results](extension-acquisition-readiness-spike-results.md)；
- disposable script 在 Results 写入后删除。

## 9. 执行结果

2026-09-11 在 Node.js `v22.22.2` / Windows `win32/x64` / Ajv `8.20.0` 完成全部 hypothesis matrix，未命中停止条件。项目所有者于 2026-09-14 接受证据与限制，见 [Extension Acquisition Readiness Spike Results](extension-acquisition-readiness-spike-results.md)。本 Spike 已结束；该接受只支持目标 Acquisition Spec 保持 `In Review`，不授权 production Delivery。
