# Markdown 特殊渲染与 Mermaid 支持设计草稿

> Status: Non-authoritative design draft
> Authorization: 仅用于讨论，不授权实现、安装依赖或执行 Spike，不覆盖 Accepted Decisions、Specifications 或当前源码
> Date: 2026-11-12
> Audience: 项目维护者与 WebSocket Client 实现者
> Scope: Assistant Markdown 的 Mermaid 展示，以及 KaTeX/Mermaid 的结果复用与渲染生命周期

## 1. 目标与讨论基线

以现有 WebSocket Client 的特殊 Markdown 渲染优化为主线，建立完整性判断、稳定身份、结果复用、失效与失败回退的小范围公共机制。首批具体用例是优化已有 KaTeX 公式渲染，并新增 Mermaid 图表支持；本设计不是仅为 Mermaid 添加缓存。

核心体验是：**随流检查、闭合即显、未变不重绘**，而不是等待整个 Turn 结束。普通 Markdown 可以继续整体解析；本轮首先消除特殊渲染的重复重型计算和无效组件重建，不承诺整个消息渲染零重算。

本轮讨论的方向：

- 使用官方 npm `mermaid`，不引入 Vue wrapper，不替换现有 `marked`，不使用外部渲染服务或 CDN。
- 文本更新时识别开始与闭合标记；Vue 自身允许批处理，不要求一个网络 delta 对应一次 DOM 更新。
- KaTeX 与 Mermaid 统一采用显式闭合后渲染：未闭合时保留普通文本/代码源码，不做部分内容预览，也不引入节流预览。
- 新闭合的公式或 Mermaid 块尽早展示；已有且未变化的特殊内容复用结果。
- 上层统一异步渲染接口与生命周期；KaTeX 底层同步、Mermaid 底层异步是适配器内部差异，不要求共用执行队列。

以上是草稿输入，不表示设计、资源限额、安全方案或生产实现已获批准。

### 非目标

- 不改变 Runtime、WebSocket 事件、Transcript 或模型输出格式；原始 Markdown 仍是内容事实。
- 不渲染用户消息、Thinking 或 Tool Result 中的 Mermaid；Root、递归 Child、实时与 History 的 Assistant text 共用入口。
- 不实现图表编辑器、点击回调、任意 HTML、外部资源、缩放拖拽或导出。
- 不预建特殊渲染插件注册协议，不实现完整增量 Markdown 引擎，不将多个旧客户端保留为平行路径。

## 2. 当前事实与权威边界

- [markdown.ts](../../extensions/websocket-channel/client/src/client/markdown.ts) 同步调用 `marked`；原始 HTML 被转义，链接限制协议，Markdown 图片不作为图片加载。完整 canonical LaTeX 通过 KaTeX 生成 HTML，`trust: false`。
- [MessageItem.vue](../../extensions/websocket-channel/client/src/components/MessageItem.vue) 在模板中对整个 text segment 调用 Markdown 渲染，再通过 `v-html` 展示。当前没有公式结果缓存；组件更新可能重复计算既有公式，不等于每次都会重写 DOM。
- [conversation.ts](../../extensions/websocket-channel/client/src/client/conversation.ts) 将 delta 追加到原 segment；没有独立的 text-block-complete 协议。图表完整性应在客户端判断，不以 Turn terminal 作为唯一条件。
- [ConversationPanel.vue](../../extensions/websocket-channel/client/src/components/ConversationPanel.vue) 通过 `nextTick` 维护底部跟随与历史锚点，异步图表的后续高度变化需额外处理。
- [Extension package.json](../../extensions/websocket-channel/package.json) 拥有前端依赖；client 没有独立 package.json。[Vite](../../extensions/websocket-channel/vite.config.ts) 产出本地静态资源；启动时不安装依赖或构建。

当前边界由 [Channels Architecture](../architecture/channels.md) 和 [Channel Specification](../specifications/channel.md) 拥有。本草稿不能将候选设计写成 Current Architecture，也不修改已接受的消息身份、排序、History 合并和 Child 展示规则。

## 3. 公共渲染原则

### 3.1 完整性与响应时点

统一流程为：识别开始标记 → 收集内容 → 识别匹配的显式闭合标记 → 提交渲染。只有闭合后的完整内容才成为渲染候选，不等待回答结束。未闭合公式走普通文本/Markdown 展示，未闭合 Mermaid fence 显示转义源码；不调用特殊 renderer，不尝试补齐语法、部分渲染或节流预览。终止或中断也不把不完整内容自动视为闭合。

append-only 更新优先保留已识别状态，只继续检查新增内容及必要的跨 delta 边界；标记本身可以跨 delta。源码替换或上下文变化时重新解析并核对实例，不把增量识别作为忽略 Markdown 上下文的独立正则扫描器。具体算法仍需验证；普通 Markdown 可以继续整体解析。

- 保留公式现有 `\(...\)`、`\[...\]` 语法与代码上下文排除规则；不新增美元分隔语法。
- Mermaid 由显式 `mermaid` fenced code block 触发。使用 `marked` 的语法事实，覆盖 backtick/tilde、闭合长度、列表/引用嵌套；不以全文正则切割代替 Markdown 解析。
- Markdown 允许 EOF 隐式结束代码块，但本设计的自动图表渲染要求显式 closing fence。token 是否保留足够闭合信息需验证，不能直接把所有 code token 当作完整输入。
- 尾部正文、列表或引用解析可因追加文本而改变；不能把所有已输出 Markdown 永久冻结。

### 3.2 身份与复用不是同一个概念

显示实例身份用于保持组件和用户展开状态；内容键用于判断是否需要执行渲染。相同源码出现两次是两个实例，不因缓存命中而合并。

- 实例身份限定在现有消息/segment 内，使用确定性的块位置或 token 路径匹配；不使用全局出现顺序，不改持久消息身份。
- append-only 更新应保留已有未变块实例。源码替换、History 合并或 token 结构变化时重新核对，不假定 offset 永远稳定。
- 结果键包含渲染种类、源码、实际影响结果的配置及 renderer revision。主题仅在影响输出时参与键，不使所有公式随主题切换无效。
- 保留原始源码作为比较依据，不能只依赖可能碰撞的短 hash；缓存有界、process/page-local，不写入 Transcript、localStorage 或日志。

### 3.3 统一异步契约，按 renderer 调度

上层使用统一的异步渲染契约；概念形式为 `render(request: SpecialRenderRequest): Promise<SpecialRenderResult>`，具体类型在正式设计时确定。KaTeX 适配器封装同步的 `renderToString`，Mermaid 适配器等待其异步渲染 API；调用方不再按库的同步/异步差异维护两套生命周期。这不意味着需要动态插件注册框架。

共用状态语义为 `incomplete → pending → rendering → ready/error`：未闭合时不提交任务，闭合后按结果键复用或提交；已有 ready 结果命中时直接保留展示，不为了走统一接口而闪回 loading。同一实例、同一结果键的在途请求应去重；跨实例结果共享仍受各 renderer 的安全与 DOM 约束，不默认共享 Mermaid SVG。

统一接口不等于统一队列。Mermaid 使用自己的有界执行队列，KaTeX 不排在耗时图表布局之后。Promise 包装不会把 KaTeX 的同步计算移出浏览器主线程，也不会让底层调用自动可取消。

每个请求捕获实例 revision；只有源码、配置、挂载状态仍匹配时才发布结果。卸载、Session 切换或配置变化使旧结果失效，待执行的无主任务应移除；已经开始的库调用若不可取消，只能丢弃其结果并等实际结束后释放执行槽位。

## 4. KaTeX：优化已有特殊渲染

在统一异步契约下，由 KaTeX 适配器封装现有 canonical LaTeX renderer，并增加有界结果缓存；保留现有完整公式语法和错误语义，不增加未闭合公式预览：

- key 为公式源码、displayMode、实际 KaTeX 配置与 renderer revision；保留 `trust: false` 及现有错误展示。
- 缓存只接收通过既有 tokenizer 识别的完整公式，不能让代码块、inline code 或不完整语法误走公式路径。
- 相同键复用 `renderToString` 结果，后续正文追加不重复调用 KaTeX；缓存淘汰后允许重新计算。
- 同时限制条目数与累计源码/结果占用，超大结果不进入缓存；具体限额通过代表性输入测试确定。

此阶段仍可能重跑 `marked` 和替换整段 HTML。公式计算缓存不等于 DOM 增量渲染，也不保证所有重新布局已消除。只有 profiling 证明普通 Markdown 解析仍是瓶颈时，才追加相应优化范围。

## 5. Mermaid：新增异步特殊渲染

推荐官方 npm `mermaid` 完整包起步，首次遇到完整图表时动态加载并复用加载 Promise。依赖由 Extension package 管理、构建时打包，运行时不访问 CDN，不在服务端运行 Mermaid CLI。版本和安全公告需实施前核验，不在未联网确认的情况下指定版本号。

### 5.1 候选客户端职责

| 位置 | 职责 |
|---|---|
| `client/markdown.ts` | 普通 Markdown、安全规则、特殊 token 识别和 KaTeX 结果复用 |
| `components/AssistantMarkdown.vue` | 组合普通 Markdown 与稳定的特殊块实例，供 MessageItem 使用 |
| `components/MermaidBlock.vue` | 图表实例、loading/error、源码切换、复制与卸载 |
| `client/mermaid-renderer.ts` | 一次加载、宿主配置、有界执行与结果管理 |

这些是候选边界，不要求机械增加全部文件。MessageItem 不拥有 Mermaid 队列或库初始化，Mermaid 模块不读取 Session store、不改变会话状态。

优先验证基于 token 树的组合渲染。若采用受控占位符，必须由 parser 直接建立可信映射，避免用户原始 HTML 伪造占位；不能把 Vue 子组件挂到会被下一次 `v-html` 替换的 DOM 下。保留列表、引用、公式和普通代码块语义，避免为渲染 Mermaid 打平整棵 Markdown 树。

### 5.2 渲染与复用

- 显式调用所选版本的渲染 API，不在每次组件更新时扫描整个 document 自动运行。
- 未变化的已挂载实例保留图表 DOM。单一有界执行队列作为起始方案，避免并发初始化或全局配置串扰；并发度和队列限额以验证结果确定。
- 同一轮出现多个新图时逐个执行，正文继续展示。过限、加载或解析失败均回退源码，并显示简短状态，不阻断其他块。
- 首版优先复用实例内结果；不要求跨实例共享完成的 SVG。若后续共享缓存，必须解决 SVG 内 ID、引用、样式作用域和挂载容器差异，不能直接复制含固定 ID 的 SVG。
- 不调用业务点击绑定，不执行图内回调。库生成的临时 DOM 在成功、失败和卸载路径都需要清理。

## 6. 安全与资源边界

消息和历史均是不可信输入。现有 HTML 转义必须保留；Mermaid 生成 SVG 是新增信任边界，不能只因输入不是 HTML 就直接信任。

- 使用核验版本提供的严格安全模式，验证宿主设置不能被 frontmatter、初始化指令或图内配置降级。
- 首版不允许主动链接、点击回调、HTML labels、外部图片/图标/字体或其他外部请求。安全策略需覆盖各支持图型；无法证明满足限制的图型保持源码回退，而不是宣称全部支持。
- 核对库内净化与生成 SVG 的实际输出，决定是否需要额外 SVG 净化或隔离；若依赖净化库，应作为显式依赖评估并验证不破坏图形。严格模式不等于完整沙箱。
- 限制单块源码、节点/边等可用复杂度、排队数量与结果内存。API 限额并非所有图型都一致适用，需验证覆盖范围；具体数值在进入实现前明确。
- 不把原始图表、完整库错误或 SVG 写入常规日志；UI 错误以转义文本展示，源码只留在用户可见内容和有界内存中。

Promise 超时不能中断主线程同步布局；丢弃结果也不表示计算已停止。若代表性压力/恶意输入仍会卡住聊天，应暂停同文档直接渲染方案，评估隔离或缩小支持范围。Worker 并非可默认使用的替代方案，需确认所选图型的 DOM/测量依赖；iframe 的安全与响应性收益也必须实测，不以存在 iframe 就声称硬隔离。

## 7. 主题、布局与阅读位置

客户端现有主题是 Classic/Botanical，不把它们误当成 light/dark。图表配色由宿主主题映射，不接受消息任意覆盖；主题改变使受影响图表失效，不重置消息、Session 或展开状态。KaTeX 若仅由 CSS 继承颜色则不必清空公式缓存。

- 图表区域限制在消息宽度内，复杂图可横向滚动，不把标签缩小到不可读。
- 提供图表/源码切换、复制源码、可访问状态与名称；无须首版加入缩放、拖拽或下载。
- 图表布局完成后通过局部尺寸变化通知或观察接入阅读位置维护，不对每个结果强制滚到底部。
- 底部跟随基于尺寸变化前的用户意图；用户上翻时保持当前位置，加载历史后保留已有锚点，不能在高度增长后才以新距离判断原先是否跟随。
- 隐藏的 Child/折叠内容不提前大量布局；再次展开时验证尺寸，避免隐藏容器测量产生错误结果。首版不额外引入全聊天虚拟列表。

## 8. 验证与可观测验收

| 关注点 | 验证内容 |
|---|---|
| KaTeX 重复计算 | 注入/监视 renderer：完整公式首次执行，后续正文 delta 不再执行；源码/displayMode/config 改变后重新执行 |
| 完整性 | 开始/闭合标记跨 delta、碎片化追加、EOF 未闭合、中断、多块、tilde/backtick、列表/引用嵌套、代码中的公式示例；未显式闭合时两类 renderer 调用次数均为零，闭合后及时提交 |
| 统一契约 | KaTeX/Mermaid 共用状态与失效语义；同实例同键在途去重；ready 命中不闪回 loading；公式不等待 Mermaid 队列；错误与拒绝均进入受控回退 |
| Markdown 回归 | 安全链接、HTML 转义、图片既有行为、普通代码块、表格、列表、引用、canonical LaTeX 与美元文本 |
| Mermaid 生命周期 | 闭合即排队；正文追加保持实例；两份同源图互不干扰；旧结果不覆盖新值；失败/卸载清理 |
| 资源与失效 | 有界缓存淘汰、队列过限、加载失败、主题切换、Session 切换、源码替换及实际执行槽位释放 |
| 安全 | 配置降级、主动链接、外部资源、HTML/SVG 注入、复杂输入；浏览器检查网络请求和页面响应性 |
| 体验 | Root/递归 Child/History 一致，中文标签、两主题、手机宽度、折叠再展开、底部跟随与历史锚点 |
| 交付 | lazy chunks 与间接资源齐全，嵌套 clientPath、离线本地加载、Host/npm 包安装后验证 |

性能证据同时记录特殊 renderer 调用次数、代表性消息下解析/渲染耗时与构建 chunk 体积；缓存淘汰后的重新计算属于预期。不用“完全不重渲染”或未经测量的毫秒/体积目标代替验收。

现有 MessageItem 测试使用 SSR，不能证明浏览器 DOM、SVG 测量与异步滚动正确。实现应有纯函数/缓存单测、组件生命周期测试及实际浏览器检查。按 Extension package.json 使用 focused tests、`lint:client`、`build:client`、`verify:client`；按变更边界增加 Host/package 验证，不在每次局部修改后固定运行全仓库 Gates。

## 9. 进入实施的方式

以 [Development Workflow](../governance/development-workflow.md) 为唯一流程权威；本次只是 Documentation/非权威讨论，不创建已获批准的交付记录。

1. **确认设计范围。** 以特殊 Markdown 优化为整体目标，KaTeX 复用和 Mermaid 是两个交付用例，不把未来所有特殊语法纳入本轮。
2. **消除可直接核对的不确定性。** 查官方版本/API/安全公告，验证 marked token 和实际资源路径；不把普通事实问题交给 owner 决策。
3. **必要时提出有界 Spike。** Mermaid 安全覆盖、DOM 生命周期或复杂输入若会改变架构结论，依模板准备 Spike Spec，owner 接受后才执行。记录具体假设、输入、通过/失败条件及 Results，不因“使用外部库”就展开无边界实验。
4. **形成正式交付材料。** 当前方案涉及渲染生命周期、资源所有权和展示契约，预计按 Architecture Slice 管理：建立 Active Change 的 Plan Item 与适用 Spec；若存在难逆的安全隔离选择或重要边界取舍，再按流程判断 ADR 必要性。owner 批准且 Ready 后进入 Delivery。
5. **小步验证。** 优先验证 KaTeX 结果复用，再引入特殊块组合与 Mermaid，最后覆盖主题、滚动、安全和打包。首次实质实现后立即运行最小 focused check，不等全部写完才验证。
6. **交付时路由权威。** 已接受的长期展示契约写入 Channel Specification，已验证的当前事实写入 Channels Architecture，临时交付和测试证据留在 Change；Research 仅更新为讨论来源，不从权威文档反向依赖本草稿。

所有阶段均不顺带改 Runtime、消息协议或已有 Markdown 语法。若 token 组合破坏嵌套结构、安全限制无法成立或实际成本明显增大，暂停受影响方案并回到设计确认，不悄悄切换到宽松模式或外部服务。

## 10. 待验证项与证据限制

- Mermaid 版本、显式渲染 API、配置锁定、SVG 净化和各图型外部资源行为尚未核验，支持图型集合及具体资源限额在实现前确定。
- marked 对 closing fence 的可观察信息、嵌套 token 组合与实例匹配需 focused 验证；本草稿未声称已有完整可用算法。
- 动态 chunk 体积、实际布局成本、SVG ID/样式隔离和主题重绘没有测量结果。
- 现有资源审计主要核对 HTML 直接引用；lazy chunks 的依赖闭包、间接资源和部署路径需要额外验证，不假定现有脚本已覆盖。

截至 2026-11-12，本草稿基于源码、现有测试阅读和讨论形成，没有安装 Mermaid、运行实验、测试或构建。官方页面读取被当前权限模式阻止，以下链接是后续核验入口，不是已读取并证实的资料：

- [Mermaid 官方仓库](https://github.com/mermaid-js/mermaid)
- [Mermaid usage](https://mermaid.js.org/config/usage.html)
- [Mermaid configuration schema](https://mermaid.js.org/config/schema-docs/config.html)
- [Mermaid npm package](https://www.npmjs.com/package/mermaid)

文档检查若受同一终端权限限制，应明确记录未执行项；后续按工作流完成链接检查、文档 diagnostics 和 `git diff --check`，不把草稿创建视为生产方案已验证。
