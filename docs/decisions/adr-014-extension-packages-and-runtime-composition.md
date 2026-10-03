# ADR-014：Extension 独立包、统一加载与 Runtime Composition

> 状态：Accepted
> 决策状态：Accepted
> 决策日期：2026-09-17
> 所有者：项目所有者
> 权威：长期架构决策
> 替代：原 ADR-005 Extension、Registry、Composition 与 Runtime Lifecycle 决策
> 修订：ADR-013 中由 Standalone 观察 secondary Channel failure 并输出 warning 的条款

## 背景

原有实现把具体 Extension 放在 Host 的 `src/extensions/` 中，依靠根 TypeScript 构建生成 JavaScript，再复制到运行时扫描目录。Descriptor 进一步要求入口必须以 `.js` 结尾。这些规则把构建细节暴露成了 Extension 契约，并且没有让 Extension 真正拥有自己的 package 元数据与依赖。

与此同时，原 ADR-005 所确定的 Runtime Unit staging、不可变 Registry Snapshot、Turn generation pinning、原子发布和生命周期所有权已经实现并仍然有效。新的决策需要替换错误的 package/loading 方向，同时保留这些已经验证的 Runtime 语义。

## 决策驱动

- 用户安装和启用 Extension 时不需要理解源码或构建产物格式；
- Extension 独立拥有 package、依赖、测试和构建方式；
- 开发环境可以直接加载并调试 TypeScript 源码；
- 正式安装和开发使用同一条加载路径；
- Extension 只依赖稳定的公开 Host API，不引用 Host 私有源码；
- 保留已验证的 Unit 原子注册、不可变 Snapshot 和生命周期模型；
- 不为了假设场景增加入口后缀、双 Loader 或中央 Extension 分支。

## 备选方案

1. 保留 `.js` artifact-only Loader：发布路径简单，但源码开发需要额外构建和复制，并把格式变成不必要的公共约束。
2. 开发使用 Jiti、生产使用原生 `import()`：可以加载源码，但形成两条行为路径和重复验证面。
3. 使用独立 Extension package、公开 Extension API 和统一 Jiti Loader：同时支持源码与构建产物，并保持单一 Host 边界。

选择方案 3。

## 决策

### Extension package 所有权

仓库内 Extension 位于受版本控制的 `extensions/*` npm workspace packages。每个 package 自行拥有 `package.json`、运行依赖、测试、源码和可选构建命令。Host 不拥有 Extension 的第三方依赖，也不在启动期间运行 package manager。

开发环境从 workspace package 直接加载源码。正式发布在启动前组装完整 Extension package 及其生产依赖；官方 Extension 可以发布源码或预构建产物。源码与产物格式属于 package 和发布实现，不属于用户配置契约。

### Descriptor 与统一加载

`extension.json` 继续声明 Extension 身份、版本、模块入口和配置 Schema。入口必须是候选目录内的相对普通文件，并继续接受 canonical containment 与 reparse point 检查，但不按 `.js`、`.ts` 或其他后缀建立白名单。

Host 在开发与生产中统一通过 Jiti 加载已验证入口。Jiti 是否将构建后的模块交给 Node 原生 Loader 只是内部优化，不改变 Extension 行为或用户契约。不保留第二套直接 `import()` Extension Loader。

### 公共 Extension API

Host 通过 `my-agent/extension-api` 暴露 Extension 实现所需的最小类型与运行时帮助函数。其源码由 `src/extension/api` 拥有，私有 discovery 与 loading 由 `src/extension/acquisition` 拥有。Extension package 可以依赖该公开入口，不得通过相对路径引用 Host 的 `src/core`、`src/runtime`、`src/extension/acquisition` 或其他私有源码。

新增公共导出只按真实 Extension 需求扩展。它不是通用 Service Locator，也不授予 Extension 访问全局配置或 Runtime 私有状态的能力。

### Acquisition 与配置

Host 向 Runtime 提供通用 `installDir`、完整配置快照和环境启动事实。Runtime Bootstrap 派生并向 Acquisition 注入明确的 `<installDir>/extensions`、Extension 配置投影和环境。Discovery 只检查该目录的直接子目录。全局 `extensions.enabled` 默认启用；已配置的 Extension entry 缺少 `enabled` 时默认启用，显式 `false` 才禁用。未配置的已安装 Extension 不执行。

Acquisition 在执行模块前完成 Descriptor、路径、配置引用和 Schema 验证。单个候选项的依赖、导入、导出、factory 或 Unit 元数据错误保持局部诊断，不阻止有效邻居。

### Runtime Composition 与生命周期

Builtin 与 External Unit 在 acquisition 后进入同一条 Runtime Composition 路径。每个 Unit 向私有 staging collector 注册完整 Contribution 集合；验证成功后由一个 Registry Builder 原子发布不可变 Snapshot。

一个 root Turn 在开始时捕获 generation，Child 继承 Parent generation。Runtime 负责 Unit 创建、依赖顺序、staging、验证、启动、发布、retirement 和 stop；Extension 拥有其 instance 内部连接、缓存、客户端和传输资源。Registry consumer 不获得关闭 Extension 资源的权限。

发布前失败不改变当前 generation；发布后的旧 generation retirement 失败不回滚新 Snapshot。Shutdown 以有界方式报告残留失败，不强行破坏仍被 Turn 持有的 generation lease。

Runtime Composition 统一观察已发布 Channel 的 completion，并以受控 ID/phase 记录失败；具体 Host 不重复记录或仅为日志观察 secondary completion。违反 Channel 契约的 rejected completion Promise 在 Runtime 边界归一化为结构化 `failed/runtime` completion，不把原始 rejection 传播到进程入口。

## 结果

### 正面结果

- Extension 是真实 package，而不是 Host 源码目录中的特殊分支；
- TypeScript 源码与预构建模块共享同一加载和诊断路径；
- 用户不再接触 `.js` 入口约束；
- Extension 依赖和 Host 依赖的所有权明确；
- Runtime 的原子发布与生命周期模型保持不变；
- Copilot Relay 作为真实 Extension 持续验证整个边界。

### 代价

- Host 增加 Jiti 生产依赖；
- Host 必须维护稳定且受审查的 `my-agent/extension-api`；
- 发布流程必须确保 Extension package 及其生产依赖在启动前完整存在；
- TypeScript 源码加载错误在启动时表现为候选项局部诊断。

## 未冻结细节

本 ADR 不固定 Extension 是否必须预构建、具体 bundler、Marketplace、远程安装、签名、更新、文件监听、热替换、同 identity 多实例或任意内部目录布局。只有 Descriptor 声明的入口和公开 Extension API 构成 Host 契约。

## 实现与证据

| 类型 | 证据 |
|---|---|
| 当前事实 | [Extensions](../architecture/extensions.md)、[Runtime](../architecture/runtime.md)、[Providers](../architecture/providers.md) |
| 稳定契约 | [Extension Acquisition](../specifications/extension-acquisition.md)、[Runtime Composition](../specifications/runtime-composition.md) |
| 实现 | [Extension API](../../src/extension/api/index.ts)、[Acquisition Loader](../../src/extension/acquisition/loader.ts)、[Copilot Relay package](../../extensions/copilot-relay-provider/package.json) |
| 测试 | [Loader tests](../../src/extension/acquisition/loader.test.ts)、[Relay tests](../../extensions/copilot-relay-provider/entry.test.ts)、[npm package verifier](../../scripts/verify-npm-package.mjs) |
| 历史证据 | [AF-06 Extension Framework](../evidence/spikes/af-06-extension-framework.md) |