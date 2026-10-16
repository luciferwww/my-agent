# WebSocket Client Vue 3 + Vite 迁移设计草稿

> Status: Non-authoritative research draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications、Active Changes 或源代码
> Scope: 研究 WebSocket Channel bundled reference client 从内嵌单 HTML 迁移到 Vue 3、Vite 和 TypeScript 的源码组织、构建、部署、资源服务与渐进迁移边界

## 1. 结论

当前 WebSocket Channel Client 已经承担多 Session 状态、History 与实时事件合并、Turn/Tool presentation、Approval、Permission、附件和 Model/Reasoning 选择，不再适合继续以单个 HTML 内嵌模板、样式和脚本的方式扩展。

建议在继续增加 Theme、Subagent Observation 或其他 UI 能力之前，将 Client 迁移为：

```text
Vue 3 SFC
+ TypeScript
+ Vite build
+ Extension-owned static assets
```

该迁移不是把 Client 独立成另一个 Extension 或安装包。Client 继续由 `websocket-channel` Extension 拥有，并随整个 Extension 构建、复制、打包和发布。

统一运行时契约是：

> 每个可加载的 WebSocket Channel Extension 都必须包含提前构建好的 `client/dist`；Extension 安装、加载和启动不得构建 Client。

两种 Extension 部署模式共享同一份 Client runtime 产物：

```text
Built Extension
  = built server + built client

Source-loaded Extension
  = server source + built client
```

Source-loaded/Debug 模式只表示服务端代码以源码形式加载，不要求把 Client 源码复制到目标 Extension 目录。

当前仓库内的 Extension descriptor 指向 `entry.ts`，根 TypeScript build 也不编译 `extensions/`，因此当前可直接验证的是 Source-loaded 模式。Built Extension 是项目已有的另一种交付形态，但其服务端编译目录、descriptor entry rewrite 和复制布局不由本 Client 迁移草稿定义；本文只规定两种模式都消费相同的预构建 `client/dist`。

## 2. 当前事实

当前资源位于：

```text
extensions/websocket-channel/client/
├── chat.html
└── chat2.html
```

两个 HTML 都直接包含：

- Vue 3 CDN script；
- marked CDN script；
- 全量 CSS；
- 全量 Vue template；
- WebSocket protocol 和 UI state 逻辑。

两个页面在产品能力上应视为同一个应用，主要目的只是加载不同 Theme；但当前物理实现并非只有 CSS token 差异。`chat2.html` 还包含与其 layout 演进相关的 permission picker 自适应定位和 responsive presentation 差异。迁移应以两个页面的功能与交互行为并集为基线：视觉差异进入 Theme，共享交互修正进入同一个组件，不能只以其中一份 HTML 为迁移源。

当前 `entry.ts` 将两个 HTML 注册为 Client 路径，`WebSocketChannel` 在启动时读取文件、替换 WebSocket path token，并只以 `text/html` 返回资源。

当前归档 Specification 将 bundled Client 定位为 minimal reference/debugging client，而实际 Client 已经承担：

- WebSocket reconnect；
- Model Catalog 与 reasoning selection；
- Session list、create、switch、rename 和 delete；
- 每 Session draft、attachment、Turn、History、Permission 和 waiting state；
- History/realtime presentation merge；
- Tool Call、Approval、Thinking 和 Result presentation；
- attachment validation 与 encoding；
- mobile/sidebar/menu/scroll 等复杂 UI 状态。

这个复杂度与“单一调试 HTML”定位已经出现偏差。是否正式将其提升为 bundled reference application，需要后续 Decision 或 Change 授权；本草稿只研究迁移方向。

## 3. 目标与非目标

### 3.1 目标

1. 保持 Client 由 WebSocket Channel Extension 拥有和发布。
2. 建立明确的 Client source、build output 和 runtime resource 边界。
3. 让 Built 和 Source-loaded Extension 使用相同的 Client runtime 产物。
4. 消除运行时 CDN 依赖，使安装后的 Extension 可以离线提供 Client。
5. 将 `chat.html` 和 `chat2.html` 收敛为单一 Client，并提供不重载页面的 Theme 切换。
6. 不阻碍未来从实际复用中抽取 read-only Turn presentation，但不预先建设 Observation framework。
7. 让 protocol DTO、runtime validation、History merge 和 Session state 可以独立测试。
8. 保持现有 WebSocket protocol、Session、Approval、Permission、Attachment 和 presentation 语义。
9. 保持 HTTP server 不映射任意 filesystem path。

### 3.2 非目标

- 不授权立即实现迁移；
- 不将 Client 拆成独立 npm package 或独立 Extension；
- 不要求目标安装中包含 Client 源码；
- 不在 Extension 安装、加载或启动时运行 Vite；
- 不借迁移重写 WebSocket protocol；
- 不同时引入 REST/SSE 或改变 Runtime capability ownership；
- 不借迁移重新设计全部 UI；
- 不继续维护 `chat2.html` 对应的第二份 Client 应用源码；
- 不决定 Client 是否成为 security-hardened public frontend。

## 4. 所有权与发布边界

Client 是 WebSocket Channel Extension 的 bundled resource：

```text
extensions/websocket-channel/
├── server source/build output
├── client source
├── client build output
├── extension.json
└── package.json
```

Extension 自己拥有：

- Vue/Vite 配置；
- Client build；
- Client tests；
- Client runtime assets；
- HTTP static asset serving；
- Extension package 中的 Client 文件清单。

根产品构建只负责调用 Extension build 和验证组装结果，不应拥有 WebSocket Client 的具体 Vite 配置。

Client 不存在独立安装生命周期：

```text
build websocket-channel
-> build client
-> package/copy websocket-channel
-> install/load websocket-channel
-> serve prebuilt client assets
```

## 5. 推荐目录

```text
extensions/websocket-channel/
├── client/
│   ├── index.html
│   ├── src/
│   │   ├── main.ts
│   │   ├── App.vue
│   │   ├── components/
│   │   ├── client/
│   │   │   ├── protocol.ts
│   │   │   ├── socket.ts
│   │   │   ├── session-state.ts
│   │   │   └── history.ts
│   │   ├── attachments.ts
│   │   ├── theme.ts
│   │   └── styles/
│   └── dist/
│       ├── index.html
│       └── assets/
│           ├── index-[hash].js
│           └── index-[hash].css
├── WebSocketChannel.ts
├── entry.ts
├── extension.json
├── package.json
└── vite.config.ts
```

职责如下：

| 路径 | 职责 | Runtime 是否需要 |
|---|---|---:|
| `client/index.html` | Vite source entry | 否 |
| `client/src/` | Vue、TypeScript、CSS source | 否 |
| `client/dist/` | 浏览器可直接加载的完整静态产物 | 是 |
| `vite.config.ts` | Extension-owned Client build 配置 | 否 |

`client/dist` 是生成产物，不允许手工修改。

## 6. 两种部署模式

### 6.1 Built Extension

Built 模式复制或发布编译后的服务端和提前构建的 Client：

```text
websocket-channel/
├── server build output
├── client/
│   └── dist/
├── extension.json
└── package.json
```

流程：

```text
build client
-> build server
-> verify extension
-> copy/package extension
```

当前根构建不编译 `extensions/`，本草稿也不定义 Built server 的输出目录、descriptor `.js` entry 或 `import.meta.url` 相对布局。这些属于 Built Extension staging 自身的服务端契约。Client 侧只要求其 staging 流程在复制前执行同一个 `build:client`，并把完整 `client/dist` 放到该模式约定的 Extension-relative 位置。

### 6.2 Source-loaded Extension

Source-loaded/Debug 模式复制服务端源码，但仍使用提前构建的 Client：

```text
websocket-channel/
├── entry.ts
├── WebSocketChannel.ts
├── other server source
├── client/
│   └── dist/
├── extension.json
└── package.json
```

目标目录不需要包含：

```text
client/src/
client/index.html
vite.config.ts
```

除非该目标目录也用于继续开发 Client。

推荐的 Source-loaded staging 流程：

```text
build client
-> copy server source
-> copy client/dist
-> verify staged extension
```

“Source-loaded”描述的是服务端加载形态，不表示所有资源都必须以未编译源码存在。

### 6.3 仓库内 Source-loaded 开发

当前开发命令直接从仓库 `extensions/` 加载 `entry.ts`，不是理论上的候选模式。推荐不提交 `client/dist`，而由显式开发准备步骤保证 clean checkout 可运行：

```text
prepare websocket client
-> build client/dist
-> start source-loaded Host
```

根命令可以通过 `preagent` 或等价的 `dev` orchestration 在 Host process 启动前完成准备，但 Extension loader 和 `WebSocketChannel.start()` 本身不得运行 Vite、安装依赖或修改 installation。Source-loaded copy/stage 同样必须先 build，再只复制服务端源码和 `client/dist`。

只有项目另行确认必须保留“零准备、原样复制 Git 目录即可运行”的稳定契约时，才改为提交 `client/dist`，并增加 reproducibility/stale-dist 检查。

## 7. 构建、复制与安装契约

| 场景 | Client Build | 是否携带 `client/src` | 是否携带 `client/dist` |
|---|---:|---:|---:|
| 开发 Client | 是，watch 或 build | 是 | 是 |
| Source-loaded staging | 是，在复制前 | 可选，默认否 | 是 |
| Built Extension staging | 是，在复制前 | 否 | 是 |
| Extension package/publish | 是，在打包前 | 可选，默认否 | 是 |
| 安装已打包 Extension | 否 | 不要求 | 是 |
| Extension load/start | 否 | 不要求 | 是 |

构建失败必须阻止 staging、pack 或 publish。`client/dist` 缺失或不完整必须让 Extension 验证或启动明确失败，不能：

- 自动安装依赖；
- 自动运行 Vite；
- 回退到 CDN；
- 回退到旧 HTML；
- 返回 success-shaped 空页面。

## 8. Extension scripts

候选 Extension scripts：

```json
{
  "scripts": {
    "build": "npm run build:client",
    "build:client": "vite build",
    "dev:client": "vite",
    "lint": "tsc --noEmit -p tsconfig.json && vue-tsc --noEmit",
    "test": "vitest run --root ../.. --config vitest.unit.config.ts extensions/websocket-channel",
    "verify:client": "node ./scripts/verify-client-assets.mjs"
  }
}
```

根构建、开发和打包必须显式接入该 workspace build。候选依赖关系：

```text
root build/prepack
  -> websocket-channel build:client
  -> verify:client
  -> existing Host build and package verification

root source-loaded development command
  -> prepare/build client
  -> start Host process

stage:source
  -> build:client
  -> verify:client
  -> copy server source + client/dist

stage:built
  -> build:client
  -> external/existing build:server
  -> verify
  -> copy built server + client/dist

Extension install/load/start
  -> no build
```

不建议使用 `postinstall` 构建 Client。

Client 直接使用的构建输入和工具必须由 WebSocket Extension workspace 显式声明，不能依赖 Vitest 或其他包的传递依赖：

| Package | Ownership |
|---|---|
| `vue` | Client build input，打入浏览器 bundle |
| `marked` | Client build input，打入浏览器 bundle |
| `vite` | build/dev tool |
| `@vitejs/plugin-vue` | Vue SFC build tool |
| `vue-tsc` | Client type-check tool |
| `ws` | Extension Node runtime dependency |

Vue、marked 和 build tools 的最终 `dependencies`/`devDependencies` 分类应与现有 root package dependency closure 和 workspace audit 一起确认，但所有直接使用项都必须显式声明。

打包改造不能只生成 dist，还必须同步：

- 将根 package `files` 中两个 HTML 条目替换为 `extensions/websocket-channel/client/dist`；
- 更新 npm package allowlist 和 required-file/inventory validation；
- 验证 tarball 内 `index.html` 引用的每个 JS/CSS/font/image asset 都存在；
- 更新 installed-package smoke，使其读取 Client HTML 并请求其中引用的静态资产；
- 保留 WebSocket path/runtime config token 已替换且无残留的检查；
- 证明安装包不包含 Client source 时仍可启动。

## 9. Runtime asset serving

Vite build 会生成 HTML、JavaScript、CSS，未来还可能生成 font、image 或 source map。当前只返回 HTML 的服务逻辑需要演进为受控 asset map。

候选内部类型：

```ts
interface ClientAsset {
  readonly contentType: string;
  readonly content: Buffer;
  readonly cacheControl: string;
}
```

启动时将 `client/dist` 中经过验证的 regular files 预读为内存 asset map，或者使用显式启用的 Vite manifest 建立等价的有限资源集合。第一版优先采用受控 dist inventory；只有使用 manifest 时才要求配置 `build.manifest: true` 并递归纳入 imports、CSS、font 和 image assets。

```text
configured client path
  -> index.html

derived asset base + assets/index-[hash].js
  -> JavaScript asset

derived asset base + assets/index-[hash].css
  -> CSS asset
```

Vite asset URL 不能隐式假设 `clientPath = /`。实现前必须在 Spike 或正式 Change 中确定一种策略：

1. `base: './'`，按每个 HTML route 的 URL directory 派生并注册 asset paths；
2. 为 Client 定义稳定的 Extension-owned asset prefix，并验证它不与 `clientPath` 或 `webSocketPath` 冲突；
3. 在服务端注入配置时同时 rewrite 明确的 asset base token。

无论选择哪一种，Vite 输出 URL、HTTP asset map 和 configurable `clientPath` 必须使用同一套可测试的路径推导规则。

必须保持：

- 不将 URL 直接拼接成 filesystem path；
- 不暴露 Extension 目录中的源码或配置；
- 拒绝未知 path 和非 GET/HEAD 请求；
- 返回正确 Content-Type；
- HTML 使用 `no-store` 或等价策略；
- hash asset 可以使用长期 immutable cache；
- HEAD 与 GET 语义一致；
- Client resource load failure 在启动阶段明确报告。

## 10. Runtime configuration injection

当前 Client 通过 HTML token 获得 WebSocket path。迁移后建议在 build 后 HTML 中保留一个明确表示完整 JSON value 的配置占位符，而不是为每个字段分别增加 token：

```html
<script id="my-agent-client-config" type="application/json">
  __MY_AGENT_CLIENT_CONFIG_JSON__
</script>
```

服务端根据请求入口生成配置并替换该 token：

```ts
const configJson = JSON.stringify({
  webSocketPath: this.path,
}).replaceAll('<', '\\u003c');

return source.replaceAll('__MY_AGENT_CLIENT_CONFIG_JSON__', configJson);
```

例如，所有入口加载同一个 JS/CSS bundle，运行时只注入 WebSocket path：

```json
{
  "webSocketPath": "/ws"
}
```

Client 启动时读取、解析并验证配置：

```ts
interface ClientConfig {
  readonly webSocketPath: string;
}

function readClientConfig(): ClientConfig {
  const element = document.querySelector('#my-agent-client-config');
  if (!element) throw new Error('Client configuration is missing');
  return parseClientConfig(JSON.parse(element.textContent ?? ''));
}
```

`__MY_AGENT_CLIENT_CONFIG_JSON__` 明确表示服务端替换的是完整 JSON value，不应在 HTML 中额外加引号。`${...}` 容易被误解为 JavaScript template literal，`{{...}}` 容易被误解为 Vue template interpolation，因此不作为 runtime token 形式。

只替换 `index.html`；带 hash 的 JS/CSS 保持不可变。配置使用非执行的 `application/json` script，不向 `window` 写入全局变量。缺失 token、重复 token、JSON 解析失败或配置 validation 失败都必须让 Client resource load 或 Client bootstrap 明确失败。

即使当前 path schema 不允许 `<`，服务端仍保留 `< -> \u003c` 转义，防止未来配置字段形成 `</script>`。运行时配置不得包含 credential、filesystem path 或其他不应发送到浏览器的信息。

第一阶段不建议增加独立 config endpoint，因为它会额外引入：

- Client bootstrap request；
- config fetch failure state；
- caching 语义；
- 新的 HTTP contract。

如果未来 Client runtime configuration 明显增加，再单独研究 config endpoint。

## 11. 推荐前端边界

Client 仍然是 lightweight bundled reference client。迁移的目标是消除四千行单文件并建立少量清晰边界，不是建设通用前端框架。

推荐保持扁平结构：

```text
client/src/
├── main.ts
├── App.vue
├── components/
│   ├── SessionSidebar.vue
│   ├── ChatTimeline.vue
│   ├── TurnItem.vue
│   ├── ToolCallCard.vue
│   ├── Composer.vue
│   ├── ModelControls.vue
│   └── ThemeSelector.vue
├── client/
│   ├── protocol.ts
│   ├── socket.ts
│   ├── session-state.ts
│   └── history.ts
├── attachments.ts
├── theme.ts
└── styles/
    ├── base.css
    └── themes.css
```

模块职责：

| 文件 | 职责 |
|---|---|
| `App.vue` | 顶层 reactive state、Server message dispatch 和页面协调 |
| `protocol.ts` | Client/Server wire types、必要 validation 和 message helpers |
| `socket.ts` | connect、disconnect、send、reconnect 和 connection status |
| `session-state.ts` | `sessionId -> SessionUiState`、selected Session 和状态清理 |
| `history.ts` | History page merge、History/realtime merge 和 stable presentation identity |
| `attachments.ts` | MIME、数量、大小、文件读取和 attachment validation |
| `theme.ts` | Theme IDs、preference validation、localStorage 和根属性切换 |

组件保持粗粒度：

- `SessionSidebar` 包含 Session list、create/switch、rename/delete menu 和 connection status；
- `ChatTimeline` 包含 History loading、User messages、Turn list、scroll 和 empty/error state；
- `TurnItem` 包含 text、thinking 和 terminal presentation；
- `ToolCallCard` 包含 input、status、Approval、Result 和 expand/collapse；
- `Composer` 包含 textarea、attachment list、file picker、send/stop 和 keyboard behavior；
- `ModelControls` 同时包含 Model、Thinking 和 Effort；
- `ThemeSelector` 只负责选择 Theme。

`App.vue` 可以继续承担应用协调，不要求为了“纯组件”把所有逻辑移入 service 或 composable。只有复杂纯算法、需要独立测试、跨组件复用或与 DOM/UI 无关的逻辑才抽到模块。

第一阶段不引入：

- Pinia；
- Vue Router；
- feature-based 多层目录；
- repository/service/controller；
- dependency injection framework；
- event bus；
- 通用 Transport abstraction；
- 每个能力对应一个 store 或 composable；
- 设计系统组件库。

状态所有权保持简单：

| 状态 | 建议位置 |
|---|---|
| WebSocket connection/reconnect | `socket.ts` |
| Session list、selected Session 和 Model Catalog | `App.vue` |
| 每 Session draft、History、Turn、Permission 和 attachment state | `session-state.ts` |
| History/realtime projection | `history.ts` 和 `session-state.ts` |
| Theme preference | `theme.ts` |
| menu、picker、hover、focus 等短暂视觉状态 | 对应 Component |

未来实现 Subagent Observation 时，再根据实际复用证据从 `TurnItem` 抽取 read-only `TurnViewer`。本次迁移不预先建设 Observation framework。

## 12. Theme Appearance

`chat.html` 和 `chat2.html` 是同一个 Client 的不同 Theme，不是不同产品能力的应用。迁移后的单一 Client 必须提供运行时 Theme Selector，并保证切换 Theme 时不重建 WebSocket connection、不清空 Session state、不丢失 draft、attachment、History、Approval 或当前滚动上下文。

Theme 应建立在 semantic design tokens 上。候选模型：

```ts
type ThemeId = 'classic' | 'botanical';

interface ClientTheme {
  readonly id: ThemeId;
  readonly label: string;
}
```

两个 Theme 的稳定名称为 Classic (`classic`) 和 Botanical
(`botanical`)。名称表达视觉身份，不沿用 `chat`、`chat2` 文件顺序，
也不把 Theme 与页面模式或 density capability 混为一体。

推荐实现：

- 单一 Vue component tree、单一 protocol/state/transport implementation；
- CSS custom properties 定义 background、surface、text、border、accent、status、shadow、radius 和 typography 等 semantic tokens；
- 允许少量由 `data-theme` 限定的 spacing、density、sidebar、card、composer 和 responsive presentation overrides，以保留两个现有 Theme 的视觉特征；
- Theme 不得改变 Approval、Session、Attachment 或其他产品 capability，不得复制业务 template、protocol 或 state implementation；
- 根元素通过 `data-theme="<theme-id>"` 选择 Theme；
- Theme Selector 展示所有已注册 Theme；
- Theme preference 写入同源共享的 origin-local `localStorage`，不写入 Agent、Session 或服务端配置；
- 使用有效的 origin-local preference；没有有效 preference 时使用 Classic；
- 只有用户通过 Theme Selector 主动选择才更新 preference；
- 在 Vue mount 前应用已保存 Theme，避免初始 Theme 闪烁；
- preference 不可读、值无效或已删除时回退到默认 Theme；
- Theme 切换只改变 presentation，不改变 wire behavior、产品 capability 或业务状态；
- 后续如需 `light | dark | system` color-scheme preference，应与 Theme identity 分开建模，不把 Theme 和系统明暗偏好混成同一个枚举。

本次迁移直接删除 `/chat2.html`，不提供兼容 alias。Botanical 通过
Theme Selector 选择，旧书签在迁移后返回 bounded 404。

## 13. 未来 Observation 兼容边界

[临时单 Turn Agent Session 观察与保留设计调研](ephemeral-single-turn-agent-session-design-draft.md)提出共享的 `EphemeralTurnViewer`、Subagent Observation Modal 和 Automation Run Detail。

本次迁移不实现 Subagent Observation、Automation Detail、explicit subscribe/unsubscribe、ephemeral cache，也不预先抽取 `TurnViewer`。迁移只需避免把 History/live merge 和 Turn presentation 继续锁死在单一 HTML 内。未来真正实现 Observation 时，再根据实际复用证据从 `TurnItem` 和 `history.ts` 抽取 read-only presentation；Approval、Composer 和控制能力不得因此隐式进入只读 Viewer。

## 14. 渐进迁移

### 阶段 0：定位与行为基线

- 明确 bundled Client 是 minimal debug page 还是长期 reference application；
- 记录 `chat.html` 与 `chat2.html` 的 Theme、responsive presentation 和 picker behavior 差异，以两者行为并集为迁移基线；
- 以 Classic (`classic`) 和 Botanical (`botanical`) 作为稳定 Theme 身份；
- 为 protocol validation、History merge、per-Session state 和关键交互建立基线；
- 明确 Source-loaded staging 的现有契约。

### 阶段 1：构建与资源服务

- 增加 Vue 3、Vite 和 TypeScript Client build；
- 生成 `client/dist`；
- 将 Vue 和 marked 打入本地静态产物；
- 扩展 HTTP handler 支持受控 JS/CSS assets；
- 接入 Built 与 Source-loaded staging；
- 接入 root build/prepack 和 Source-loaded development preparation；
- 更新 package allowlist、asset inventory 和 installed-package smoke。

### 阶段 2：行为等价迁移与轻量拆分

- 把现有 template、styles 和 script 迁入 SFC 与 typed modules；
- 按本文 lightweight 目录抽取 socket、protocol、per-Session state、History merge 和粗粒度 components；
- 保持 wire protocol 和 UX 行为；
- 保持 History/realtime merge；
- 保持 Session、Approval、Permission 和 Attachment 行为；
- 将两个 HTML 收敛为单一 component tree、Theme tokens 和必要的 scoped layout overrides；
- 增加 Theme Selector 和 origin-local preference；
- 删除 `chat2.html` 的平行实现和 HTTP 入口，不保留 alias。

## 15. 验证建议

### 15.1 Build 与 package

1. Vite build 在干净 checkout 中成功；
2. `client/dist` 不依赖 CDN；
3. staged Source-loaded Extension 包含完整 dist；
4. staged Built Extension 包含相同 Client assets；
5. root build/prepack 在验证或打包前生成 Client dist；
6. npm/package audit 验证所有引用资产存在；
7. installed-package smoke 实际请求 HTML 引用的 JS/CSS 等静态资产；
8. 安装后无 Vite 和 Client source 仍可启动；
9. Extension load/start 不写 installation。

### 15.2 HTTP assets

1. configured client path 返回 HTML；
2. HTML 引用的每个 asset 都可读取；
3. Content-Type 正确；
4. GET/HEAD 正确；
5. 未知资源返回 bounded 404；
6. path traversal 和任意文件读取失败；
7. `__MY_AGENT_CLIENT_CONFIG_JSON__` 只出现一次并在返回前被完整替换；
8. Client config 中的 WebSocket path 和 initial Theme 通过 runtime validation；
9. configured `clientPath`、WebSocket path 和 asset paths 不冲突；
10. hash assets 与 HTML 使用预期 cache policy。

### 15.3 Client behavior

至少覆盖：

- connect、hello 和 reconnect；
- Session create/list/switch/rename/delete；
- 每 Session draft、attachment、History、Turn 和 Permission 隔离；
- History page merge 和 realtime identity preservation；
- Turn text/thinking/tool/result terminal presentation；
- Approval request、resolve、deny、abort 和 recovery；
- Model、Thinking 和 Effort selection；
- attachment limits 和 unsupported model behavior；
- 两个现有 Theme 的 token、scoped layout 和 responsive presentation 等价性；
- Theme Selector、preference persistence、无效 preference fallback 和无初始闪烁；
- Theme 切换不重连 WebSocket、不清空任何 Session UI state；
- preference 和 Classic fallback 按规定优先级生效；
- `/chat2.html` 在迁移完成后返回 bounded 404；
- mobile layout 与关键 keyboard interaction。

## 16. 风险

| 风险 | 缓解方向 |
|---|---|
| 迁移同时改变协议和 UI | 阶段 2 只做行为等价迁移 |
| Source-loaded 模式遗漏 dist | staging 前 build + staged asset verification |
| Client dist 与源码不一致 | 不提交 dist，或提交时加入 reproducibility check |
| 静态资源服务扩大文件暴露面 | manifest/asset map，不做目录透传 |
| 两份 HTML 继续分叉 | 单一 component tree + Theme registry，禁止 Theme 复制业务 template/script |
| Theme 只有 token 而遗漏现有 layout behavior | 允许受 `data-theme` 限定的 scoped layout overrides，并以两页行为并集验证 |
| Theme 切换重建应用或丢失状态 | Theme 只修改根元素属性和 presentation CSS |
| 保存的 Theme 已被删除或损坏 | validate Theme ID，无效值明确回退默认 Theme |
| Vue state 拆分后破坏跨 Session 隔离 | 先建立 per-Session characterization tests |
| History/live merge 重写引入闪烁或重复 | 迁移原算法并测试 stable identity |
| Vite base path 与 configurable clientPath 冲突 | 在 Spike/Change 中选定并测试统一的 asset path 推导策略 |
| source map 泄露源码 | Production package 默认不包含 source maps |
| Build 工具进入安装时依赖 | build-only dependencies，不用 postinstall |

## 17. Active Change 后续收敛

后续 [WebSocket Client Vue 3 + Vite Migration Plan](../changes/archive/websocket-client-vite-migration/plan.md)
和 WVC-0 已采用：

1. Client 继续作为 lightweight bundled reference client；
2. Vite 使用 `base: './'`，服务端按 HTML route directory 注册精确 asset paths；
3. 正式包只包含 `client/dist`，Client source 只保留在开发仓库；
4. 不新增浏览器 E2E runner，以 Vitest、现有 WebSocket 集成测试和聚焦浏览器验证作为 Gate；
5. Classic (`classic`) 和 Botanical (`botanical`) 是稳定 Theme 名称；
6. `/chat2.html` 直接删除，不提供兼容 alias。

## 18. 建议决策

建议后续正式 Change 采用：

1. Client 继续属于 `websocket-channel` Extension；
2. Client source 位于 `client/src`，build output 位于 `client/dist`；
3. Built 与 Source-loaded Extension 都必须包含提前构建的 `client/dist`；
4. Source-loaded 目标默认不复制 Client source；
5. Source-loaded staging 和 clean-checkout development preparation 都要求在 Host process 启动前执行 Client Build；
6. Extension 安装、加载和启动不构建、不安装依赖、不修改 installation；
7. Runtime 只服务受控 build assets；
8. 第一阶段保持 wire protocol 和 UI behavior；
9. `chat.html` 和 `chat2.html` 收敛为单一 Client、单一 component tree 和 Theme registry；
10. 等价迁移阶段同时交付 Theme Selector，因为两个现有入口的合并依赖该能力；
11. Built server 的 compilation/descriptor/layout 由其 staging contract 另行定义，本草稿只约束 Client dist；
12. Client source 只保留在开发仓库，正式包只包含 `client/dist`；
13. 不新增浏览器 E2E runner，使用 Vitest、现有集成测试和聚焦浏览器验证；
14. Subagent Observation、Automation Detail 和 subscription evolution 不属于本迁移实施范围。
