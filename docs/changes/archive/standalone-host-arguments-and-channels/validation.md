# Standalone Host Arguments and Channels Validation

> Status: Implemented and Validated
> Date: 2026-09-17
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Contract: [Specification](standalone-host-arguments-and-channels-specification.md)

## 1. Gate policy

Planned checks are not reported as passing. Delivery begins only after ADR-013, the Plan, and the Specification are accepted. Focused checks follow the first production edit; full regression, lint, clean build, environment verification, authority transfer, and independent review are final-Gate obligations.

## 2. Implementation evidence

| Observation | Evidence |
|---|---|
| Runtime supports multiple Channels | Registry Channel projections are arrays; Runtime Unit lifecycle stages and starts every accepted Channel contribution; Turn generations capture all bindings |
| Standalone accepts a Channel set | `parseStandaloneHostArguments()` returns one frozen canonical list and `createBuiltinHostUnits()` emits zero to two fixed Builtin Units |
| Global config is Host-neutral | Platform types/loader expose only frozen Application and Extension projections and reject top-level `host` |
| Omitted selection is WebSocket | Missing `-bc`/`--builtin-channels` resolves to frozen `['websocket']` |
| CLI has terminal ownership constraints | Standalone rejects any CLI selection when Console Logger is enabled before acquisition/Runtime creation |
| Multi-Channel routing is already defined | Runtime fans out Agent events to captured bindings while interactions remain origin-bound |

## 3. Planned evidence matrix

| Boundary | Evidence | Status |
|---|---|---|
| Argument grammar | 53 Standalone Host tests cover short/long split, long equals, omission, ordering, missing/blank values, duplicates, `none`, unknowns, case, comma grammar, and `-ah` | Passed |
| Global configuration | 31 loader tests prove only Application and Extension projections and direct `host` rejection | Passed |
| Unit selection | Host tests cover every set and canonical Unit order with fixed constructor constants | Passed |
| Composition conflict | CLI plus Console Logger fails before acquisition/Runtime; WebSocket/none remain compatible | Passed |
| Liveness | Host tests cover WebSocket-only, CLI-only, both, and none | Passed |
| Failure policy | Controlling failure sets exit 1 and shuts down; secondary CLI failure is consumed, warns, and leaves WebSocket active | Passed |
| Runtime preservation | Complete Unit and Integration suites, including existing multi-Channel lifecycle, Fanout, interaction, and shutdown coverage | Passed |
| Package behavior | Installed `{}` default fixed WebSocket start, explicit `none` forwarding, legacy-`host` rejection, and Relay/WebSocket Turn smoke | Passed |
| Authority | Stable Configuration/Standalone Host Specifications; Current Configuration/Channels/Extensions/Providers; README; Fitness baseline; source tests; package scripts; links and residual scan | Passed |
| Final Gate | `npm run lint`; clean `npm run build`; Integration 17/17; Fitness 38/38 after baseline correction; full regression 1,084/1,084; package/WebSocket checks; diagnostics; `git diff --check`; independent review | Passed |

## 4. Known risks

- A detached secondary-completion observer must not create unhandled rejections or keep the process alive independently.
- CLI terminal ownership still requires Console Logger exclusion whenever CLI is selected.
- Removing Host settings intentionally makes current bind/prompt values fixed; adding configurable Host settings later requires a separate Host-neutral configuration decision.
- `none` disables only Builtin Channels and waits on process signal or explicit `RuntimeHost.shutdown()`; arbitrary Extension Channel completion is not a Host lifetime trigger.

## 5. Design review

The independent review found no Critical or Low issue. Two High and three Medium observations were accepted and resolved before owner acceptance: secondary CLI startup failure now follows the explicit secondary policy; `none` lifetime no longer implies arbitrary External Channel completion; CLI examples state the Console Logger prerequisite; package migration explicitly covers default, explicit, and retired inputs; and the maintained authority/residual inventory is named. Historical archives remain out of synchronization scope.

The post-implementation independent review found no Critical, High, or Medium issue. Its two Low documentation-status observations were resolved by completing this record and the Change index before archive.

Follow [Development Workflow](../../../governance/development-workflow.md).
