# Extension Acquisition and Configuration Delivery Plan

## 1. 文档状态

- **状态：** Accepted；A1 completed；A2 not authorized
- **版本：** 0.1
- **日期：** 2026-09-11
- **所有者：** 项目所有者
- **类型：** Independent post-C3 Architecture Slice
- **关联 Spec：** [Extension Acquisition and Configuration Module Spec](../architecture/extension-acquisition-configuration-module-spec.md)
- **前置 Contract：** [Model Invocation Error Boundary Amendment](../architecture/model-invocation-error-boundary-amendment.md)
- **工作流：** [Development Workflow](../development-workflow.md)
- **执行授权：** 项目所有者于 2026-09-11 授权 A0 readiness evidence，并于 2026-09-14 接受 A0 Results；production Delivery 仍需独立授权。

本 Plan 独立于 Provider Model Catalog Plan C4。项目所有者于 2026-09-14 接受 Spec v0.4 并只授权 A1 contract/fixture foundation；不迁移 supported Host、不动态执行 production Extension、不删除 Relay 过渡路径。

## 2. 用户可观察目标

- 安装并显式启用符合 Contract 的 External Extension 后，重启 supported Host，其 Contributions 通过现有 Runtime Unit/Registry generation 发布；
- 禁用或移除后重启不再发布，其他 Unit 不受影响；
- Host 不包含 Extension-specific import、ID、环境变量或配置字段；
- Copilot Relay 通过 scoped config/SecretRef 与闭合、可重定位 artifact 进入同一路径；
- acquisition 与 Runtime startup failure 以 bounded、redacted operator warning 呈现，不进入普通 Channel/browser protocol。

## 3. 非目标

- Provider Catalog Plan C4；
- Marketplace、下载、安装器、更新器、签名、sandbox 或 untrusted code；
- watcher、hot reload、module unload、运行中 artifact 替换；
- public Extension SDK/package、package manager install、bundler 或 dependency graph；
- 第二条 Registry、Provider、Runtime lifecycle 或 invocation path；
- 动态化 supported Host 自身的 WebSocket Channel。

## 4. Delivery sequencing

### A0 — Readiness evidence

**状态：** Completed

- 验证 Windows realpath、symlink/junction/reparse、containment 和 file URL/import 行为；
- 验证 Ajv Draft-07 strict compilation、internal-only `$ref`、defaults/no-coercion/no-removal；
- 观察当前 Relay emitted production import shape，并以 synthetic closed artifact 验证 relocated multi-file ESM load 的可行性；真实 Relay artifact closure 与 repository independence 留给 A3；
- 验证 bounded/redacted diagnostics 可在不读取 secret value 的前提下分类；
- 产出 disposable Spike Results；不修改 production loader/Host。

**Gate A0：** Passed。Windows/Node 22/Ajv readiness evidence 已记录并由项目所有者于 2026-09-14 接受；Spec 已 `Accepted`，仅 A1 获得 Delivery authorization。

### A1 — Acquisition contract and fixture foundation

**状态：** Completed（owner accepted 2026-09-14）

- 新增 acquisition type contracts、Agent Home resolution、Host config reader；
- direct-child Descriptor discovery、identity/order/duplicate isolation；
- fixture Extensions 证明 rejected/disabled entry execution count 为零；
- 不接入 supported Host。

**实现记录（2026-09-14）：**

- 新增 internal acquisition barrel、Agent Home resolution、独立 Host extension config reader、direct-child static Descriptor discovery、canonical containment、deterministic identity/order/duplicate isolation；
- Host config malformed/root-level invalid 与 discovery root 已存在但 unreadable/invalid/escaping 均为 fatal Host startup input；missing Agent Home/config/discovery root 保持 empty/non-creating semantics；
- 单个 entry namespace 保留为 isolated raw value，A2 才 materialize/validate；A1 Schema preflight 只验证 Draft-07 root contract 与可解析 internal JSON Pointer，Ajv strict compilation 仍是 A2 Gate；
- fixture entry 具有 observable top-level marker；A1 static reject、duplicate 和 disabled-config foundation 均不 import/execute。完整 enablement-to-loader zero-execution matrix 仍由 A2 完成；
- 不修改 supported Host、Runtime、Relay 或 workspace Config，不新增 dependency，不形成第二条 lifecycle path。

**Validation record：** focused acquisition 41/41；full Vitest 103 files / 983 tests；lint、build、Relay emitted audit、`git diff --check` passed；independent final review PASS，无 unresolved Critical/High/Medium finding。

项目所有者于 2026-09-14 接受 A1 implementation、validation evidence 与 review disposition。该接受不授权 A2–A5。

### A2 — Scoped configuration and controlled loader

**状态：** Not Started

- `$env`/`$secret` materialization、Ajv validation、defensive freeze；
- controlled ESM import、factory/metadata/dependency validation；
- frozen deterministic `ExtensionAcquisitionResult`；
- Loader 只返回 `LoadedRuntimeUnit[]`，不 create/start/register。

### A3 — Relay artifact

**状态：** Not Started

- Relay `extension.json` 与 `entry.js` adapter；
- repository build 生成 closed multi-file ESM artifact；
- allowlist、recursive import closure、relocation、repository independence tests；
- 构建不读写 Agent Home，不执行 `npm install`。

### A4 — Generic Host migration

**状态：** Not Started

- supported WebSocket Host 解析 Agent Home、acquire generic Units、保留 static WebSocket Channel；
- Relay config 迁移到 Host config scoped namespace；
- 删除 Relay import、ID、URL normalizer 与 `COPILOT_RELAY_*` reads；
- default Model Reference 只来自 workspace config 或 generic atomic env override；
- acquisition result 与 Runtime warning 投影给 operator。

### A5 — Closeout

**状态：** Not Started

- 完成 integration/Fitness/Current Architecture/deployment docs；
- 验证无 dual acquisition/config/error/lifecycle authority；
- broad validation 与 independent review；
- owner acceptance 后才标记 Completed。

## 5. Definition of Ready for production Delivery

- [x] Acquisition Spec `Accepted`；
- [x] 独立 Plan、owner、migration Gate 与 non-goals 明确；
- [x] structural Model Invocation error boundary 已实现并完成自动 validation evidence；
- [x] A0 filesystem/module/Ajv/synthetic-artifact/redaction readiness evidence 完成；
- [x] Descriptor/Schema/module format Contract tests 范围明确且无 blocker；
- [x] Windows evidence 与 Linux/macOS pure-rule/CI platform evidence boundary 明确；
- [ ] production files、真实 caller、旧路径删除条件和 rollback 明确；
- [ ] focused/contract/integration/Fitness/broad validation matrix 完整；
- [ ] 无需新的 dependency、第二 runtime path 或 Extension-specific Host branch。

## 6. Global exit conditions

- 每个 Gate 的证据和状态独立记录；
- production implementation 只在 A0 与 Spec acceptance 后开始；
- A4 原子删除旧 Host-specific Relay acquisition，不保留 fallback；
- A5 前完整 `npm run lint`、`npm test`、`npm run build`、artifact relocation audit 与 `git diff --check` 通过；
- commit 或 push 必须由项目所有者明确授权。
