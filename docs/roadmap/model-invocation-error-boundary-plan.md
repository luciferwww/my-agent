# Model Invocation Error Boundary Delivery Plan

## 1. 文档状态

- **状态：** Accepted
- **版本：** 1.0
- **日期：** 2026-09-11
- **所有者：** 项目所有者
- **类型：** Independent post-C3 Architecture Slice
- **关联 Contract：** [Model Invocation Error Boundary Amendment](../architecture/model-invocation-error-boundary-amendment.md)
- **关联设计：** [Extension Acquisition and Configuration Module Spec](../architecture/extension-acquisition-configuration-module-spec.md)
- **工作流：** [Development Workflow](../development-workflow.md)
- **执行授权：** 项目所有者于 2026-09-11 授权在已接受 Contract 边界内实施，并于 2026-09-14 接受实现、验证结果和评审处理。

本 Plan 只交付 Accepted Amendment 中的 same-realm structural Model Invocation error boundary。它不进入 Provider Catalog Plan C4，不实现 Extension acquisition，也不扩大错误协议。

## 2. 用户可观察结果

- 内置 Anthropic Provider 的现有 category、diagnostics、Abort 与 Context Overflow 行为不变；
- Copilot Relay 使用自己的 Error constructor 时，Runtime 仍能得到 Host-local canonical `ModelInvocationError`；
- Runtime operator logs 只投影验证后的 allowlist，不泄漏 foreign message、stack、cause、unknown 或 sensitive fields；
- Provider-owned opaque Model ID 在 canonical diagnostics 中 exact 保留，日志中只显示 escaped、bounded preview；
- Relay production JavaScript 不依赖 Host Core `ModelInvocationError` runtime constructor。

## 3. 非目标

- Provider Catalog Plan C4；
- Extension discovery、Descriptor、scoped configuration、loader 或 deployment；
- relocatable artifact、staging allowlist、ESM package marker 或 Agent Home mutation；
- public Extension SDK/package、peer dependency、module alias 或 singleton constructor；
- cross-realm、Worker、VM、process、RPC 或 serialized Error；
- generic Error protocol、Result-based Invocation API、Abort/Context Overflow redesign；
- Model Resolution、Provider Catalog、Channel 或 Runtime lifecycle 修改。

## 4. Delivery Item E1

**Plan Item 状态：** Completed

### 4.1 Core contract

- `ModelInvocationError` 增加固定 `protocol` 与 `version`；
- shared `ModelInvocationDiagnostics` 导出并增加可选 `providerErrorCode`；
- `ModelInvocationStructuralErrorV1` 作为 type-only authoring contract 导出；
- 只新增一个 runtime entry：`toModelInvocationError(value)`；
- structural extraction 仅接受 same-realm Error、own data properties 和 closed V1 values；
- diagnostics 只复制 allowlist，invalid diagnostics 整体丢弃；canonical copy 与 request summary 冻结。

### 4.2 Producer and consumer migration

- Anthropic 继续产生 Host-local class；
- Relay 改为 Relay-local structural Error，仅 type-import Core contract；
- Runtime 在既有八层 cause traversal 中调用 canonicalization entry；
- cause 只通过 own data descriptor 读取；accessor/失败立即停止该链；
- operator projection 独立于 canonical diagnostics，opaque Model ID 只在 projection 中 escape/truncate。

### 4.3 Evidence and synchronization

- 新增 Core positive/negative contract tests；
- 扩展 Relay mapping、constructor independence 与 source/build import closure tests；
- 扩展 Runtime foreign structural Error、bounded/cyclic/accessor cause 与 safe projection tests；
- 更新 FT-08 contract inventory 和 FT-12 Current Architecture assertions；
- 同步 Model Invocation Provider 与 Runtime Current Architecture；
- 更新文档索引和本 Plan 状态。

## 5. Definition of Ready

- [x] 用户可观察结果、非目标和边界明确；
- [x] Model Invocation Error Boundary Amendment v1.0 已 Accepted；
- [x] category、diagnostics、same-realm、version 和 canonicalization 语义均已关闭；
- [x] Core、Relay、Runtime ownership 与依赖方向明确；
- [x] 无兼容双路径：Host class 和 structural input 汇入同一 canonical entry；
- [x] focused、contract、integration、fitness 和 broad validation 范围明确；
- [x] 不存在需要 Spike 的外部 SDK、protocol 或 lifecycle 未知；
- [x] 项目所有者已授权 Delivery，并接受实现期间的重要选择。

## 6. Validation Gates

### Focused

- `src/core/model-invocation/errors.test.ts`
- `src/extensions/copilot-relay-provider/responses-client.test.ts`
- `src/runtime/RuntimeApp.test.ts`
- `src/adapters/provider/anthropic/AnthropicClient.test.ts`

### Contract and architecture

- `src/architecture-fitness/ft-08-contract-inventory.test.ts`
- `src/architecture-fitness/ft-11-document-disposition.test.ts`
- `src/architecture-fitness/ft-12-current-architecture.test.ts`
- source/build audit proving Relay production JavaScript has no Host Core runtime import

### Broad

- `npm run lint`
- `npm test`
- `npm run build`
- `git diff --check`

## 7. Definition of Done

- [x] Core structural contract and total canonicalizer implemented；
- [x] Relay Host constructor runtime dependency removed；
- [x] Runtime canonicalization and safe operator projection implemented；
- [x] Anthropic/Relay category and diagnostics regressions pass；
- [x] duplicate-constructor, malformed input, bounded traversal and redaction evidence pass；
- [x] Relay source and emitted production JavaScript contain no forbidden Host runtime import；
- [x] Current Architecture, contract inventory and documentation index synchronized；
- [x] focused、fitness、lint、full tests、build 和 diff checks pass；
- [x] independent review has no unresolved Critical/High finding；
- [x] owner review accepted implementation、validation evidence 与 review disposition。

## 8. Validation Record

- Focused Core/Relay/Runtime/Anthropic：111/111 passed；review corrections 后 Core/Runtime：65/65 passed；
- 最终 Architecture Fitness FT-08/FT-09/FT-11/FT-12：20/20 passed；
- `npm run lint`：passed；
- `npm test` under Node 22.22.2：100 files / 942 tests passed；
- `npm run build`：passed，包含 6 个 Relay production JavaScript files 的 emitted-import audit；
- `git diff --check`：passed；
- 编辑器测试进程使用 ABI 115 时，4 个 SQLite tests 因现有 `better-sqlite3` ABI 127 不匹配而失败；项目 Node 22 / ABI 127 的权威终端全量运行通过；
- 三轮独立 review：最终 PASS，无 unresolved Critical/High/Medium；全部前置 findings 均已采纳并复验。
