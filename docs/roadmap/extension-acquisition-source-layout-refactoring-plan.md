# Extension Acquisition Source Layout Refactoring Plan

## 1. 文档状态

- **状态：** Completed；L1–L3 owner accepted
- **版本：** 0.1
- **日期：** 2026-09-14
- **所有者：** 项目所有者
- **类型：** Extension Acquisition and Configuration post-delivery update
- **关联 Spec：** [Extension Acquisition Source Layout Refactoring Spec](../architecture/extension-acquisition-source-layout-refactoring-spec.md)
- **控制决策：** [ADR-005 Extension/Module/Registry Composition 与 Runtime Lifecycle](../architecture/adr-005-extension-registry-runtime-composition.md)
- **工作流：** [Development Workflow](../development-workflow.md)

项目所有者于 2026-09-14 选择 B+ layout direction：顶层 acquisition module 内以 `contracts.ts` 和 `types.ts` 分离 entry contract 与 acquisition data types。Draft validation 与 independent design review PASS 后，项目所有者接受本 Plan/Spec、选择 B2 first-class Host/Core build，并授权 L1–L3 Delivery。

项目所有者于 2026-09-14 接受 B+ / B2 implementation、全部 validation evidence 与 independent implementation review；L1–L3 Delivery 完成。

本 Plan 是已完成 [Extension Acquisition and Configuration Delivery Plan](extension-acquisition-delivery-plan.md) 之后的同一 Extension capability update。它使用独立工件记录 source-layout/build-boundary 重构，但不建立新的 Extension system，也不回写或重新打开 A0–A5。Provider Model Catalog C4 不属于本 Plan，仍未授权。

## 2. Outcome

- Host 必需的 Extension acquisition source 不再位于可选 concrete Extensions 父目录；
- acquisition 保持 generic，并继续只输出尚未创建的 `LoadedRuntimeUnit[]`；
- 两个既有 Extension entry contracts 在 acquisition module 内有独立文件 ownership，但不建立 Public SDK；
- concrete Extensions 可以从 Host source graph 中完全缺席；
- owner 选择 build contract 后，以可执行 evidence 明确 zero-concrete-extension 的构建保证；
- Runtime lifecycle、Registry、Agent Home、Host config、Relay artifact 和 C4 语义不变。

## 3. Non-goals

- Public Extension SDK/package；
- Runtime/Registry/lifecycle 重构；
- Marketplace、installer、update、sandbox、watcher 或 hot reload；
- Relay behavior、Model Catalog 或 C4；
- 完整 self-contained Host deployment artifact；
- 例行重写已完成的 A0–A5 历史交付记录。

## 4. Delivery Items

### L0 — Design acceptance

**状态：** Completed

- 接受 B+ module layout、contract ownership、dependency direction 和 no-compatibility migration；
- owner 决定 Spec §10 的 B1/B2/B3 build contract；
- Spec 与 Plan 达到 Development Workflow Definition of Ready；
- owner 单独授权 L1–L3 Delivery。

**Exit：** Spec `Accepted`、Plan `Accepted`，build decision 与 delivery authorization 有记录。

**Design review evidence：** Draft governance FT-09/FT-11/FT-12 18/18 passed；independent design review overall PASS，无 unresolved Critical/High/Medium blocker。项目所有者接受 Spec/Plan、选择 B2 并授权 L1–L3。

### L1 — Atomic source relocation

**状态：** Completed

- 将 acquisition 提升为唯一顶层 source module；
- 新增内部 `contracts.ts` 并迁移两个 entry contracts；
- 更新 Host、Relay type-only import 与 tests；
- 删除旧 root，不保留 alias/re-export；
- 立即运行 acquisition、Host startup 与 Relay entry focused tests。

**Exit：** 新 root 可编译；旧 root 和旧 import 为零；focused behavior 不变。

### L2 — Build and authority evidence

**状态：** Completed

- 按 owner 选择实施 build contract；
- 更新 Relay artifact audit 的 emitted acquisition path；
- 更新 FT-06、FT-08 contract surface/inventory、FT-12 module surface/inventory 和 FT-13（或同等级）source-layout guard；
- 选择 B2 时新增 `tsconfig.host.json`、`build:host`、`verify:host-build` 和 emitted closure evidence；
- 更新 Current Architecture module map、topic owner 和 evidence links；
- 不修改历史 A0–A5 文档，除非发现仍由其主动导航的 current authority link。

**Exit：** source、build 与 documentation authority 对新边界只有一个一致解释。

### L3 — Cumulative closeout

**状态：** Completed（owner accepted 2026-09-14）

- focused acquisition/Host/Relay tests；
- Contract/Integration/Fitness regressions；
- lint、full tests、aggregate build、Relay audits、supported Host smoke、diff check；
- independent read-only review；
- owner acceptance。

**Exit：** 无 unresolved Critical/High/Medium finding；owner 接受后 L1–L3 标记 Completed。

**Validation evidence：** focused acquisition/Host/Relay 77/77；governed implementation surfaces 18/18，并在 FT-01 classification 补全后 FT-01/06/08/12/13 16/16；`npm run lint`；full terminal Node 22 Vitest 109 files / 1027 tests；aggregate build 与 Relay audits；clean `build:host` + `verify:host-build`（141-file closure）；supported WebSocket Host smoke；`git diff --check`。Independent implementation review overall PASS，无 Critical/High/Medium/Low finding；owner completion acceptance 已取得。

## 5. Gates

- L0 未完成前不得修改 production source；
- 新 evidence 若要求 Public SDK、第二条 Runtime path、default build coverage 降级、完整 Host artifact 或 concrete Extension fallback，停止并回到 owner；
- source relocation 必须删除旧路径，不允许 compatibility window；
- build target 必须明确区分 Host/Core compile、repository aggregate build 与 formal deployment artifact；
- C4 不因本重构获得授权。

## 6. Validation Matrix

| Area | Required evidence |
|---|---|
| Contract ownership | `contracts.ts` exact surface；no runtime import in Relay artifact |
| Source layout | old root absent；new root unique；no stale imports |
| Acquisition behavior | existing discovery/configuration/loader/Agent Home/Host config suites |
| Runtime integration | acquisition -> Runtime -> immutable typed Catalog |
| Host isolation | no concrete Extension import/ID/env/fallback |
| Build | owner-selected zero-extension evidence + aggregate build |
| Artifact | seven-file Relay closure/relocation/repository-independence audits |
| Governance | FT-06、FT-08、FT-12、document links、diff check |
| Broad regression | lint、full Vitest、supported Host WebSocket smoke |
| Review | independent final review + owner acceptance |

## 7. Risks and Rollback

- 路径 churn：通过原子移动、exact path search 与 Fitness 控制；
- 双 authority：旧路径不保留 compatibility；
- build 语义漂移：L0 先冻结 B1/B2/B3；
- SDK 过度设计：只迁移两个既有 entry types；
- rollback：整体版本回滚，不在 production 同时恢复旧/新 root。

## 8. Open Decisions

1. **Build contract：** B2 first-class Host/Core build 已选择；B1/B3 不用于本次 Delivery。
2. **Delivery completion：** L1–L3 已授权、实施、验证并由 owner 接受。
