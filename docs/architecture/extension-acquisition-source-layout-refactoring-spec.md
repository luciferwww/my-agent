# Extension Acquisition Source Layout Refactoring Spec

## 1. 状态

- **状态：** Validated
- **版本：** 0.1
- **日期：** 2026-09-14
- **所有者：** 项目所有者
- **变更分类：** Extension Acquisition and Configuration 的 post-delivery source-layout/build-boundary update
- **关联计划：** [Extension Acquisition Source Layout Refactoring Plan](../roadmap/extension-acquisition-source-layout-refactoring-plan.md)
- **控制决策：** [ADR-005 Extension/Module/Registry Composition 与 Runtime Lifecycle](adr-005-extension-registry-runtime-composition.md)
- **既有 Contract：** [Extension Acquisition and Configuration Module Spec](extension-acquisition-configuration-module-spec.md)（Accepted；本 Spec 不修改其运行时语义）
- **当前事实：** [Current Architecture Overview](current/overview.md)、[Configuration and Extension Acquisition](current/platform_config.md)、[Runtime](current/runtime.md)
- **工作流：** [Development Workflow](../development-workflow.md)

项目所有者于 2026-09-14 选择 B+ layout direction；Draft validation 与 independent design review PASS 后，项目所有者接受本 Spec 与关联 Plan，选择 §10 B2 first-class Host/Core build，并授权 L1–L3 production Delivery。本文中的 **B+** 表示：将 acquisition 提升为独立顶层 source module，并在同一 module 内把 Extension entry contracts 放入 `contracts.ts`、把 acquisition data types 保留在 `types.ts`。

项目所有者于 2026-09-14 接受 B+ / B2 implementation、cumulative validation 与 independent implementation review；本 Spec 因此标记 Validated。

本 Spec 属于既有 Extension Acquisition and Configuration capability 的更新，不建立第二个 Extension system、第二套 acquisition authority 或新的上层架构 Slice。独立工件用于隔离本次重构的决策、迁移和验证记录；已完成的 A0–A5 保持关闭，其 accepted behavior 继续是本次更新必须保留的基线。

## 2. Purpose

消除“Host 必需的 External Extension acquisition 基础设施”和“可选 concrete Extension implementations”共享 `src/extensions/` 父目录所造成的物理生命周期混淆，同时保持已经接受的配置、发现、加载、Runtime Unit、Registry、lifecycle、错误和 artifact Contract 不变。

目标布局为：

```text
src/
├── extension-acquisition/       Host 与 Runtime Composition 之间的 acquisition boundary
│   ├── contracts.ts             Extension entry 的最小 internal structural contract
│   ├── types.ts                 acquisition/config/discovery/result/diagnostic data types
│   └── ...                      Agent Home、config、discovery、validation、loader
└── extensions/                  可选 concrete Extension implementations
    └── copilot-relay-provider/
```

该布局表达两个独立不变量：

1. 只要产品支持 External Extension，`extension-acquisition` 就是 Host source closure 的必需模块；
2. 任一或全部 concrete Extension implementation 可以不存在，而不会删除 acquisition capability 或迫使 Host/Runtime import具体 Extension。

## 3. Scope

- 将当前 `src/extensions/acquisition/` 原子迁移到 `src/extension-acquisition/`；
- 在新模块内新增 `contracts.ts`，只拥有 `ExtensionLoadContext` 与 `ExternalExtensionModule`；
- `types.ts` 继续拥有 Descriptor、Host Extension config、candidate、diagnostic、result 与 options 等 acquisition data types；
- `index.ts` 继续作为 acquisition 的唯一内部 barrel，并 type-export entry contracts；
- 迁移 supported Host、Relay entry、测试和 architecture fitness 的真实 import/path ownership；
- 更新 Relay artifact audit 对 emitted acquisition module 的加载路径；
- 删除旧 `src/extensions/acquisition/`，不保留 compatibility barrel、re-export、alias 或双路径；
- 保持 concrete Relay source 位于 `src/extensions/copilot-relay-provider/`；
- 证明 Host source/dependency graph 不 import任何 concrete Extension；
- 明确 Core/Host build independence 与 repository aggregate build 的关系，并按 §10 的 owner decision 实施；
- 更新 Current Architecture、Contract inventory、source-layout/Fitness evidence 和独立实施记录。

## 4. Non-goals

- 不改变 Agent Home、`<agent-home>/config.json`、`<agent-home>/extensions` 或 Descriptor filesystem contract；
- 不改变 `createExtension()` 的参数、同步/无副作用要求或 `LoadedRuntimeUnit` 返回语义；
- 不改变 Runtime Unit create/start/stage/register/publish/retire/stop authority；
- 不建立 Public Extension SDK、npm package、semver compatibility 或 package alias；
- 不增加 Registry mutation API、Service Locator、Runtime instance、Logger、filesystem capability 或 global Config 给 Extension；
- 不把 Runtime Builder、Registry staging 或 lifecycle 迁入 acquisition；
- 不把 WebSocket Channel 动态化；
- 不建设 Marketplace、installer、update、sandbox、watcher、hot reload 或 Extension dependency graph；
- 不改变 Relay artifact 内容、Responses behavior、Model Catalog 或 C4；
- 不在本 Slice 建设单文件 bundler 或完整 self-contained Host deployment package。

## 5. Baseline and Problem

当前 acquisition 的 production source、tests 与 contracts 全部位于 `src/extensions/acquisition/`。同一 `src/extensions/` 父目录还包含 concrete Relay Extension。这并未造成当前 runtime dependency violation，但它让“删除整个 concrete Extension source tree”和“保留 Host acquisition capability”无法通过目录边界同时表达。

Supported WebSocket Host 已经只调用 generic acquisition API，并将得到的 `LoadedRuntimeUnit[]` 与 static WebSocket Channel 一起交给 `RuntimeApp.create()`。Runtime、Runner 和 Registry 不 import acquisition 或 concrete Relay；本重构不改变该方向。

当前 `types.ts` 同时保存 acquisition data types 与两个 entry contracts。Relay 对 `ExtensionLoadContext` 的依赖是 type-only；该依赖不会进入 emitted Relay artifact，但文件级职责仍可更准确地区分。

当前 repository `npm run build` 是 aggregate build：TypeScript compile 后还无条件构建并审计 Relay artifact。Relay artifact builder 固定读取 `src/extensions/copilot-relay-provider/` 与对应 emitted output。因此 source relocation 本身只能让 Host source graph 独立于 concrete Extension；若要求某个 build 命令在 concrete `src/extensions/` 不存在时通过，必须显式定义独立的 Host/Core build contract，不能通过目录重命名伪装完成。

## 6. Boundaries and Dependencies

### 6.1 Ownership

| Module | Owns | Does not own |
|---|---|---|
| Extension Acquisition | Agent Home resolution、Host Extension config、Descriptor discovery、scoped config materialization/validation、controlled entry import、Unit metadata normalization、acquisition diagnostics | Unit lifecycle、Registry mutation、concrete Extension behavior、installation/update |
| Extension Acquisition entry contracts | `ExtensionLoadContext`、`ExternalExtensionModule` 的 internal structural TypeScript shape | Public SDK、runtime singleton、Contribution registration API |
| Concrete Extension | Descriptor/Schema、scoped config semantics、entry factory、returned Unit 与私有资源 | discovery、global Host config、其他 Extension、Runtime private state |
| Runtime Composition | Unit catalog、create/start/staging/publication/retirement/stop | Agent Home、Descriptor discovery、Extension config files |
| Host | acquisition 输入、process environment、启动/退出、operator presentation、static Host Units | concrete Extension ID、factory 或业务配置字段 |

### 6.2 Allowed direction

```text
Supported Host
  -> Extension Acquisition
  -> RuntimeAppOptions.loadedUnits
  -> Runtime Composition

Extension Acquisition
  -> Extension Acquisition entry contracts
  -> Runtime LoadedRuntimeUnit type contract

Concrete Extension entry
  -> Extension Acquisition entry contracts (type-only)
  -> Runtime LoadedRuntimeUnit type contract (type-only)
```

禁止：

- acquisition import `src/extensions/<specific-extension>/**`；
- Host、Runtime、Runner 或 Registry import具体 Extension；
- Runtime import acquisition；
- concrete Extension import acquisition loader、discovery、Host config、Agent Home 或 diagnostics；
- 旧路径与新路径同时存在；
- 为路径兼容增加 TypeScript alias、barrel 或 runtime fallback。

## 7. Internal Contract

`contracts.ts` 只包含当前 Acquisition Spec §7.5 已接受的两个 normative behavioral shapes：

```ts
import type { LoadedRuntimeUnit } from '../runtime/runtime-unit.js';

export interface ExtensionLoadContext {
  readonly config: Readonly<Record<string, unknown>>;
}

export interface ExternalExtensionModule {
  createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit;
}
```

约束：

- 既有 Acquisition Spec 所称 public acquisition contract 是模块调用边界；本重构只改变其 repository source owner，不改变 shape 或兼容语义；
- 这些类型仍是 repository-internal source contract，不产生独立 package、declaration bundle、versioning promise、runtime singleton 或 Public SDK；
- `createExtension()` 仍同步返回尚未 `create()` 的 `LoadedRuntimeUnit`；
- context 仍只有 validated、frozen scoped config；
- acquisition runtime code 不要求 Extension import Host implementation；
- concrete Extension 的 type-only import 被编译擦除，artifact closure 不包含 acquisition；
- `LoadedRuntimeUnit` 的定义和 lifecycle ownership 继续留在 Runtime；
- 后续只有出现跨 package consumer、独立 versioning 或正式 Public SDK 需求时，才另行决定是否把 contracts 提升为独立顶层 boundary。

## 8. Behavior and Lifecycle Invariants

本重构不得改变：

- Agent Home precedence、canonicalization 与 missing-root semantics；
- direct-child discovery、Descriptor ID identity、deterministic ordering、duplicate isolation；
- explicit enablement、scoped config、SecretRef、Draft-07 validation 和 defensive freeze；
- controlled ESM import、single named factory export、Unit metadata/dependency validation；
- candidate failure isolation、frozen acquisition result 和 bounded/redacted diagnostics；
- Loader 不调用 Unit `create()`、`start()`、`stop()` 或 registration；
- Runtime 是 create/start/stage/register/publish/retire/stop 的唯一 authority；
- supported Host 不包含 Relay-specific import、ID、environment name 或 fallback；
- Relay artifact 仍不 runtime-import Host/acquisition source。

## 9. Source Migration

迁移必须原子完成：

1. 创建新顶层 acquisition module，并把两个 entry contracts 移入 `contracts.ts`；
2. 更新模块内部 imports 与 test fixture relative paths；
3. 更新 supported Host imports；
4. 更新 Relay entry 的 type-only contract import；
5. 更新 Relay entry test 对 config preparation helper 的测试依赖；
6. 更新 `scripts/audit-relay-extension-artifact.mjs`，使 generic acquisition audit 从新的 emitted path 加载，且继续在 build tree relocation 前完成；
7. 更新 FT-06 的 loader/runtime direction path、FT-08 contract surface 与 inventory、FT-12 Current Architecture surface 与 top-level module inventory；扩展 FT-13 或增加同等级 exact source-layout assertion，禁止旧 acquisition root；
8. 对 production source、scripts、tests、clients、build/audit inputs 执行 exact stale-path scan；历史 narrative 不因路径重命名而例行改写，但其中的可执行命令、active authority/evidence link 或仍被推荐的旧路径必须更新；
9. 删除旧 acquisition 目录；
10. 更新 Current Architecture module map、Configuration/Acquisition topic owner和 evidence links；
11. 运行 focused、contract、integration、Fitness、lint、full test、build、Relay audit 和 Host smoke；
12. independent review 确认无 dual path、stale executable path、concrete Extension dependency 或 C4 scope expansion。

不创建 compatibility window。Rollback 只能整体回滚该变更，不在同一版本保留两个 import root。

### 9.1 Exact governed impact inventory

以下 active/executable surfaces 是 Delivery 的 exact minimum；实现前的全库 stale-path scan 可以发现附加引用，但不得省略这些已知项：

| Surface | Required migration |
|---|---|
| `scripts/websocket-host-startup.ts`、对应 test | import root 改为 `src/extension-acquisition/index.js`；行为 assertions 不变 |
| Relay `entry.ts` | `ExtensionLoadContext` 改为从 `src/extension-acquisition/contracts.js` type-import；不得 import loader/configuration |
| Relay `entry.test.ts` | config preparation helper 改到新 acquisition root；该 test-only dependency 不进入 artifact |
| acquisition source/tests | 整体移动；fixture URL 的相对深度按新 root 修正；测试数量和 assertions 不降低 |
| `scripts/audit-relay-extension-artifact.mjs` | generic acquisition emitted import 从 `dist/extensions/acquisition/index.js` 改为 `dist/extension-acquisition/index.js` |
| `scripts/build-relay-extension-artifact.mjs` | `dist/extensions/copilot-relay-provider`、`src/extensions/copilot-relay-provider/extension.json` 与 `dist/extension-artifacts/copilot-relay-provider` 保持不变；这些是 concrete Relay inputs，不是 acquisition path |
| FT-06 | loader exact path 改为 `src/extension-acquisition/loader.ts`；Runtime forbidden dependency 改为新 acquisition root；Host generic/no-Relay assertions 保持 |
| FT-08 surface | acquisition contracts 全部改到新 root；`ExtensionLoadContext`、`ExternalExtensionModule` 的 source 精确改为 `src/extension-acquisition/contracts.ts`；其他 Descriptor/config/result contracts 保持在 `types.ts` 或原职责文件 |
| FT-08 inventory | source、positive、negative paths 全部迁移到新 root；测试角色和正反证数量不降低 |
| FT-12 surface | Configuration topic 的 owned module 从 `src/extensions/acquisition` 改为 `src/extension-acquisition`；Relay 仍由 Provider topic拥有 |
| FT-12 module enumeration | `currentSourceModules()` 显式纳入顶层 `src/extension-acquisition`；不得把全部 `src/extensions` 当作 acquisition authority |
| FT-13 | required roots 增加新 acquisition `index.ts` 与 `contracts.ts`；removed roots 检查旧 acquisition `index.ts`、`types.ts`；production/scripts forbidden-path scan 增加 `extensions/acquisition` |
| Current Architecture | overview module map、Configuration/Acquisition topic source/evidence links和 active ownership metadata 改到新 root |

Executable stale-path audit 至少覆盖 `src/`、`scripts/`、`clients/`、root build/config files 和 active Current Architecture/Fitness metadata。已完成交付文档中的历史 locator 可以保留；任何仍可点击的 active evidence link 必须解析，任何可执行 import/command 不得保留旧 root。

## 10. Build Independence Decision

Source relocation、internal contract ownership、Core/Host build independence 与 formal Host deployment artifact 是四个独立决策。项目所有者已选择以下 **B2**：

### B1 — Layout only

- 只迁移 source；
- 保持现有 aggregate `npm run build`；
- 用 static/Fitness evidence 证明 Host source graph 不 import concrete Extension。

后果：成本最低，但 concrete `src/extensions/` 不存在时没有第一方 build 命令可以完整证明 Host closure 可编译；不足以完全满足本次动机。

### B2 — First-class Host/Core build（推荐）

- 保持 `npm run build` 为当前 repository aggregate build，继续构建和审计仓库内声明的 Relay artifact；
- 新增 `tsconfig.host.json`：继承当前 compiler policy，以 `scripts/server.ts` 为唯一 root entry、`rootDir` 为 repository root、`outDir` 为 `dist/host`，关闭 declaration/declarationMap，并让 TypeScript 只沿静态 import graph 纳入 Host、acquisition、Runtime/Core/Adapters/Platform 和 runtime-modules；
- 新增 `npm run build:host`：只清理 `dist/host` 后执行 `tsc -p tsconfig.host.json`；不调用 Relay artifact build/audit；
- 新增 `npm run verify:host-build`：审计 emitted file set 必须包含 `dist/host/scripts/server.js` 与 `dist/host/src/extension-acquisition/index.js`，且不得包含 `dist/host/src/extensions/**`、测试、fixture 或 concrete Extension identity；同时检查 emitted relative import 全部解析在 `dist/host` 内；允许 `node:` builtin imports，以及 package root 已列于 root `package.json.dependencies` 的 package/subpath import，拒绝只在 `devDependencies` 或未声明的 runtime package；
- build/closure test 从 `tsconfig.host.json` 的唯一 root 与 TypeScript emitted file list 证明 concrete Extension 不属于 Host compile graph；无需临时重命名用户 source tree；
- aggregate build、Relay artifact build 和 Host smoke 继续作为 repository delivery evidence。

后果：兼容现有稳定 build 语义，同时对“零 concrete Extension 时 Host/Core 仍可构建”提供可执行、可审计证据。`dist/host` 是 compiled Host module tree，不承诺包含 `node_modules`、workspace state、launcher 或 relocation support，因此不等于 self-contained deployment artifact。

### B3 — Change default build semantics

- 将 `npm run build` 改为 Host/Core-only；
- 另设 aggregate/bundled-extensions build。

后果：最直接，但改变 Development Workflow 所引用的稳定 build 语义，也可能让默认 CI 不再构建 Relay。除非 owner 明确要求，否则本 Spec 不推荐。

### Formal Host deployment artifact（Deferred）

把 `scripts/server.ts`、acquisition、Runtime/Core/Adapters/Platform 与 runtime package dependencies 组装成可从 repository 外启动的正式 Host artifact，需要独立决定 output root、Node package closure、external dependencies、source map、launcher、relocation audit 和是否 bundling。本 Spec 不实施该交付系统。

## 11. Compatibility and Documentation

- Source import compatibility：无；旧 path 原子删除；
- Runtime/API compatibility：`createExtension()`、`LoadedRuntimeUnit`、acquisition result 与 diagnostics shape 不变；
- Filesystem compatibility：Agent Home、config 和 Descriptor path 不变；
- Artifact compatibility：Relay seven-file artifact contract 不变；
- Historical A0–A5 narrative 保留为既有交付记录，不为路径同步而例行重写；其中仍作为 active authority/evidence link、可执行命令或推荐入口的引用必须保持有效；
- 新 Spec/Plan记录本次 source-layout rationale、implementation 和 validation；
- 实施时只更新仍是当前权威或主动导航/evidence owner 的 Current Architecture 与 Fitness metadata。

## 12. Acceptance and Validation

### 12.1 Layout and dependency

- [x] `src/extension-acquisition/` 是唯一 acquisition source root；
- [x] `src/extensions/acquisition/` 不存在，且无 compatibility alias/re-export；
- [x] `contracts.ts` 只拥有两个 entry contracts；
- [x] `types.ts` 不再拥有 entry contracts；
- [x] concrete Extension production code不 import acquisition implementation；
- [x] Host/Runtime/Core 不 import具体 Extension；
- [x] Runtime 不 import acquisition。

### 12.2 Behavior

- [x] acquisition existing unit/contract tests 全部通过且不降低 assertion；
- [x] generic acquisition -> Runtime staging -> immutable typed Catalog integration 通过；
- [x] invalid neighbor、disabled Extension 与 builtin continuity evidence 保持；
- [x] Relay artifact relocation/repository-independence 与 supported Host smoke 通过；
- [x] acquisition、Runtime lifecycle 和 structural error authority 仍各自唯一。

### 12.3 Build and governance

- [x] §10 build decision 已由 owner 明确选择；
- [x] 选择 B2 时，zero-concrete-extension Host/Core compile evidence 通过；
- [x] 选择 B2 时，`build:host` emitted closure 包含 acquisition 且不包含 `src/extensions/**` 对应输出，`verify:host-build` 通过；
- [x] Relay artifact audit 从新的 emitted acquisition path 加载，并继续通过 relocation/repository-independence evidence；
- [x] FT-06、FT-08、FT-12 和 source-layout Fitness 通过；
- [x] Current Architecture module inventory、topic ownership 和 evidence links 更新；
- [x] `npm run lint`、full `npm test`、aggregate `npm run build`、Relay audits、Host smoke 与 `git diff --check` 通过；
- [x] independent review PASS，无 unresolved Critical/High/Medium finding；
- [x] owner acceptance 后才标记实施完成。

## 13. Risks

| Risk | Control |
|---|---|
| 新路径与旧路径同时存在形成双 authority | 原子迁移；Fitness 禁止旧 root；无 compatibility barrel |
| `contracts.ts` 演变为未设计的 Public SDK | 只允许两个既有 type-only shape；新增 capability 必须另行设计 |
| 名称暗示 acquisition 拥有 Runtime lifecycle | Current Architecture 与 dependency guard继续锁定 Runtime authority |
| 目录移动被误称为 zero-extension build 完成 | §10 将 source graph、build target 与 deployment artifact 分开验证 |
| 默认 build 不再覆盖 Relay | 推荐 B2 保持 aggregate `npm run build` 不变 |
| 路径更新污染历史文档 | 只更新 active authority/evidence；历史交付记录不做例子式同步 |

## 14. Open Questions

1. **Build contract：** B2 已选择；B1、B3 rejected for this Delivery。
2. **Delivery completion：** L1–L3 已授权、实施、验证并由 owner 接受；Spec/Plan 已标记 Validated/Completed。

除上述两项外，无需 Spike：目录移动、TypeScript type erasure、当前 import graph、build script hardcoded Relay input 和 Fitness path ownership 均已由现有代码直接验证。

**Draft validation record（2026-09-14）：** FT-09/FT-11/FT-12 documentation governance 18/18 passed，`git diff --check` passed；independent design review 核对 B+ definition、B2 executable contract、Relay audit path、FT-06/08/12/13 exact impact、internal contract wording、historical narrative policy 与 C4 exclusion 后 overall PASS，无 unresolved Critical/High/Medium design blocker。项目所有者随后接受 Spec/Plan、选择 B2 并授权 L1–L3；该 design acceptance 不替代 implementation validation 和 owner completion acceptance。
