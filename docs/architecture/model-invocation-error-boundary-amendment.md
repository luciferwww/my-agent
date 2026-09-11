# Model Invocation Error Boundary Amendment

## 1. 状态

- **状态：** Accepted
- **版本：** 1.0
- **日期：** 2026-09-11
- **所有者：** 项目所有者
- **关联设计：** [Extension Acquisition and Configuration Module Spec](extension-acquisition-configuration-module-spec.md)
- **当前事实：** [Model Invocation、Anthropic 与 Copilot Relay Adapter](current/adapter_llm.md)
- **工作流：** [Development Workflow](../development-workflow.md)

本文档是窄范围的 Model Invocation error-boundary 修订。它只解决独立 Extension artifact 与 Host 可能持有不同 Error constructor 时的识别问题。项目所有者已接受本 Contract；`Accepted` 不等于 `Implemented`，不建立通用 Extension SDK 或错误框架，也不改变当前生产行为。只有关联 Delivery Plan Item 达到 Ready 且项目所有者单独授权 Delivery 后，才能修改生产代码。

项目所有者于 2026-09-11 接受 exact discriminator `protocol: "my-agent.model-invocation-error"`。该字符串只标识协议语义，不包含版本；numeric `version` 是唯一版本来源。

项目所有者于 2026-09-11 决定 V1 沿用现有六种 closed category，`diagnostics` 保持可选。本修订不增加或重定义 Provider failure category；缺少 diagnostics 不影响合法 category 的识别。

项目所有者于 2026-09-11 决定将可选 `providerErrorCode: string` 纳入 shared `ModelInvocationDiagnostics`。Core 只验证、保存和安全投影该值，不解释 Provider-specific code，也不据此增加 Provider 分支或 policy。

项目所有者于 2026-09-11 决定 structural envelope 与 optional diagnostics 分层验证：exact protocol、version 和 category 合法时保留 category；diagnostics 存在但无效时整体丢弃，不逐字段修复，也不传播半可信 diagnostics。身份字段无效时整个 Error 不被识别。

项目所有者于 2026-09-11 决定保留 Runtime 当前最多八层的 cause traversal 与 cycle detection。foreign structural Error canonicalize 后不作为 raw `cause` 保留，不复制 foreign stack、message 或私有字段；Runtime 后续只消费验证后的 category 与 diagnostics。

项目所有者于 2026-09-11 接受本文档的 Scope、Non-goals 和 Required Evidence，关闭全部 Draft review decisions，并将本文档推进到 `In Review`。该中间状态当时不授权 production Delivery。

项目所有者于 2026-09-11 接受独立评审中关于 diagnostics validation、non-throwing own-data extraction、type/runtime API visibility、contract delta wording、artifact ownership 和 same-realm scope 的局部修订；拒绝把 v1 扩大为 cross-realm object traversal、恶意 Extension sandbox、通用 Proxy security framework 或完整 artifact packaging contract。这些修订已通过第二轮聚焦复审。

项目所有者于 2026-09-11 接受本文档 v1.0。该接受关闭 Model Invocation structural error design gate，但不授权 production Delivery；当前代码与 Current Architecture 仍描述既有 class-identity path，直到单独批准的实现和验证完成。

## 2. Problem

当前 Provider Adapter 通过 Core `ModelInvocationError` 表达 normalized invocation failure，Runtime 沿 cause chain 使用 `instanceof ModelInvocationError` 查找该错误。该行为在同一 module graph 中成立，但独立构建的 Extension 不能以共享 constructor identity 作为正确性前提。

目标是以最小改动同时满足：

- 当前内置 Provider 继续使用 Host canonical `ModelInvocationError`；
- 独立 Extension 可以使用自己的 Error constructor；
- Runtime 对两种输入得到同一个 Host-local canonical Error；
- 长期跨 Extension 权威是结构字段，不是 class identity；
- 当前 category、diagnostics、Abort 和 Context Overflow 语义不变。

## 3. Minimal V1 Contract

V1 不引入 envelope、Result 或新的 Invocation Port。`ModelStreamEvent.error` 继续是 `Error`，Provider 继续 throw/yield Error。本修订增加两个 top-level discriminator 字段、一个 Host canonicalization contract，并把一个 Relay 已使用的可选字段纳入 shared diagnostics：

```ts
interface ModelInvocationStructuralErrorV1 extends Error {
  readonly protocol: 'my-agent.model-invocation-error';
  readonly version: 1;
  readonly category: ModelInvocationFailureCategory;
  readonly diagnostics?: ModelInvocationDiagnostics;
}
```

字段规则：

- `protocol` 是 exact discriminator，不使用 `name`、message 或 constructor 猜测；
- `version` 是 structural protocol major version，不是 package semver，也不引入版本协商；
- `category` 沿用现有六种 closed value：`authentication`、`rate_limit`、`invalid_request`、`unavailable`、`transport`、`provider_failure`；
- `diagnostics` 保持可选，以兼容当前无 diagnostics 的 `ModelInvocationError`；
- shared diagnostics 沿用现有 Provider/request summary，并增加 Relay 已使用的可选 `providerErrorCode`；
- 不加入 Extension ID、安装 locator、stack、raw cause、prompt、Tool input/result、image data、credential 或完整 Provider response。

`ModelInvocationError` 自身应携带上述结构字段，因此同一 Host module graph 内的现有 class path 与 structural path 不形成两个语义权威。

Core Model Invocation 是类型权威，并从现有 Core barrel 导出 `ModelInvocationStructuralErrorV1` 与 `ModelInvocationDiagnostics` 作为 type-only authoring contracts。该类型导出不建立独立 Extension SDK/package；repository-built Relay 只使用可在 emit 中擦除的 `import type`。Extension 不导入或调用 Host canonicalization runtime helper。

### 3.1 Diagnostics V1 validation

`diagnostics` 输入可以包含 Host 未知的附加字段，但所有 V1 已知字段必须满足下表。Host 不读取、不验证也不复制未知字段，只从已知 own data properties 构造 allowlisted canonical copy：

| 字段 | V1 validation |
|---|---|
| `providerId` | required；匹配现有 Provider identity grammar `[A-Za-z0-9_-]{1,64}` |
| `httpStatus` | optional；`100..599` 范围内 safe integer |
| `providerErrorType` | optional；不含 CR/LF/TAB 且不超过 500 UTF-16 code units 的 string |
| `providerErrorCode` | optional；不含 CR/LF/TAB 且不超过 500 UTF-16 code units 的 string |
| `providerMessage` | optional；不含 CR/LF/TAB 且不超过 500 UTF-16 code units 的 string |
| `requestId` | optional；不含 CR/LF/TAB 且不超过 500 UTF-16 code units 的 string |
| `request` | required own plain data record；只复制下列 request summary fields |
| `request.model` | required arbitrary string；保持 exact opaque value，不 trim、不 normalize、不截断 |
| `request.maxTokens` | positive safe integer |
| `request.hasSystem` | boolean |
| 其余 request count fields | non-negative safe integer |

Provider Adapter 负责在构造 structural Error 前把非 opaque diagnostic strings 归一化到上述限制；Host 不猜测修复 foreign 值。任一已知 diagnostics 字段或 request summary 无效时，整个 optional diagnostics 被丢弃，但已验证的 structural category 保留。

Canonical diagnostics 与 operator logging 是不同边界。Canonical copy 保留 exact `request.model`；Runtime operator projection 必须对该值执行 JSON-style escaping，并只展示前 200 UTF-16 code units，超出时附加省略标记。日志限制不得写回或改变 canonical opaque Model ID。Operator projection 不包含 unknown fields、raw Error、stack、cause、prompt、Tool input/result、image data、credential 或完整 Provider response。

## 4. Compatibility Rules

- V1 内可增加 Host 不需要理解的可选字段；Host 只复制已知 allowlist，不传播未知字段；
- 删除字段、改变字段类型/语义、增加 Host 必须理解的 required 字段或改变 canonicalization 安全语义时，使用新的 major version；
- Host 只识别 `version === 1`；未知版本按普通 unknown Error 处理，不猜测兼容；
- known required field 无效时不识别为 Model Invocation Error；
- optional diagnostics 缺失时仍可识别 category；diagnostics 存在但不符合 V1 时，Host 不传播该 diagnostics；
- Provider-owned opaque Model ID 不 trim、不 normalize、不按 identifier grammar 校验；日志 projection 可以 escape/truncate 展示值，但不得改写协议中的原值。
- security-relevant accepted value set、field interpretation 或 canonicalization 语义发生不兼容改变时升级 major version；单纯收紧 Host operator projection 不改变 structural payload 语义，不要求升级；

第一版不维护多个 parser，不执行版本降级，不协商 Extension/Host 版本，也不提供 schema registry。

## 5. Single Host Canonicalization Entry

Core Model Invocation 只需要一个对 Runtime 有意义的统一入口：

```ts
function toModelInvocationError(value: unknown): ModelInvocationError | undefined;
```

该 runtime helper 由 Core 拥有并通过 repository-internal Core barrel 提供给 Host/Runtime，不属于 Extension-facing contract。Extension 只产生 structural Error，不能依赖此 helper 或 Host runtime module。

行为固定为：

1. Host-local `ModelInvocationError` 直接返回；
2. 否则只接受 same-realm `Error`，并验证其 own data properties 中的 exact `protocol`、`version` 和 closed `category`；
3. diagnostics 有效时只复制并冻结已知字段；无效时不传播 diagnostics；
4. 构造 Host-local `ModelInvocationError`；
5. malformed、同名但无协议或未知版本的值返回 `undefined`。

该入口对任何 `unknown` 输入必须 non-throwing：只通过 own property descriptor 读取 data property，不执行 accessor；property descriptor/read/copy/freeze 失败时返回 `undefined`。对 diagnostics 只读取本 Spec 定义的两层 record，不递归复制 foreign object graph。边界 `try/catch` 只提供 total-function guarantee，不声称隔离恶意同进程 Extension 或提供 Proxy sandbox。

该入口可以由内部小函数实现，但不增加独立 public builder、guard、parser、normalizer 和 canonicalizer API 家族。Runtime cause traversal 保留当前 same-realm `Error`、最多八层和 cycle detection，只把每个节点的 `ModelInvocationError` class 判断替换为该统一入口。`cause` 同样只从 own data property 安全读取；读取失败时停止该链，不把任意 object graph 当作 cause chain。

Canonical Error 不序列化、不记录 foreign raw Error、stack 或完整 cause。现有 outer cause chain 可继续用于 bounded traversal，但 operator logging 只消费 canonical category 与 validated diagnostics。

## 6. Producer and Consumer Migration

### 6.1 Host-owned Provider

Anthropic Adapter 继续构造 Core `ModelInvocationError`。Core class 增加固定 `protocol` 与 `version` 后，它自然满足 V1，不增加第二种 producer path。

### 6.2 Copilot Relay Extension

Relay 不再运行时 import 或 subclass Host `ModelInvocationError`。它可以用 Relay-local Error class 携带 V1 字段，并仅通过 type-only import 在源码期检查 shape；编译后的 Relay artifact 不保留 Host Core runtime import。

HTTP status/category mapping、bounded diagnostics、SSE fail-closed 和 Abort 行为保持不变。

### 6.3 Runtime

Runtime 沿现有 cause chain 调用 `toModelInvocationError()`。之后的分类和 logging 继续只消费 Host-local `ModelInvocationError`，不 import Relay 或其他 Extension-private Error class。

### 6.4 Artifact responsibility boundary

本修订只证明当前 Relay source-level production closure 在迁移后不再依赖 Host `ModelInvocationError` runtime constructor，并要求 emitted Relay production JavaScript 不出现 Host Core runtime import。Descriptor、ESM marker、staging file allowlist、完整递归 import closure、Agent Home relocation 和 repository/build-tree independence 由 [Extension Acquisition and Configuration Module Spec §7.8](extension-acquisition-configuration-module-spec.md#78-relay-installation-artifact) 独立拥有和验收；两个 discriminator 字段本身不构成 artifact build specification。

## 7. Preserved Semantics

- AbortError 不属于 Model Invocation Structural Error，不增加 abort category，也不转换为 `provider_failure`；
- `ContextOverflowError` 保持独立，不在本修订中结构化；
- `ModelInvocationPort`、request/response/stream event、Tool、Usage 和 media shape 不变；
- Model Resolution、Provider Catalog、opaque Model ID 和 Runtime lifecycle 不变；
- malformed structural Error 不影响普通 unknown-error handling；
- 本修订不形成第二条 invocation、Registry 或 Runtime path。
- V1 只承诺同一 Node.js Realm 内加载的 trusted ESM Extension；Worker、VM context、子进程、RPC 和序列化边界需要未来独立 Contract。

## 8. Non-goals

- 通用 Extension error protocol；
- 所有 Runtime Error 的结构化或序列化；
- 公共 Extension SDK/package、peer dependency 或 module alias；
- bundler、package manager installation 或跨进程 RPC；
- Result-based Invocation API；
- Abort Contract 或 Context Overflow redesign；
- Provider-specific Runtime branch；
- Extension discovery、configuration、loading 或 artifact deployment。

## 9. Required Evidence

### 9.1 Core Contract

- Host-local `ModelInvocationError` 仍可直接 canonicalize；
- foreign/duplicate constructor 的合法 V1 Error 可 canonicalize；
- 相同 `name`/message 但无 exact protocol 的 Error 不被识别；
- missing/wrong protocol、unknown version 和 invalid category 不被识别；
- invalid optional diagnostics 不进入 canonical diagnostics；
- allowlist copy 不传播未知、raw 或 sensitive 字段；
- canonical diagnostics 与 nested request summary defensively frozen。
- inherited/accessor discriminator 或 diagnostics 不被接受；throwing property access/copy 不从 canonicalization 逸出；
- exact opaque Model ID 保留在 canonical diagnostics，operator projection 只输出 escaped/truncated preview。

### 9.2 Producer and Runtime

- Anthropic 与 Relay 现有 status/category mapping 不变；
- Relay 的可选 `providerErrorCode` 保留；
- Abort 与 Context Overflow regression 通过；
- Runtime 在多层和 cyclic cause chain 中保持 bounded traversal；
- Host class 与 foreign structural Error 产生相同 Runtime category/diagnostic logging；
- Relay production JavaScript 不包含 Host Core runtime import。
- Runtime operator projection 不包含 foreign message、stack、cause、unknown fields 或 sensitive payload；
- 完整 relocatable artifact evidence 由 Extension Acquisition Spec 验收，不在本修订重复建立 packaging path。

### 9.3 Broad Validation

- focused Core/Anthropic/Relay/Runtime tests；
- architecture fitness 与 contract inventory；
- `npm run lint`、`npm test`、`npm run build` 和 `git diff --check`。

## 10. Migration and Exit

1. 本 Amendment 经项目所有者评审并进入 `Accepted`；
2. 建立关联 Delivery Plan Item 并单独授权实现；
3. Core class 与统一 canonicalization entry 落地；
4. Anthropic、Relay、Runtime 三个真实调用面迁移；
5. duplicate-constructor 与 no-Host-runtime-import evidence 通过；
6. Current Architecture 和 Extension Acquisition readiness gate 同步；
7. Extension Acquisition 才可依赖该边界开始 Relay artifact migration。

Compatibility 没有独立旧 API：Host class 输入与 structural input 在同一入口汇合。长期可以停止 Extension 侧共享 class 使用，但 Host-local `ModelInvocationError` 是否保留不由本修订删除。

## 11. Accepted Decision Checklist

- [x] exact discriminator `my-agent.model-invocation-error` 已接受；
- [x] numeric major `version: 1` 已决定；
- [x] existing category set 与 optional diagnostics 已确认；
- [x] optional `providerErrorCode` 进入 shared diagnostics 已确认；
- [x] invalid diagnostics 只丢弃 diagnostics、仍保留合法 category 的规则已确认；
- [x] no raw foreign cause retention 与八层 bounded traversal 已确认；
- [x] Scope/Non-goals/Required Evidence 已确认；

## 12. Independent Review Disposition

| Finding | Disposition | Reason |
|---|---|---|
| diagnostics field rules 未冻结 | 接受 | 增加固定 V1 allowlist/validation table，不引入 Schema framework |
| canonicalization 可能因 foreign property access 抛出 | 修改后接受 | 要求 non-throwing own-data extraction；不声称恶意代码隔离 |
| type-only contract 与 runtime helper visibility 不明 | 接受 | Core 导出 type contract；canonicalizer 只供 Host/Runtime |
| “只增加两个字段”低估 contract delta | 接受 | 修正为两个 discriminator、canonicalization contract 和一个 diagnostics 字段 |
| Amendment 与 artifact evidence ownership 混淆 | 接受 | 本修订只验 no Host runtime import；完整 artifact 由 Acquisition Spec 拥有 |
| cross-realm 任意 object traversal | 拒绝 | v1 是 same-realm trusted ESM；Worker/VM/RPC 不在范围内 |
| 通用 Proxy/恶意 Extension security framework | 拒绝 | 只保证 parser totality；同进程 Extension 无 sandbox |
| 完整 artifact packaging test 纳入本修订 | 拒绝 | 避免与 Acquisition Spec 形成双重权威 |
| spoofed AbortError 覆盖 exact discriminator | 拒绝 | Producer 必须遵守 Abort contract；不重新引入 `name` authority |
