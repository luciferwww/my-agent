# Extension Acquisition and Configuration Module Spec

## 1. 状态

- **状态：** Draft
- **版本：** 0.3
- **日期：** 2026-09-11
- **所有者：** 项目所有者
- **关联计划：** 独立 Delivery Plan Item 待本 Spec 进入评审前建立；不属于 Provider Model Catalog Plan 的 C3/C4
- **关联决策：** [ADR-005 Extension/Module/Registry Composition 与 Runtime Lifecycle](adr-005-extension-registry-runtime-composition.md)
- **关联错误边界：** [Model Invocation Error Boundary Amendment](model-invocation-error-boundary-amendment.md)（Accepted）
- **目标输入：** [Target Architecture §6](target-architecture.md#6-extensionmodulecontribution-and-registry)、[AF-06 Extension Framework Spike Results](af-06-extension-framework-spike-results.md)
- **当前事实：** [Runtime Current Architecture](current/runtime.md)、[Platform Config Current Architecture](current/platform_config.md)、[Model Invocation and Provider Adapter Current Architecture](current/adapter_llm.md)
- **语言与术语约定：** [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)
- **工作流：** [Development Workflow](../development-workflow.md)

本文档是供项目所有者关闭设计决策的 `Draft for decision review`，不是可直接执行的 Contract。`Draft` 不改变当前生产行为，不授权实现、依赖变更、Extension 安装、动态代码执行或 C4。§14 所列关联 Contract 与 evidence gates 未关闭前不得把本文档提升为 `In Review`。当前唯一受支持 Host 仍按 Current Architecture 直接组合 Copilot Relay；只有本 Spec 后续达到 `Accepted`、关联 Plan Item 达到 Ready 且项目所有者单独授权 Delivery 后，才能迁移该路径。

项目所有者于 2026-09-11 决定不建立独立 `<agent-home>/extensions.json`；machine/Host-level 配置统一位于 `<agent-home>/config.json`，Extension 使用其中的 `extensions.entries.<id>` namespace。该决定关闭物理配置来源问题，但不接受本 Spec 的其他 Draft contract。

项目所有者于 2026-09-11 决定 Agent Home 按 explicit Host `--agent-home` option、`MY_AGENT_HOME`、`<user-home>/.my-agent` 的优先级解析。该决定关闭 Agent Home resolution 问题；它不授权 Host CLI 或 production loader 实现。

项目所有者于 2026-09-11 决定安装目录名只是非语义 filesystem locator；`extension.json.id` 是唯一 Extension identity、配置 namespace 与 External 排序依据。重复 ID 的全部候选隔离，目录重命名不得改变结果。该决定同步修订 [Target Architecture v1.5](target-architecture.md)。

项目所有者于 2026-09-11 决定 Extension config Schema 使用 JSON Schema Draft-07 与当前 Ajv dependency。Host 在 scoped config 的隔离副本上应用静态 defaults，执行 strict validation，不转换类型、不删除未知字段，也不解析 Descriptor 外部 `$ref`。该决定关闭 Schema dialect/defaults 问题。

项目所有者于 2026-09-11 决定 `createExtension()` 保持同步、无外部 side effect，只接收 validated/frozen scoped config，不接收 Descriptor、Extension ID、版本或安装 locator。Extension 返回现有 `LoadedRuntimeUnit`，Loader 对照 Descriptor ID 校验 Unit metadata；所有 I/O 和有生命周期资源延迟到 `unit.create(signal)`。该决定关闭 Entry factory 问题。

项目所有者于 2026-09-11 暂定跨 Extension 错误采用分阶段混合方案：短期兼容 Host canonical Error class 与经运行时校验的 versioned structural error protocol，长期以结构协议作为唯一跨 Extension 权威，Error class 只保留为 Host 内部表示。第一版不建立独立公共 Extension SDK/package，也不要求 External Extension 运行时共享 Host class identity；未来 SDK 只能封装既有结构协议，不能成为第二个错误语义权威。该方向不在本文档中冻结具体 Model Invocation error shape，后者必须由关联 Model Invocation Contract 单独接受后才能实施。

项目所有者于 2026-09-11 决定第一版 Relay installation artifact 由 repository build 生成封闭、可重定位的多文件 ESM 目录。构建不写 Agent Home；部署方在 Host 停止时把完整 artifact 目录复制/替换到规范 discovery root。artifact 不依赖 npm install、bundler、Host-relative runtime import 或共享 Error constructor，也不包含测试、声明、source map、Host Core 文件或其他无关输出。该决定关闭 Relay installation artifact 问题，但不建立 Marketplace、安装器或公共 npm package。

项目所有者于 2026-09-11 决定第一版 startup diagnostics 使用“结构化结果/事件 + Host operator presentation”：acquisition diagnostics 由 `ExtensionAcquisitionResult` 返回，Unit lifecycle diagnostics 由 Runtime 通过既有 warning event surface 发出；supported executable Host 必须将两者以 bounded、redacted warning 投影给机器操作者/Host integrator。日志/终端文本不是第二权威，普通远程 Channel/browser 用户默认不可见；第一版不增加 Channel capability、WebSocket payload 或 durable `RuntimeHandle.startupReport`。该决定关闭 startup diagnostics surface 问题。

## 2. Purpose

建立一个位于 Host 与 Runtime Composition 之间的通用 Extension acquisition/configuration boundary，使 Host 无需在开发期知道未来将安装哪些 Provider、Channel、Tool 或 Hook Extension，也不需要包含任何 Extension-specific import、环境变量名或配置分支。

该模块将已安装、被显式启用且配置有效的 Extension 转换为确定性的 `LoadedRuntimeUnit[]`。Runtime、Registry、Runner、Model Resolver 和 Channel 继续只消费现有 Unit/Contribution/typed projection，不知道 Extension 的发现、配置和加载来源。

用户可观察结果：安装一个符合 Contract 的 External Extension、在 Host Extension 配置中显式启用并重启 Host 后，该 Extension 的 Contributions 通过现有 Registry generation 发布；移除或禁用后，下次启动不再发布。新增 Extension 不要求修改 Host、Runtime 或 Runner 的 Extension-specific 代码。

## 3. Scope

- 解析一个已确定的 Agent Home，并只从 `<agent-home>/extensions` 发现 External Extension；
- 静态读取和校验每个直接子目录中的 `extension.json`，不先执行 Extension code；
- 建立确定性的候选顺序、duplicate identity 处理和结构化 acquisition diagnostics；
- 读取独立的 Host Extension 配置，并按 Extension ID 提供隔离的 scoped config；
- 将启用状态与配置存在性分离；
- 通用 materialize environment value reference 和 environment-backed SecretRef；
- 在 import entry 前，以 Descriptor 声明的 JSON Schema 校验 materialized scoped config；
- 动态加载已通过静态检查、被显式启用且配置有效的 ESM entry；
- 将 entry 产物校验并投影为现有 `LoadedRuntimeUnit`，交给唯一 Runtime Unit Catalog/Registry path；
- 将当前 Copilot Relay 的 Host-specific acquisition 迁移到该通用路径，并删除其 Host-specific import/env wiring；
- 由 repository build 生成可整体部署到 Agent Home 的封闭 Relay ESM artifact；
- 为 discovery、Descriptor、enablement、config、secret redaction、entry loading 和迁移提供 Contract/Integration/Fitness evidence。

## 4. Non-goals

- Marketplace、远程搜索、下载、安装器、自动升级、签名或发布格式；
- 构建时直接修改 Agent Home、Host 运行期间覆盖安装目录或为 artifact 提供 package manager install；
- filesystem watcher、运行中重新扫描、热加载、代码替换或同 identity 多版本并存；
- 重新定义现有 Runtime Unit enable/disable、Registry generation、Turn pin、retirement 或 Shutdown；
- 新建第二条 Extension registration、Provider registration 或 lifecycle path；
- 把 CLI/WebSocket 等 Host transport 一并改成动态 Extension；第一版 WebSocket Host 可以静态拥有自己的 WebSocket Channel；
- sandbox、权限隔离或不受信任代码执行；进程内 Extension 与 Host 拥有相同 Node.js 权限；
- file/exec/remote Secret provider、Secret rotation 或完整 credential manager；
- 把第三方 Extension 字段加入中央 `AgentDefaults` union；
- Extension dependency package installation、npm resolution 或 TypeScript runtime transpilation；
- 建立独立公共 Extension SDK/package、peer-dependency/alias resolution 或依赖共享 class identity 的 runtime contract；
- 修改 Provider Model Catalog、opaque Model ID 或 C3 Channel contract。

## 5. 当前 Baseline 与问题

当前 Runtime 已接受调用方提供的 `RuntimeAppOptions.loadedUnits`，并通过统一 `RuntimeUnitCatalog`、registration staging、immutable Registry generation 和 instance lifecycle 处理它们。该路径是本 Slice 必须复用的 production boundary。

当前 [supported WebSocket Host](../../scripts/server.ts) 同时承担了 Host lifecycle 和 Relay-specific acquisition：它直接 import Copilot Relay factory、读取 `COPILOT_RELAY_BASE_URL` / `COPILOT_RELAY_API_KEY`，构造 Relay Unit 后传入 `loadedUnits`。这能完成 C2 的 in-repo 过渡接入，但意味着 Host 预先知道具体 Extension，不满足通用 plug-in/out 目标。

当前 workspace 配置位于 `<workspace>/.agent/config.json`，中央 `AgentDefaults` 由 Configuration 读取、合并并交给 Runtime。它描述 Agent 行为，不是 machine/Host-level Extension installation authority；把任意第三方配置并入该类型会使中央 Config 永久知道第三方字段。

本 Spec 不否定 C2 的已接受交付。它定义后续删除该过渡 acquisition 的条件，并保持 Runtime 下游 Contract 不变。

## 6. Boundaries and Dependencies

### 6.1 Ownership

| 模块 | 拥有 | 不拥有 |
|---|---|---|
| Host | Agent Home 输入、进程环境、Host Extension config source、启动/退出、静态 Host Channel | 具体 Extension ID、业务配置字段、Provider factory |
| Extension Discovery | 规范安装根、direct-child 枚举、Descriptor 静态校验、候选顺序 | entry execution、Registry mutation、安装/下载 |
| Extension Configuration | enablement、namespace lookup、value/SecretRef materialization、Schema validation、redacted diagnostics | Extension 业务语义、全局 Agent Config、Runtime state |
| Extension Loader | 受控 ESM import、entry export 校验、Unit metadata validation | Unit start、Registry registration、Extension 私有资源关闭 |
| Extension | Descriptor/Schema、scoped config 语义、factory、Contributions、私有资源 | 全局 Config、其他 Extension namespace、Runtime private state |
| Runtime Composition | Unit catalog、create/start/staging/publish/retire/stop | Extension discovery/config 文件、具体 Extension 分支 |

### 6.2 允许的依赖方向

```text
Host
  -> Agent Home / Host Extension Config loader
  -> Extension Discovery
  -> Extension Configuration
  -> Extension Loader
  -> Runtime Composition Entry(LoadedRuntimeUnit[] + static Host units)
  -> Runtime Builder / RuntimeApp

External Extension entry
  -> public Extension acquisition contract
  -> existing Core Contribution contracts
  -> LoadedRuntimeUnit factory surface
```

禁止：

- Runtime、Runner 或 Registry import 具体 External Extension；
- Host import `src/extensions/<specific-extension>/**`；
- Loader 根据 Extension ID 执行 `if`/`switch` 业务分支；
- Extension 取得 `RuntimeApp`、mutable Registry、Service Locator 或整个 `AgentDefaults`；
- Loader 直接调用 Unit `create()`、`start()`、`stop()` 或 registration；这些仍由 Runtime Composition 拥有；
- Extension entry 直接修改共享 Registry 或返回已启动资源。

## 7. Public Contract

以下 TypeScript shape 是未接受的 Draft review target，只用于关闭公共边界决策；不得在 §15 blocking decisions 关闭前据此实施。实现前可在不改变后续已接受语义边界的前提下调整命名。

### 7.1 Descriptor

每个候选目录必须包含一个 UTF-8 JSON `extension.json`：

```ts
interface ExtensionDescriptorV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly configSchema: Readonly<Record<string, unknown>>;
}
```

规则：

- `id` 使用系统拥有的 Runtime Unit identity grammar `[A-Za-z0-9_-]{1,64}`；
- 安装目录名不要求等于 `id`，也不参与 identity、namespace、排序或冲突裁决；
- `version` 是非空、用于诊断的 Extension 版本；第一版不做版本求解；
- `entry` 必须是安装目录内的相对 `.js` ESM 文件，不允许 absolute path、`..`、URL、目录入口或逃逸后的 real path；
- `configSchema` 必须显式声明 `"$schema": "http://json-schema.org/draft-07/schema#"`，并可由当前 Ajv Draft-07入口在 strict mode 编译；
- Schema 根必须声明 `"type": "object"` 和 `"additionalProperties": false`；缺失任一声明均为 Descriptor invalid，不依赖 JSON Schema 默认行为；
- `$ref` 只允许 `#` 开头的 Descriptor 内部 JSON Pointer，并使用 Draft-07 `definitions` 表达可复用定义；拒绝 HTTP(S)、file URL、相对文件和其他外部 Schema reference；
- Descriptor 未通过静态校验时 entry execution count 必须为零；
- Descriptor 不包含运行期 config value、secret value、Contribution 列表或私有资源描述。

第一版不承诺 `extension.json` 为可跨产品使用的 marketplace/package manifest。`manifestVersion` 只版本化本 Host loader contract。

### 7.2 Host config 与 Extension namespace

`<agent-home>/config.json` 是统一的 machine/Host-level 配置文件；Extension 配置位于其 `extensions` 顶层 namespace。它与 workspace `<workspace>/.agent/config.json` 中的 `AgentDefaults` 分离：前者拥有安装、启用和 Extension scoped deployment inputs，后者拥有 Agent 行为与默认 Model Reference。不得创建并行的 `<agent-home>/extensions.json`。

```ts
interface HostConfig {
  readonly extensions?: Readonly<{
    readonly enabled?: boolean;
    readonly entries?: Readonly<Record<string, {
      readonly enabled?: boolean;
      readonly config?: Readonly<Record<string, unknown>>;
    }>>;
  }>;
}
```

示例：

```json
{
  "extensions": {
    "enabled": true,
    "entries": {
      "copilot-relay-provider": {
        "enabled": true,
        "config": {
          "baseURL": { "$env": "COPILOT_RELAY_BASE_URL" },
          "apiKey": { "$secret": { "source": "env", "name": "COPILOT_RELAY_API_KEY" } }
        }
      }
    }
  }
}
```

`extensions.entries.<id>.config` 是唯一交给对应 Extension 的 namespace。Host/central Config 不解释 `baseURL`、`apiKey` 等业务字段。未来 machine-level Host 设置可加入同一文件的其他顶层 namespace，但不得借此把 Extension 私有字段提升为中央 typed union。

### 7.3 Agent Home resolution

Agent Home 是 machine/Host-level installation 与配置根，不是 workspace，也不依赖当前工作目录。解析优先级固定为：

1. explicit Host `--agent-home <path>` option；
2. `MY_AGENT_HOME` environment variable；
3. `join(os.homedir(), '.my-agent')`。

显式 option 或 environment value 可以使用 `~` 表示用户主目录；展开后必须是 absolute path，blank 或 relative value 是 Host configuration error，不回退到下一来源。解析结果必须 lexical normalize；对已存在路径取得 canonical real path，并以该 canonical root 执行后续 containment 检查。Agent Home 自身可以是部署方有意配置的 symlink/reparse target，但发现根和每个 candidate/entry 的 canonical real path 必须仍位于 canonical Agent Home boundary 内；candidate 自身的 symlink/reparse point 继续按 §11.2 拒绝。

普通 Host startup 不为缺失 Agent Home、`config.json` 或 `extensions` directory 创建文件系统状态。Agent Home 或 `config.json` 不存在等价于 empty Host config，因此无 External Extension 被启用；`extensions` directory 不存在等价于没有已安装 Extension。已存在但 unreadable、malformed 或根结构无效的 `config.json` 是明确 Host startup failure，不能静默回退为空配置。未来 installation command 负责创建所需目录。

### 7.4 Value references

第一版只支持两个 exact tagged object；带额外字段的对象不是 reference：

```ts
type EnvironmentValueRef = Readonly<{ $env: string }>;
type EnvironmentSecretRef = Readonly<{
  $secret: Readonly<{ source: 'env'; name: string }>;
}>;
```

- `$env` 用于非敏感部署值；缺失变量是 configuration error；
- `$secret` 用于敏感值；缺失变量是 configuration error，值不得出现在日志、diagnostic、snapshot 或序列化配置中；
- Configuration 在 Schema validation 前递归 materialize reference；
- 普通字符串不执行 `${...}` interpolation，避免字符串内容被隐式改写；
- 第一版不向 Extension 暴露整个 `process.env`；Extension factory 只收到 materialized namespace；
- 该 API boundary 不是 sandbox，进程内恶意 Extension 仍可自行访问 Node globals。

### 7.5 Extension entry

Entry 必须提供唯一具名导出：

```ts
interface ExtensionLoadContext {
  readonly config: Readonly<Record<string, unknown>>;
}

interface ExternalExtensionModule {
  createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit;
}
```

`createExtension()` 必须是同步、无外部 side effect 的 factory：它只捕获已验证配置并返回尚未 `create()` 的 Unit definition。Context 不包含 Descriptor、Extension ID、版本、安装 locator、Host root config、environment 或 Runtime capability；Extension 不得借由 factory 输入重新解释静态 acquisition facts。需要网络 discovery、SDK client、socket 或其他长期资源时，必须延迟到 `LoadedRuntimeUnit.create(signal)`，以保留现有 cleanup、optional failure isolation 和 lifecycle ownership。

Extension 源码仍需在返回的 Unit 上声明 `unitId`。`extension.json.id` 是 acquisition 权威，Loader 必须要求二者 exact match；该重复是边界一致性断言，不构成第二个 identity authority。第一版不增加由 Loader 注入 ID 的第二套 External Unit Definition。

Loader 必须验证返回值：

- `unitId === descriptor.id`；
- `source === 'external'`；
- `required === false`；
- `initiallyEnabled === true`，因为 disabled entry 根本不执行；
- `orderKey` 由 Loader根据 Descriptor ID 派生并覆盖或验证，不能由 Extension 或安装目录改变冲突优先级；
- `dependencies` 在 v1 必须为空；跨 External Unit dependency、dependency cycle 和 optional dependency 不属于本 Slice，避免 acquisition isolation 与 Runtime Unit Catalog fatal validation 形成不明确的双重所有权；
- factory throw 或 metadata mismatch 形成 whole-unit load failure，不向 Runtime 交付部分结果。

### 7.6 Acquisition result

```ts
interface ExtensionAcquisitionResult {
  readonly loadedUnits: readonly LoadedRuntimeUnit[];
  readonly diagnostics: readonly ExtensionAcquisitionDiagnostic[];
}
```

`loadedUnits` 按 Descriptor ID 派生的确定 orderKey 排列并冻结。Diagnostics 至少区分：`discovery_invalid`、`duplicate_identity`、`disabled`、`config_invalid`、`secret_unavailable`、`entry_load_failed`、`extension_config_rejected` 和 `unit_invalid`，并包含 Extension ID 与 escaped 安装 locator 等非 secret 定位信息。

### 7.7 Cross-Extension error compatibility

External Extension 可独立构建，因此跨 Extension 边界的正确性不得只依赖 `instanceof` 或 Host/Extension 恰好解析到同一个 Error constructor。分阶段 contract 固定为：

- 短期 Host 同时接受自身 module graph 中的 canonical Error class，以及通过严格 runtime parser 验证的 versioned structural error；
- structural error 经验证后由 Host canonicalize 为 Host-owned Error，后续 Runtime logging、classification 和 lifecycle 只消费该本地表示；
- Extension-private Error subclass 是 Extension 实现细节，Host 不 import、不按其 constructor 分支；
- malformed、未知版本或字段不符合约束的对象不得因 `name` 或 message 相似而被误认，应沿用 bounded unknown-error handling；
- 错误结构与 canonicalization 不得回显 credential、prompt、Tool input/result 或其他既有禁止内容；
- 长期 structural protocol 是唯一跨 Extension 权威；canonical Error class 不是 wire/bundle compatibility contract；
- 未来若增加公共 SDK，其类型、builder 或 helper 只能生成同一结构协议；即使 SDK 被重复 bundle，也不能影响 Host 识别结果。

具体 discriminator、版本字段、category、diagnostics schema、cause policy、parser 和 Host canonicalization API 属于 [Model Invocation Error Boundary Amendment](model-invocation-error-boundary-amendment.md)。本文档只冻结 packaging/runtime compatibility 方向，不以示例 shape 替代该 Contract，也不授权修改当前 `ModelInvocationError` 或 Runtime error path。

### 7.8 Relay installation artifact

Repository build 必须在普通 application compilation output 之外生成一个确定的 Relay artifact directory。规范内容为：

```text
<build-output>/extension-artifacts/copilot-relay-provider/
├── extension.json
├── package.json
├── entry.js
└── <Relay-owned production JavaScript dependency closure>
```

- `extension.json` 符合 §7.1，`entry` 指向 `entry.js`；
- `package.json` 只作为 `.js` 的 ESM package-scope marker，不建立独立 npm publication、dependency installation 或 package identity contract；
- `entry.js` 提供 §7.5 的唯一具名 `createExtension()` export；
- production JavaScript 可以是多文件，但每个 runtime import 必须解析在 artifact canonical directory 内；不得以 `../`、absolute path、package lookup 或 symlink/reparse point 取得 Host Core、repository source、`node_modules` 或其他安装内容；
- build 使用显式 production allowlist/dependency closure，排除 `*.test.js`、declaration、source map、source、fixture 和 unrelated Host output；
- 第一版不为此 artifact 引入 bundler。若未来改为单文件 bundle，必须先独立决定 bundler dependency、externalization、source-map、安全审计和 reproducibility policy；
- build 只生成 staging artifact，不读取或写入 Agent Home。部署方在 Host 停止时以完整目录复制/替换；partial overwrite、运行中替换和 symlink-based development installation 不受支持；
- 安装目录建议使用 `copilot-relay-provider` 便于操作，但仍只是 locator；identity 只来自 Descriptor ID；
- 安装后不执行 `npm install`，不下载 dependency，也不要求 Host 提供公共 SDK runtime singleton。

当前 `tsc` 输出保留 Host-relative runtime import 且包含非 production 文件，不能直接充当该 artifact。构建 Contract tests 必须从 fresh/relocated Agent Home 动态加载 artifact，并证明删除 repository/build tree 后仍可完成 Relay discovery、registration 和 invocation。

### 7.9 Startup diagnostics surface

启动包含两个保持 ownership 的结构化诊断阶段：

1. Discovery/Configuration/Loader 在调用 Runtime 前返回 `ExtensionAcquisitionResult.diagnostics`；
2. Runtime Composition 在 Unit `create/start/register` 与 Channel preparation 中产生自己的 startup diagnostics，并通过既有 `RuntimeEvent` warning surface 发给 Host observer。

Host 可以将两阶段诊断汇总展示，但不得回译成同一内部错误体系、写回 Registry 或形成第二条 lifecycle path。第一版 surface 规则为：

- acquisition result 与 Runtime warning event 分别是其阶段的机器可读权威；stderr/logger 文本只是 Host-owned projection；
- supported executable Host 必须为每个显式启用但未成功加载/启动的 Extension 输出至少一个可定位 warning；Host integrator 可直接消费结构化 result/event；
- `disabled` 等预期非执行状态可保留在结构化 acquisition result 中，但默认不作为 operator warning；stale configured ID、invalid config、missing secret、entry/factory failure 和 Unit lifecycle failure 必须可见；
- Runtime 不得继续只转发 `CHANNEL_*` diagnostics；optional Unit create/registration conflict 等 degraded startup 也必须产生稳定 warning code、`unitId` 和适用的 contribution/phase 字段；
- fatal Host config 或 required Runtime startup failure继续 reject，不降级为 warning；
- warning payload 必须稳定排序、bounded、redacted，不含 raw Error、stack、materialized config/secret、credential、prompt、Tool input/result、完整 Provider response 或任意 Extension metadata；Extension throw message 只能经 Host-owned sanitizer 后进入 operator projection；
- 普通远程 Channel/browser 用户默认不可见 installation locator、config path 和 startup details；第一版不新增 Channel capability、WebSocket message 或 client UI；
- 第一版不新增可在启动后查询的 `RuntimeHandle.startupReport`。若未来出现 durable programmatic query consumer，应以独立 additive Runtime Contract 决定 retention、reload generation 和 access-control semantics。

## 8. Behavior

### 8.1 Startup flow

1. Host 解析 Agent Home，并读取 `<agent-home>/config.json` 的 `extensions` namespace，同时安装 acquisition diagnostic observer；
2. root `enabled` 缺失等价于 `true`，它只作为 global kill switch；若为 `false`，返回空 External Unit 集合且不扫描、不 import；
3. Discovery 只枚举 `<agent-home>/extensions` 的 direct-child directories；
4. 静态有效候选按 Descriptor ID 分组；安装目录名和原始 filesystem enumeration order 无效；
5. 静态读取/校验 Descriptor、entry containment 和 Schema compilation；
6. 同一 Descriptor ID 的多个候选全部隔离且不执行 entry；其余唯一候选按 Descriptor ID code-unit ascending 形成确定顺序；
7. 查找 `entries[descriptor.id]`。entry `enabled` 缺失等价于 `false`；只有 entry 的显式 `enabled === true` 才继续，config 存在本身不启用；
8. 递归 materialize该 namespace 内的通用 references，并用 Descriptor Schema 校验；
9. 动态 import entry，调用 `createExtension({ config })`，校验返回 Unit；
10. Loader 完成全部候选后冻结 `loadedUnits` 和 diagnostics；Host 保存结构化 acquisition result，并将 actionable diagnostics 投影给 operator；
11. Host 将 External Units 与自身静态 Channel Unit 一起交给 authoritative Runtime Composition entry，并订阅 startup warning event；当前 API 形状可映射为 `RuntimeAppOptions.loadedUnits`，但 Host 不构建 `RuntimeUnitCatalog`、不 staging、不 start Unit；
12. Runtime Builder 按现有唯一路径建立 Unit Catalog 并执行 create、registration staging、start、publish 和失败清理，`RuntimeApp` 不形成第二个 External composition path；Runtime degraded diagnostics 经 warning event 返回 Host；
13. Host 以同一 redacted operator formatter 展示两阶段 actionable warnings，不向 Channel fanout。

### 8.2 Enablement

| 输入 | 结果 |
|---|---|
| root `enabled` 缺失或 `true` | 允许处理 entries；不自动启用任何 entry |
| `enabled: false`（global） | 不扫描、不 import、不 materialize secret |
| Extension 已安装、没有 config entry | disabled，不 import |
| entry 只有 `config` 或 `enabled` 缺失 | disabled，不 import；配置存在不是启用权威 |
| `entry.enabled: false` | disabled，不 import、不 materialize secret |
| `entry.enabled: true` + valid config | import 并产生候选 Unit |
| `entry.enabled: true` + Extension 未安装 | diagnostic；不产生 Unit |
| installed Extension invalid/load failure | 整个候选隔离；其他候选继续 |

第一版不支持 `enabledByDefault`、auto-enable、allow/deny 或 capability slot。External code 必须显式启用，避免“安装即执行”和多个启用权威。

### 8.3 Config defaults and semantics

缺失 `config` 等价于空 object。Configuration 必须先 defensive copy 对应 Extension 的 scoped config，再 materialize `$env` / `$secret`，最后使用以下冻结的 Ajv 行为校验该隔离副本：

```ts
new Ajv({
  strict: true,
  allErrors: true,
  useDefaults: true,
  coerceTypes: false,
  removeAdditional: false,
});
```

`useDefaults: true` 只在该隔离副本上应用 Schema 声明的静态 defaults，不修改已解析的 Host root config。Configuration 不使用 async/remote Schema loader，只注册当前 Descriptor 自身的 Draft-07 Schema；校验成功后递归 defensive freeze effective config，再交给 Extension factory。

Host 不转换 scalar/array 类型、不删除未知字段，也不把 validation failure 当作可修复输入。静态默认值只在 Schema 声明；依赖平台、其他运行状态或 I/O 的动态派生值由 Extension 拥有，不得伪装为 Schema default。

Extension-specific cross-field validation仍由 `createExtension()` 或 Unit `create()` 负责。前者只能验证纯值，后者负责需要 I/O 的 discovery。两阶段都不得规范化 Provider-owned opaque Model ID。

未知 config key 按 `additionalProperties: false` 失败。Extension 升级导致旧配置不再匹配时，该 Extension 隔离并报告，不允许 Host 猜测迁移或静默丢字段。Schema migration 不属于 v1。

错误按阶段保持单一归属：Descriptor/Schema compilation/materialized value validation 产生 `config_invalid` 或 `secret_unavailable` 且不 import entry；entry import/export 失败产生 `entry_load_failed`；`createExtension()` 的纯语义校验 throw 产生 `extension_config_rejected`；返回 Unit metadata 不一致产生 `unit_invalid`；Unit `create(signal)` 中的 I/O、discovery 或 readiness failure 属于现有 Runtime lifecycle/startup diagnostic，不回译为 acquisition error。

### 8.4 Unknown and stale config

`entries` 中不存在于 discovered valid descriptors 的 ID 产生 non-secret diagnostic。它不执行代码，也不阻止其他 Extension/Host 启动。若该 Extension 对用户配置的 default Model 等能力是必需的，现有 Runtime unavailable/degraded semantics 继续负责公开结果，不由 acquisition layer 静默 fallback。

## 9. Lifecycle and Resource Ownership

- Discovery/Configuration/Loader 只拥有 startup acquisition 期间打开的文件和临时解析状态；返回前必须释放；
- 动态 module import 后，Node module cache 持有代码；v1 不承诺 unload；
- `createExtension()` 不启动资源，因此 Loader 无 Extension resource cleanup ownership；
- `LoadedRuntimeUnit.create(signal)` 之后的 instance、registration、start/stop 和私有资源仍遵循现有 Runtime Composition ownership；
- Extension instance 是内部 connection/cache/client/auth/rate-limit state 的唯一语义 Owner；Framework 只编排 instance `stop()`；
- Host Shutdown 不重新扫描、不再次 import，也不直接关闭 Extension 私有对象；
- 安装目录变化只在下一次完整 Host startup 生效。

## 10. Errors and Concurrency

- Startup acquisition 是单线程、确定顺序的阶段；v1 不并行 import candidates；
- 单个 External candidate 的 Descriptor/config/import/factory failure 整组隔离，不污染其他 candidate；
- Host config 文件 malformed 或根结构无效属于 Host configuration failure；不得把整个文件当空配置静默继续；
- 单个 Extension namespace invalid 只隔离该 Extension；
- duplicate ID 没有 winner，全部候选隔离；不同 ID 的顺序只由 Descriptor ID 决定，不由目录名、import timing、registration order 或配置顺序决定；
- diagnostics 必须稳定排序、可关联且不含 materialized secret；
- v1 External Unit dependencies 必须为空；Loader 在 handoff 前拒绝非空值，因此 unknown/cycle/disabled dependency 不会泄漏到 Runtime Catalog 并把单个 External acquisition failure升级为 whole-startup failure；
- Runtime 收到 `loadedUnits` 后的 duplicate catalog identity、create、start、registration conflict 和 publish failure继续使用现有 Runtime error/lifecycle contract；acquisition layer 不翻译成第二套 runtime semantics；
- AbortSignal 不用于纯 discovery/import。任何可能阻塞的 Provider discovery 必须在 Unit `create(signal)` 内有界执行。

## 11. Security and Capabilities

### 11.1 Trust statement

External Extension 是显式启用后在 Host 进程中执行的可信代码。Descriptor、Schema 和 scoped config 限制 accidental coupling，不提供安全隔离。来源未知或不可信的代码不得通过本机制启用。

### 11.2 Static controls

- 不扫描 `node_modules`、workspace、任意 `load.paths` 或 loose scripts；
- 默认发现根唯一为 `<agent-home>/extensions`；
- 不递归发现 nested candidates；
- 安装目录、Descriptor 和 entry real path 必须位于规范 boundary；
- v1 应拒绝 symlink/reparse-point candidate 和越界 entry，而不是把它们当开发便利路径；
- disabled/invalid candidate 的 entry execution count 为零；
- JSON parser/schema errors 必须限制 diagnostic payload，避免回显整个 config。

### 11.3 Secret handling

- Host 拥有 environment access 和 materialization；Extension 只接收自己的 resolved value；
- Secret value 不进入 acquisition result、Registry metadata、Model Catalog 或 logs；
- diagnostics 只能显示 reference path 与 environment variable name，不显示值；
- config object 在交给 factory 前 defensive copy/freeze；
- v1 的 SecretRef 不承诺运行时轮换；更新 secret 需要重启 Host；
- 如果未来要求运行不受信任 Extension，必须另建 process/worker isolation Spec，不能扩大本 Contract 声称的安全性。

## 12. Compatibility and Migration

### 12.1 Migration sequence

1. 由关联 Model Invocation Contract 冻结 versioned structural error、runtime parser 与 Host canonicalization，并证明动态/重复 bundle 不依赖 class identity；
2. 实现 Descriptor/config/reference/loader Contract 和 fixture Extensions，不接入生产 Host；
3. 用 Contract tests 证明 invalid/disabled candidate 在 entry execution 前被拒绝；
4. 为 Copilot Relay 增加 `extension.json` 和符合 entry contract 的 adapter；除已接受的 error-boundary migration 外，现有 Provider Unit/Adapter 行为保持不变；
5. 增加 repository build step，生成 §7.8 的封闭 ESM artifact，并以 fresh/relocated Agent Home Contract test 证明无 repository/runtime dependency；
6. 提供明确的本地部署步骤，在 Host 停止时把完整 Relay artifact 目录复制/替换到 `<agent-home>/extensions/<locator>`；安装器不属于本 Slice；
7. 将 Relay 配置从 [server.ts](../../scripts/server.ts) 迁移到 `<agent-home>/config.json` 的 `extensions.entries.copilot-relay-provider.config` namespace；
8. 默认 Model Reference 继续由现有 workspace `AgentDefaults.model` 和通用 `MY_AGENT_PROVIDER` + `MY_AGENT_MODEL` atomic override 提供；Host 调用通用 Config API 并透传完整 opaque `{ providerId, modelId }`，不得从 Extension ID 推导 Provider ID，也不得保留 Relay-only `MY_AGENT_MODEL` 解释；
9. 将 supported WebSocket Host 改为只调用通用 acquisition API 和通用 Agent config/env override API，并继续静态构造 WebSocket Channel；Host 消费 acquisition result 与 Runtime startup warning，并向 operator 输出统一脱敏 warning；
10. 删除 Host 对 Copilot Relay factory、Provider ID、base URL normalizer 和 `COPILOT_RELAY_*` 的直接 import/read；
11. 保持 `RuntimeAppOptions.loadedUnits`、Registry、Provider Catalog、Channel 和 Turn execution contract 单一路径；Host 内部错误表示的 canonicalization 不得形成第二条 invocation 或 lifecycle path；
12. 更新 Current Architecture、迁移 ledger、用户配置/部署说明和 supported Host smoke evidence。

### 12.2 No dual authority

迁移 Gate 后不得同时保留：

- Host-specific Relay env wiring 与 scoped Extension config；
- 静态 Relay factory import 与动态 Relay Extension acquisition；
- config-key presence 和 `enabled` 两种启用权威；
- acquisition loader 直接注册与 Runtime staging 注册两条路径；
- shared Error class identity 与 structural protocol 两个跨 Extension 错误权威。

在迁移 Gate 前，当前 [server.ts](../../scripts/server.ts) 仍是唯一受支持路径；Draft/partial implementation 不得被表述为 Current Architecture。

### 12.3 Rollback

在删除旧路径前，rollback 是完整恢复旧 Host Composition Root。删除 Gate 后 rollback 只能通过版本回滚；不得在同一版本加入运行时 fallback，在动态加载失败时偷偷改用静态 Relay factory。

## 13. Acceptance and Validation

### 13.1 User-observable acceptance

- [ ] 未修改 Host/Runtime/Runner Extension-specific 代码即可安装并启用一个 fixture Provider Extension；重启后它出现在 Catalog；
- [ ] 禁用或移除后重启，它不再出现在 Catalog，其他 Provider/Channel 正常；
- [ ] Relay 通过 scoped config 和 SecretRef 完成真实 loopback Catalog discovery 与 invocation；
- [ ] supported WebSocket Host 不再 import Relay 或读取 Relay-specific env；
- [ ] supported WebSocket Host 仅通过 workspace `AgentDefaults.model` 或成对的 `MY_AGENT_PROVIDER` + `MY_AGENT_MODEL` 取得完整 Model Reference，不推导具体 Provider；
- [ ] stale/invalid Extension 配置产生可定位、无 secret 的 diagnostic，不静默 fallback。
- [ ] 显式启用的 Extension 在 acquisition 或 optional Unit lifecycle 阶段失败时，机器操作者收到 bounded、redacted warning；普通 WebSocket/browser 用户不收到 installation/startup details。

### 13.2 Contract evidence

- [ ] direct-child discovery、Descriptor-ID deterministic order、目录重命名不变性、invalid Descriptor、path escape、symlink/reparse point、duplicate ID 全部隔离；
- [ ] config presence does not enable、explicit enable/disable、unknown installed/configured ID；
- [ ] `$env` / `$secret` materialization、missing value、deep references、redaction、defensive freeze；
- [ ] Draft-07 Schema URI/root contract、strict compile、internal-only `$ref`、isolated defaults、no coercion、no field removal、unknown key failure，且 rejected entry execution count 为零；
- [ ] entry export、factory pure-validation、metadata mismatch 与 Unit `create()` failure 保持不同错误阶段和 whole-unit isolation；
- [ ] factory context 只有递归 frozen scoped config，不包含 Descriptor、identity、version、locator、global config、environment 或 Runtime capability；
- [ ] External Unit 返回非空 dependencies 时在 acquisition handoff 前拒绝，其他 valid Units 仍可进入 Runtime；
- [ ] 同一语义错误来自 Host canonical class、独立 Extension bundle 或重复 constructor 时均被统一 canonicalize；malformed/未知版本结构不被误认；
- [ ] Host 不 import Extension-private Error subclass，跨 Extension 识别不以共享 `instanceof`、message matching 或公共 SDK runtime singleton 为必要条件；
- [ ] build artifact 只有 Descriptor、ESM marker、entry 与 Relay-owned production JavaScript closure；不存在越界 runtime import、测试、声明、source map、Host Core 文件或 npm install；
- [ ] artifact 在 fresh/relocated Agent Home 中可加载，repository/build tree 删除后仍可运行；partial/运行中/symlink deployment 明确不受支持；
- [ ] acquisition actionable diagnostics 通过 frozen result 到达 Host；Runtime optional Unit 与 Channel degraded diagnostics 全部通过 warning event 到达 Host，不只转发 `CHANNEL_*`；
- [ ] operator formatter 对两阶段 diagnostics 使用同一 bounded/redacted policy；fatal error 仍 reject，`disabled` 默认不打印，诊断不进入 Channel protocol；
- [ ] Loader 只产出 `LoadedRuntimeUnit[]`，不 create/start/register Unit；
- [ ] boundary/Fitness test 禁止 Host 和 Runtime import具体 External Extension。

### 13.3 Integration and regression evidence

- [ ] fixture Extension -> generic acquisition -> Runtime staging -> immutable Snapshot -> typed projection；
- [ ] 一个坏 Extension 不改变其他 valid Unit 的发布结果；
- [ ] existing runtime reload/generation/retirement/Shutdown tests 不新增第二条路径；
- [ ] Copilot Relay focused tests、真实 Relay smoke、CLI/WebSocket model selection 与 Abort regressions 通过；
- [ ] complete `npm test`、`npm run lint`、`npm run build` 和 `git diff --check` 通过；
- [ ] 文档链接/Fitness/Current Architecture 同步检查通过。

## 14. Definition of Ready

- [ ] 本 Spec 进入 `Accepted`；
- [ ] 独立 Plan Item、迁移 Gate 和 owner 明确；
- [x] §15 Open Questions 全部关闭；
- [x] Agent Home resolution 与 Host config source 有唯一权威：explicit option > `MY_AGENT_HOME` > `<user-home>/.my-agent`，配置为 `<agent-home>/config.json`；
- [ ] Descriptor/Schema/module format 已由 Contract test 或必要 Spike 证明；
- [ ] symlink/reparse-point、real-path containment 和 Windows/Linux path behavior 有可证伪测试计划；
- [x] Relay artifact 由 repository build 生成封闭、可重定位的多文件 ESM directory；构建不写 Agent Home，部署方在 Host 停止时整体复制/替换，不扩展为 Marketplace、安装器、bundler 或 npm package install；
- [x] startup diagnostics 以 acquisition result 与 Runtime warning event 为各阶段结构化权威，supported Host 向机器操作者/Host integrator 展示；不进入 Channel，也不增加 durable `RuntimeHandle` report；
- [x] [Model Invocation Error Boundary Amendment](model-invocation-error-boundary-amendment.md) 已接受 versioned structural error、runtime parser、Host canonicalization 与现有 class 输入的迁移/兼容规则；
- [ ] Error canonicalization 不新增第二条 Runtime/Runner/Registry、invocation 或 lifecycle path；
- [ ] 项目所有者单独授权 production Delivery。

## 15. Open Questions

本 Spec 的本地 design Open Questions 已全部关闭。Agent Home resolution、Host config physical source、directory/identity semantics、Draft-07 Schema contract、Entry factory、跨 Extension 错误的长期 structural-authority 方向、Relay installation artifact 和 startup diagnostics surface 均已有唯一决定。

本文档仍保持 `Draft`：具体 Model Invocation structural error shape 必须由 §14 的关联 Contract Gate 关闭；Descriptor/Schema/module format、path containment、artifact relocation 和 diagnostic redaction 仍需可证伪 evidence。它们是 readiness/validation gates，不在本文档形成第二个设计权威。v1 External Unit dependencies 已决定为空；未来如需依赖图必须另行扩展 acquisition isolation 与 Runtime Catalog failure matrix。任何新证据若要求第二条 Runtime path、Extension-specific Host branch、全局 Config 暴露、不受信任代码执行、公共 SDK runtime singleton 或新的 package manager/bundler dependency，必须停止并回到项目所有者重新决策。