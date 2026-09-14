# Extension Acquisition Readiness Spike Results

## 1. 记录

- **Spike 状态：** Completed（Results accepted 2026-09-14）
- **执行日期：** 2026-09-11
- **所有者：** 项目所有者
- **执行环境：** Windows `win32/x64`；Node.js `v22.22.2`；Ajv `8.20.0`
- **关联 Spec：** [Extension Acquisition Readiness Spike Spec](extension-acquisition-readiness-spike-spec.md)
- **关联计划：** [Extension Acquisition and Configuration Delivery Plan A0](../roadmap/extension-acquisition-delivery-plan.md)
- **目标设计：** [Extension Acquisition and Configuration Module Spec](extension-acquisition-configuration-module-spec.md)

本 Spike 使用 disposable repository script 和 OS temporary directories 验证 bounded A0 readiness assumptions；未修改 production loader、supported Host、Runtime、package/lockfile、Agent Home 或 credential。实验完成后 disposable script 与全部 temporary directories 已删除。

项目所有者于 2026-09-14 接受本 Results、evidence boundary 和 remaining limitations。

结论仅支持 Draft Spec 进入 `In Review`，不表示 Spec `Accepted`、production Delivery 完成、Relay artifact 已生成或跨平台 filesystem 已全部验证。

## 2. 方法

Disposable script 执行以下矩阵：

1. 创建 temporary Agent Home、direct candidate 和 root 外目录；
2. 取得 canonical real paths，以 `path.relative()` + absolute/parent rejection 判定 containment；
3. 创建 file symlink、directory symlink、junction 和 entry-file symlink，使用 `lstat()` 在 import 前识别，并用 `realpath()` 证明 canonical target 越界；
4. 创建 Agent Home junction alias，证明 alias 可解析到同一 canonical root；
5. 创建三文件多文件 ESM artifact，先从 build locator import，再整体 relocate 到 Agent Home direct child 后重新 import；
6. 扫描 static、side-effect、dynamic runtime imports，拒绝 package/absolute/escape specifier；
7. 以当前 Ajv 运行 Draft-07 strict/default/no-coercion/no-removal/internal-ref matrix；
8. 构造包含 secret sentinel、raw config 和 raw Error 的 failure input，只保留 bounded allowlisted diagnostic；
9. 在 `finally` 递归删除 temporary root，cleanup failure 会使命令失败。

执行命令：`node .tmp-extension-acquisition-readiness.mjs`。最终 exit code 为 0。

## 3. Evidence matrix

### 3.1 Filesystem and containment

| Case | Observation | Disposition |
|---|---|---|
| direct candidate canonical path | contained = `true` | Supported |
| outside canonical path | contained = `false` | Supported |
| Agent Home junction alias | canonicalizes to configured root = `true` | Supported |
| file symlink to outside | created；`lstat().isSymbolicLink() = true`；contained = `false` | Supported |
| directory symlink to outside | created；`lstat().isSymbolicLink() = true`；contained = `false` | Supported |
| junction to outside | created；`lstat().isSymbolicLink() = true`；contained = `false` | Supported |
| candidate entry-file symlink to outside | created；`lstat().isSymbolicLink() = true`；contained = `false` | Supported |

Windows 当前环境不需要 elevation 即完成全部 link/reparse observations。Production Contract 仍需保留真实 tests，不能只依赖本 Results。

### 3.2 ESM relocation and closure

| Case | Observation | Disposition |
|---|---|---|
| initial multi-file ESM import | `createExtension()` marker loaded | Supported |
| whole-directory relocate then import | marker loaded from new file URL | Supported |
| runtime import closure | 3 files；0 package/absolute/escape violation | Supported |
| current Relay emitted production import shape | `unit -> provider/model-metadata/responses-client`；provider -> responses-client；其余无 production runtime import；未作为真实 artifact relocate/execute | Feasible input for A3 |

Synthetic artifact 只证明 Node ESM relocation mechanism。真实 Relay Descriptor、entry、allowlist、repository independence 和 invocation 必须由 A3 Contract/Integration tests 验收。

### 3.3 Ajv Draft-07

| Contract | Observation | Disposition |
|---|---|---|
| `strict: true` + `allErrors: true` compile | passed | Supported |
| internal `#/definitions/...` `$ref` | preflight accepted and compile/validation passed | Supported |
| external HTTP `$ref` | preflight rejected | Supported |
| `useDefaults: true` on isolated object | integer default `2` applied | Supported |
| unknown key with `additionalProperties: false` | rejected；key retained | Supported |
| `removeAdditional: false` | unknown key not removed | Supported |
| `coerceTypes: false` | string integer rejected and unchanged | Supported |

### 3.4 Redaction

Retained diagnostic only contained category、Extension ID、escaped locator 和 reference path。结果：

- secret sentinel occurrences：`0`；
- raw config retained：`false`；
- raw Error message/stack retained：`false`；
- serialized diagnostic length `<= 500`：`true`。

这证明 allowlisted projection 可行，不替代 A1/A2 对所有 diagnostic categories 的 production tests。

## 4. Hypothesis disposition

| Hypothesis | Result | Boundary |
|---|---|---|
| pre-import canonical containment/reparse rejection 可实施 | Supported | Windows observed；Linux/macOS 需 CI/platform tests |
| relocated multi-file ESM + closed relative imports 可实施 | Supported | synthetic artifact；真实 Relay 在 A3 验收 |
| current Ajv 可实现 frozen Draft-07 options | Supported | production Schema/Descriptor matrix 在 A1/A2 验收 |
| bounded allowlisted diagnostics 可避免 secret/raw data retention | Supported | production formatter and category matrix pending |

Aggregate result：**Provisional Pass**。未命中 stop condition，未发现需要 bundler、public SDK、package install、second Runtime path 或 Extension-specific Host branch 的证据。

## 5. Limitations and remaining required evidence

- 单一 Windows run 不证明 Linux/macOS filesystem behavior；pure containment rule 和 CI platform tests 必须保留；
- dynamic import 会进入 Node module cache；v1 不承诺 unload，符合 Spec；
- synthetic artifact 不证明真实 Relay repository independence；
- 本 Spike 不执行 Extension code rejection counter、duplicate ID、Host config、SecretRef 或 Runtime handoff；这些属于 A1/A2 tests；
- 本 Spike 不迁移 supported Host，不删除 `COPILOT_RELAY_*` path；
- startup Runtime warning coverage 仍需 A4；
- Full artifact deployment/replacement 仍要求 Host stopped，不支持 symlink development installation。

## 6. Decision impact

本 Results 支持：

- Extension Acquisition Spec 从 `Draft` 进入 `In Review`；
- A1/A2 使用现有 Ajv 与 Node filesystem/ESM API，不新增 dependency；
- A3 继续采用 closed multi-file ESM artifact，不引入 bundler。

本 Results 不支持：

- 直接标记 Spec `Accepted`；
- 在当前 Model Invocation Error Boundary diff 中混入 production acquisition implementation；
- 自动 commit/push；
- 声称 A1–A5 已完成。

## 7. Cleanup

- OS temporary root 在脚本 `finally` 中递归删除；最终执行 exit code 0；
- disposable `.tmp-extension-acquisition-readiness.mjs` 在本 Results 写入后删除；
- `src/**`、supported Host、Runtime、package dependency/lockfile 和真实 Agent Home 未由 Spike 修改。
