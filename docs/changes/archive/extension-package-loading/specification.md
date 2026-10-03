# Extension 独立包与统一模块加载设计

> 状态：已接受，附加工作实施中
> 日期：2026-09-17
> 所有者：项目所有者
> 相关决策：[ADR-014](../../../decisions/adr-014-extension-packages-and-runtime-composition.md)

## 目的与可观察结果

Extension 是独立拥有自身内容的 package。Extension 作者自行选择并声明源码布局、模块入口、运行依赖和构建方式。用户安装或启用 Extension 时，不需要知道入口是 TypeScript、JavaScript，还是 Loader 支持的其他模块形式。

开发与生产使用同一条基于 Jiti 的 Extension 加载路径。仓库开发环境可以直接加载 Extension 源码；正式安装可以包含源码或预构建产物，具体形式不改变 Host 面向 Extension 的契约。

## 范围

- 将受版本控制的 `extensions/*` 目录变为 npm workspace packages；
- 将 Copilot Relay 从 `src/extensions/` 移入独立 Extension package；
- 将 Host 侧 Extension 支持归并到 `src/extension/`，并在其下保留 `api/` 与 `acquisition/` 两个明确边界；
- 每个 Extension package 自行拥有 package 元数据、运行依赖、测试和可选构建命令；
- 通过 `my-agent/extension-api` 暴露最小且稳定的 Host 契约；
- 开发与生产统一通过 Jiti 加载已验证的 Extension 模块入口；
- 删除 Descriptor 对入口必须以 `.js` 结尾的限制；
- 保留 Extension 身份、配置 Schema、路径包含性、诊断和 Runtime Unit 验证；
- 保留现有 Runtime staging、发布、generation、生命周期和 shutdown 模型；
- 按新源码与安装布局调整开发流程及 npm package 验证；
- 实现验证完成后，替换旧 Extension 决策权威并删除过时的 Acquisition/refactoring 文档。

## 非目标

- Marketplace、远程下载、更新、签名或信任策略；
- Runtime 启动期间安装依赖；
- 文件监听或运行中热替换代码；
- 通用依赖注入容器；
- 超出 Copilot Relay 迁移所需范围扩张 Extension API。

## 边界与依赖方向

```text
my-agent Host/Runtime
  -> src/extension/acquisition
  -> src/extension/api

Extension package
  -> my-agent/extension-api
       -> src/extension/api
  -> 自身声明的运行依赖
  -X-> Host、Runtime、Core 或 Acquisition 私有源码路径
```

仓库根 package 拥有 npm workspace 和官方安装内容的组装。每个 `extensions/<package>/package.json` 拥有该 Extension 的 package 身份、脚本和依赖。Jiti 由 Host package 持有，因为加载 Extension 是 Host 职责。

`src/extension/` 是 Host 内部的 Extension 子系统：`api/` 拥有对 Extension 作者公开的最小契约，`acquisition/` 拥有 Descriptor discovery、配置解析和 Jiti loading。使用单数目录名是为了与根级 `extensions/` packages 区分。两者共享父目录但不合并 barrel；私有 Acquisition API 不得从 `my-agent/extension-api` 暴露。

Extension package 目录是自身依赖的解析基点。开发安装使用 workspace 依赖图；生产组装在启动前，将每个随产品提供的 Extension package 及其生产依赖闭包放入安装树。Runtime Loader 不调用 package manager，也不修改安装内容。

## 公共与结构契约

`my-agent/extension-api` 是稳定的外部导入名，不随源码物理目录迁移而变化。它只导出实现 Extension 入口及 Contribution 所必需的类型和运行时帮助函数。`ExtensionLoadContext` 与 `ExternalExtensionModule` 由 `src/extension/api` 拥有，Acquisition 依赖这些公共 contracts，而不是公共 API 反向依赖私有 Acquisition。迁移后的 Relay package 不得导入 `src/core`、`src/runtime`、`src/extension/acquisition` 或其他 Host 私有路径。

`extension.json` 继续作为 Extension 身份、版本、模块入口和配置 Schema 的静态 Descriptor。`entry` 是包含在 Extension 安装目录内的相对模块路径。Descriptor 不按 `.js` 或 `.ts` 后缀限制入口；入口能否加载由统一 Jiti Loader 判断。

`package.json` 负责 package manager 关注点，不把这些字段复制进 `extension.json`：依赖保留在 `package.json`，Extension 身份和 Host 加载元数据保留在 `extension.json`。

Extension 入口继续只导出 `createExtension(context)`。它返回尚未创建的 `LoadedRuntimeUnit`；Acquisition 不创建运行资源。

## 行为与不变量

- Discovery 继续只检查注入的 `extensionsDir` 的直接子目录，并要求存在 `extension.json`。
- Descriptor 与入口路径继续要求是规范包含的普通文件，并保留 reparse point 与路径穿越防护。
- 缺少单个 Extension 的 `enabled` 时默认启用；显式 `false` 才禁用。
- Acquisition 完成 Descriptor、配置和路径验证后，通过 Jiti 加载入口，并且只验证一次导出 factory 和返回的 Unit。
- 源码入口与构建入口产生相同的 Acquisition 诊断和 Runtime handoff。
- Jiti 可以在内部将构建后的 JavaScript 委托给平台原生 Loader；这是优化，不是 Extension 或用户契约。
- 单个 Extension 加载失败仍与有效邻居隔离。
- Runtime 继续接收冻结且尚未创建的 `LoadedRuntimeUnit[]`。

## 生命周期与资源所有权

现有 Runtime Unit 模型继续有效：Runtime 创建已接受的 Unit，原子 staging Contribution，验证并发布不可变 generation，并负责 retirement 与 stop 协调。Extension 拥有其 Unit instance 内创建的资源。Loader 和 package 改造不引入第二条 composition 或生命周期路径。

## 失败与安全语义

- 缺失或无效的 package 依赖表现为候选项局部的入口加载诊断。
- Host 报告有界诊断，不暴露 secret 或任意源码内容。
- 只有完成 Descriptor、配置和路径包含性验证后才执行加载。
- 使用 Jiti 不放宽入口必须位于该 Extension 安装目录内的现有规则。
- Package 安装与代码信任属于部署职责，不属于 Runtime Acquisition。

## Host 加载可观测性

Extension 加载是 Runtime Bootstrap 的组成部分。Host 通过通用 `RuntimeAppOptions.startupContext` 提供 `installDir`、完整配置快照和环境，不构造 Extension 专用参数。`bootstrapRuntime()` 从这些启动事实派生 `<installDir>/extensions`、Extension 配置与环境 override，再调用共享 `src/extension/acquisition`。Acquisition 继续唯一拥有 discovery、Jiti loading、验证、诊断与 `ExtensionAcquisition` 日志，Bootstrap 将返回的未创建 Units 交给后续 Runtime composition。

具体 Host 不调用 Acquisition、不派生 Extension root、不读取 Extension 配置、不遍历结果，也不复制加载或日志逻辑。`RuntimeAppOptions.loadedUnits` 继续承载 Host 直接构造或嵌入方注入的 Units；它不再承载 Host 预先加载的 Extensions。无 `startupContext` 的嵌入式 Runtime 继续只使用显式 `applicationConfig`、`envOverrides` 和 `loadedUnits`，不会隐式访问文件系统。

Acquisition 只记录开始消息、包含 loadedCount 与已加载 ID 的完成汇总，以及非禁用的有界 warning；不为每个候选重复记录 loading/acquired。消息不声称 Unit 已由 Runtime 创建、接受或发布。日志只包含受控字段：Extension root、Extension ID、受限 locator、诊断 code/category 和 loadedCount，不记录 Extension 配置、环境值、secret 或任意源码内容。

Runtime Composition 对成功发布并完成所有权 handoff 的 Channel 统一观察 completion。失败只通过 Runtime Logger 记录受控的 Channel ID 与 phase，不记录原始 Error；rejected completion Promise 在 Runtime 边界归一化为 `failed/runtime`，不向 Host 或嵌入调用方传播 rejection。具体 Host 只执行 controlling Channel 对应的进程退出状态和 shutdown 策略，不为 controlling 或 secondary Channel failure 重复输出日志，也不为仅记录日志而观察 secondary completion。

本次删除 Standalone `prepareStandaloneHostAcquisition()` 和 Host 侧诊断格式化包装，不新增 `host-loader.ts`。不向 `my-agent/extension-api` 增加 Logger，不允许 Extension 导入 Host 私有 Logger。日志沿用现有 Logger 生命周期和 adapter 行为；Acquisition 异常进入现有 Bootstrap failure 与清理路径。

## 开发与生产布局

开发环境直接使用受版本控制的仓库布局：

```text
extensions/
  copilot-relay-provider/
    package.json
    extension.json
    entry.ts
    ...
```

`npm run agent` 从仓库安装根直接加载该源码 package，不再把生成文件复制到受版本控制的 `extensions/` 树上。

生产构建和 package 验证在正式安装根下组装相同的逻辑目录。官方 Extension 可以为启动性能和产物确定性生成预构建输出，但 Host 契约不要求输出必须是 JavaScript，也不向用户暴露该选择。

## 兼容与迁移

本次为原子源码与加载迁移。不为 `src/extensions/*`、`src/extension-api/*` 或 `src/extension-acquisition/*` 保留兼容 facade，不保留第二套原生 `import()` Loader，也不再向仓库根 `extensions/` 生成开发副本。源码内部引用、构建入口、Fitness 清单和文档证据一起切换到 `src/extension/{api,acquisition}`；外部 package specifier `my-agent/extension-api` 保持不变。

现有 Relay Extension、测试、构建检查和开发命令一起迁移到 package 布局。已有 Agent 配置键和 Descriptor identity 保持不变。

## 文档替换与删除门槛

实现并验证完成后：

1. 新增一份已接受 ADR，覆盖 Extension package 所有权、公共 API、统一模块加载，以及继续保留的 Runtime Unit 生命周期；
2. 将所有有效入站引用切换到继任 ADR 后，删除 `docs/decisions/adr-005-extension-registry-runtime-composition.md`；
3. 删除 `docs/changes/archive/extension-acquisition-delivery/plan.md`；
4. 删除 `docs/changes/archive/extension-acquisition-source-layout/plan.md` 和 `specification.md`；
5. 更新 Current Architecture 与稳定 Specification，使其只描述已实现的 package/loading 模型；
6. 保留 AF-06 作为仍有效的 Runtime staging 与生命周期历史证据，但将其决策链接改为继任 ADR；
7. 清理受影响索引，并确认不存在指向已删除文件的有效链接。

Git 历史负责保存被删除的旧设计，活动文档中不保留 superseded 副本。

## 验收与验证

- TypeScript Extension 入口可以通过生产 Loader 路径加载；
- 构建后的 JavaScript Extension 入口通过同一条路径加载；
- Extension 可以解析其自身 package 声明的依赖；
- 不存在或无法加载的入口产生有界的候选项局部诊断；
- 路径包含性、reparse point、重复 ID、配置、导出和 Unit 验证测试继续通过；
- Relay 测试从其 Extension package 运行，并证明它只通过 `my-agent/extension-api` 引用 Host；
- Host 内部只通过 `src/extension/acquisition` 使用加载能力，公共 API 不暴露 Acquisition 实现；
- `my-agent/extension-api` 在源码与已安装 package 中保持相同，并且其声明文件可由隔离的 Extension consumer 完整解析；
- `npm run agent -- -ah test-workspace` 从受版本控制的 workspace package 直接加载 Relay；
- npm package 验证证明已安装 package 包含并能加载官方 Extension，且运行期间不修改安装目录；
- 所有 Host 只向 Runtime Bootstrap 提供通用启动上下文，具体 Host 不感知或复制 Extension 加载参数；
- `bootstrap start` 和 Logger 配置发生在 Extension Acquisition 之前；
- Bootstrap 内按真实发生顺序输出 Acquisition 开始消息、有界 warning 与 loadedCount/ID 完成汇总；
- Bootstrap Acquisition 日志不暴露配置、环境值、secret 或源码内容，也不把 acquired 错称为 Runtime active；
- Runtime 对已发布 Channel 的 completion failure 只记录受控 ID/phase，具体 Host 不重复输出或为日志观察 secondary completion；
- focused tests、完整测试、typecheck、clean build、package audit、链接扫描和 `git diff --check` 通过；
- 独立 review 不存在未解决的 Critical、High 或 Medium 问题。

## 开放问题

无。不会改变上述边界的实现细节遵循仓库现有最小模式。