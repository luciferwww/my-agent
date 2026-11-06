# Session Execution Presentation: Validation Record

> Date: 2026-11-04
> Status: SEP-ID through SEP-4 implemented; SEP-5 overall validation recorded, implementation review and owner acceptance pending
> Related: [Plan](plan.md), [Accepted Specification](specification.md)

## 1. Design-stage scope and method

核实当前已有的运行中订阅／History 行为，不实施新的祖先投递、展示记录或完整 Turn 分页，也不引入 Spike。

测试：[history-observation.test.ts](../../../../extensions/websocket-channel/client/src/client/history-observation.test.ts)。

使用真实临时 Session Transcript、SessionManager、监听 `127.0.0.1` 随机端口的 WebSocketChannel 和真实 WebSocket 客户端，断言实际 wire response 等于对应持久 History，再调用当前客户端 applyAgentEvent、beginHistoryRequest、applyHistoryPage 和 mergeRealtimeWithHistory 检查呈现数据。每例关闭连接、服务及 SessionManager，并清理专属临时目录。

限制：

- 流式事件和消息提交由测试显式驱动，不使用真实 Provider，也没有启动完整 Runtime Turn。
- 未挂载 Vue App／DOM；测试执行其实际归约函数和请求补刷步骤，不包含页面生命周期和浏览器调度。
- 首次打开／重连案例显式将流事件和消息提交放在订阅确认与 History 请求之间，覆盖请求被网络延迟时可出现的顺序；不是对 App 自动请求该窗口发生频率的测量。
- 因而可证明受控 wire 时序下现有合并的行为，不能宣称每次真实页面打开都会重复，也不能宣称端到端页面验证完成。

## 2. Pre-implementation baseline results

| Scenario | Controlled sequence | Pre-fix outcome |
|---|---|---|
| 运行中首次打开 | A 在订阅前产生；订阅后收到 BC；来源落盘 ABC；History 返回该消息，Turn 尚未结束 | 展示数据为 ABC、BC，前缀合并无法消重 |
| 运行中断线重连 | 本地先收到 A；断线缺少 B；重连后收到 C；History 返回 ABC | 本地 AC 与历史 ABC 均保留，运行中重复 |
| 上述 Turn 结束 | run_end 触发最新 History，返回完整短 Turn | 整 Turn 接管后仅一份 ABC |
| History 请求期间结束 | 取旧快照后延迟响应；期间收到 finished 并落盘、run_end；旧响应随后到达 | 旧请求不清除实时内容；终态刷新被排队，新快照到达后正确接管 |

前两例是当前缺口的 characterization，不是将重复输出定义为期望产品行为。不能因为这些断言通过，就将运行中合并验收标记为通过。

已有前缀合并回归也通过：历史 partial 与实时 partial response 合并为一份更完整的实时文本。

## 3. Interpretation

- 先订阅再加载 History 可以覆盖请求期间的事件，但不自动消除重叠。
- 当前终态补刷机制有效；不能将旧运行中快照误当作终态快照。
- 完整 Turn 分页解决终态时的分页截断，不单独解决运行中后缀／缺段重叠。
- 只保存用户输入 messageId 到 entryId 的关联不能解决上述 Assistant 文本问题；Assistant 消息也需要消息级身份，不需要恢复 message_committed 通知。
- 运行中重叠是已有行为，不是本 Change 新增缺陷。后续 owner 已确认将可选 messageId 关联纳入 Change，保持两种已有 ID 不变，同时补齐 Assistant 身份；不采用覆盖不足的 invocation ID。此次验证没有实现或验收该修正。

## 4. Checks

初始将跨层测试放入服务端测试文件，导致客户端 Bundler 模块被 NodeNext checker 拉入；已移至客户端测试目录，并给客户端 checker 添加与现有 Vitest／Channel 一致的 extension-api 源码映射。未修改生产消息或路由逻辑。

最终检查：

```text
npx vitest run --config vitest.unit.config.ts extensions\websocket-channel\client\src\client\history-observation.test.ts extensions\websocket-channel\client\src\client\client-core.test.ts extensions\websocket-channel\WebSocketChannel.test.ts
80 passed (3 files; includes 3 new timing cases)

npm run lint --workspace @my-agent/websocket-channel
passed: Channel tsc and client vue-tsc
```

没有运行完整构建，也没有以此宣称本 Change 的目标行为已经实现或通过验收。

## 5. SEP-ID implementation validation

owner 在独立复审后确认继续，首先实施消息身份关联；本节结果取代前述测试文件在修正前的当前状态，但保留基线证据。

已实现：

- MessageRecord 顶层可选 messageId，保持 entry ID 的生成和含义不变；History 原样投影，模型 payload 不携带该字段。
- 新 Transcript 使用 v3；旧 v1/v2 在首次关联写入前原子升级，不改既有记录 ID，不补造旧消息身份；读回与 fork 保留关联。
- 用户输入、steering 原样贯穿已有身份；每条 Assistant 消息单独分配 ID，覆盖 llm_call、文本、Thinking、tool_call_requested 及正常／abort partial 落盘。Provider invocation ID 未被改作消息身份。
- 客户端按消息身份分段；已提交消息的历史正文／Thinking 消除后缀和缺段实时重叠，未提交的下一条消息仍保留，相同文本不同身份不合并。
- 中途订阅可从 Thinking delta／end 恢复片段；历史工具卡能接收实时状态覆盖，覆盖在 History 重建后继续保留，不为内部工具事实增加 messageId。

测试覆盖了原始输入与 steering、Thinking 身份、正常／abort 落盘、多次模型调用独立身份、v1/v2 升级、非法身份拒绝、fork／重载、相同文字不同消息、下一条未提交消息、Thinking 缺少 start、多工具结果同一历史消息及历史工具卡后续更新。

原先两个受控 socket 重叠案例已转成修复回归：首次打开 ABC＋BC 和重连 ABC＋AC 均只呈现一份 ABC，Turn 仍运行时就消除重叠；请求期间结束的 deferred terminal refresh 继续通过。

最终命令与结果：

```text
npx vitest run --config vitest.unit.config.ts src\core\session src\core\runner src\runtime\RuntimeApp.test.ts extensions\websocket-channel\WebSocketChannel.test.ts extensions\websocket-channel\client\src\client\client-core.test.ts extensions\websocket-channel\client\src\client\history-observation.test.ts extensions\websocket-channel\client\src\client\message-identity.test.ts
402 passed (22 files)

npm run lint
passed: Core, Relay, Channel tsc and client vue-tsc

npm run build
passed: client build, 62 client assets verified, TypeScript/Host build,
Host audit (366 files), configured Relay tests (121 passed, 7 files)
```

环境限制：命令使用现有 Node 20.16.0，Vite 提示需要 20.19+ 或 22.12+，项目 engines 要求 22.x；构建实际退出 0，但不据此认证旧 Node 为受支持版本。本轮没有切换全局 Node 或安装依赖。

本阶段仍未挂载完整 Vue 页面或真实 Provider 运行，socket 事件由测试驱动；不承诺断线期间未持久 delta 的重放。祖先展示副本、祖先投递、完整 Turn 分页、内嵌 Child 和相关终态收敛仍待后续阶段，不能以当前阶段通过宣称整体目标通过。

## 6. SEP-1 ancestor retention and whole-Turn History

在上一阶段后，owner 确认继续实施祖先留存。由于加入后代消息后硬切条数可能只返回 Child 而漏掉父调用，本阶段同时实现已接受的完整本地 Turn 累计分页；不是新增设计或嵌套分页 API。

已实现并验证：

- v3 `presentation` 白名单：安全消息、工具 accepted／terminal、Child start／end；来源消息保留 messageId，Thinking 不含 invocation／replay。原生 getMessages／模型 Context 不读取副本，追加和重载均不推进祖先 leaf。
- Root → A → B 逐级祖先各保存一次来源事实，不重新传播副本；固定委派 Assistant 锚点不随 steering 移动。相同 messageId／callId／executionId 的不同来源相互隔离。
- 来源写锁先释放，再 await 目标串行写入；并发来源和祖先写入不相互持锁。目标失败显式携带来源／目标传播，已经落盘的来源不伪造回滚。部分生命周期写入可按相同事实身份幂等重放，不引入自动恢复队列。
- start 持久化先于可观察事件；end 持久化先于终态事件及树成员释放。start／end 写入失败不能被 fanout catch 吞掉，仍清理已获取资源。受控 gate 验证 end 写入未完成时没有终态事件，也没有提前释放。
- 执行期间登记 Child 为递归 Parent；继承根监督、captured registry 和审批能力，使用 Child 已解析模型与合并后的 contextFiles，内部 contextFiles 不透传为 Runner 参数。
- History 输出来源 items 与 scopes，从祖先本地事实补工具状态；缺 end 且本目标无活动路由时为 unknown。删除 Child 文件后，重载祖先仍可恢复。
- 请求 20 的 10＋15 → 25、50 → 50、仅 10 → 10，以及输出 105 的实际阈值断言；拒绝 Turn 内部和失效分支游标。工具／生命周期事实不独立计数。
- fork 当前快照包含 leaf 之后的已留存事实，显式 entryId 切点排除后续副本；无关分支不带入，fork 不继承活动路由。v1/v2 祖先首次展示写入升级 v3 且保持原生 IDs。
- 真实 WebSocket 请求在 Child 清理后仍返回来源身份与 scopes。bundled client 暂不将副本扁平混入父正文，CLI bounded recent-history 同样保持本地消息视图；完整 Turn 页仍含父消息，不因后代占页而变成空父页。递归 slot 尚未交付，既有独立 Child 查看入口暂保留。

新增 `SessionManager.presentation.test.ts` 覆盖存储／History／分支／fork／失败／并发；`transcript.test.ts` 覆盖版本、锚点、来源、白名单和重复事实拒绝。Runtime 递归接线集成使用真实 Runtime、SubagentExecutor 和 SessionManager，但 Runner 是受控 stub；真实 Runner 的现有聚焦回归同时通过，不将该集成称为真实 Provider 端到端执行。最初扩大回归发现三个 Runtime 测试的 SessionManager stub 缺少新增方法，已补齐测试 fixture，没有为迁就 mock 增加生产 fallback。

命令与结果：

```text
npx vitest run --config vitest.unit.config.ts src\core\session src\core\runner src\core\subagent src\runtime\RuntimeApp.test.ts src\runtime\subagent-orchestration.test.ts extensions\websocket-channel\WebSocketChannel.test.ts extensions\websocket-channel\client\src\client\client-core.test.ts extensions\websocket-channel\client\src\client\history-observation.test.ts extensions\websocket-channel\client\src\client\message-identity.test.ts
510 passed (31 files)

npx vitest run --config vitest.unit.config.ts src\core\session\transcript.test.ts src\core\session\SessionManager.presentation.test.ts src\runtime\subagent-orchestration.test.ts
72 passed (3 files; overlapping final validator check)

npx vitest run --config vitest.unit.config.ts src\builtins\channels\cli\CliChannel.test.ts
48 passed (1 additional file)

npm run lint
passed: Core, Relay, Channel tsc and client vue-tsc

npm run build
passed: client assets (62), TypeScript/Host build, Host audit (366 files),
configured Relay tests (121 passed, 7 files)
```

使用既有 Node 20.16.0，Vite 的版本警告仍存在，构建实际退出 0；项目支持要求仍是 Node 22.x。本轮没有安装依赖或切换全局 Node。

以上均为相关聚焦测试，不是完整测试；使用独立临时 Agent Home 并清理，未删除用户实际 Agent Home 的 sessions。owner 已要求今后运行完整测试前先删除该目录；实际执行前须确认真实路径，只清理该 sessions，不扩大到工作区或 Agent Home 根目录。

当前 SEP-1 为 In Review。祖先实时投递／generation 路由、固定 slot 与递归 UI、Approval 归位、Tool 分组和完整浏览器／集成验收仍未交付；此阶段通过不表示整个 Change 完成。

## 7. SEP-2 ancestor realtime delivery — 2026-11-04

owner 确认继续，并要求避免过度设计及扩大范围。本节更新上一阶段“祖先实时投递未交付”的状态，不改写其历史验证证据；本次没有实现 UI、改动控制权限或新增 Spike。

实现范围：

- 复用 SessionManager 已有的委派展示路由，捕获不可变的 rootTurnId 和 ancestorSessionIds。没有新增执行树注册表、观察身份、模式开关或事件流，也未增加 Transcript 字段。
- ChannelInstance／Runtime binding 的 send 增加可选 ChannelEventRouting 参数；Runtime 按该 Root Turn 选择 captured Channel projection，事件主体的来源 sessionId、turnId、messageId 保持不变。原 observer 仍接收原事件。
- WebSocket 按来源和全部祖先的显式 Session 受众取并集，每连接仅发送一次；序列化已有祖先身份用于后续 UI 归位。Child lifecycle 不再只面向 caller，而与普通来源内容采用同一受众规则。无来源 request_end 保持原 originMessage 路径。
- 不向 clientSessions／sessions 写入隐式 membership；接收后代不授予发送、审批或取消 Child 的权限。每次发送读取当前成员关系，退订／断线／重连不依赖缓存的接收者表。
- end 持久化完成后，等待终态 Fanout settle，再清路由及释放树成员；subagent_end 同时纳入已有 Shutdown terminal Fanout 跟踪。传输失败仍走既有隔离／记录路径，持久化错误继续显式传播。
- CLI 不把带后代路由的 run_start／run_end 用作 Root 输入锁或 Root 调用上限提示；未调整其文本层级或实现新的 CLI UI。

验证：

1. 真实 socket 同时订阅 Root、A、B 的重叠受众，收到 B 的 start、run_start、Thinking、文本、Tool 请求、run_end、end 各一份。Root-only、A-only、B-only 正确收到真实来源，非相关受众不收到；Root-only 未获得 B membership，向 B 发送仍被拒绝。
2. 退订 Root 后不再收到 B；通过有序响应 barrier 核对没有残留投递。重连并重新订阅后恢复后代事件，不复用旧接收者列表。
3. 递归 Runtime 集成使用真实 Runtime、SubagentExecutor、SessionManager 和 Channel binding；Runner 为受控 stub，通过实际 onEvent 发出 Child native text。在 Root 捕获 N 后发布 N+1 新 Channel，两个递归 Child 的 start／text／end 六次投递全部带原 Root 路由且只发向 N 的绑定，新 Channel 不收到它们。
4. 受控终态 delivery Promise 未完成时，展示路由、active Parent 和树成员不提前释放；完成后清理。存储路由及祖先数组不可变，删除 Child 后清除。既有 sibling 并发／取消、Fanout 失败隔离及 Shutdown 回归同时通过。
5. 客户端仅增加回归测试：带 Root 路由的 Child run_end 仍按真实来源归入 Child，Root activeTurnId 和其余状态不被清理。未改动 Vue 页面，也未宣称固定 slot 已实现。

命令与结果：

```text
npx vitest run --config vitest.unit.config.ts src\core\session src\core\runner src\core\subagent src\runtime\RuntimeApp.test.ts src\runtime\runtime-builder.test.ts src\runtime\channel-lifecycle.test.ts src\runtime\subagent-orchestration.test.ts src\runtime\runtime-composition-manager.test.ts src\builtins\channels\cli\CliChannel.test.ts extensions\websocket-channel\WebSocketChannel.test.ts extensions\websocket-channel\client\src\client\client-core.test.ts extensions\websocket-channel\client\src\client\history-observation.test.ts extensions\websocket-channel\client\src\client\message-identity.test.ts
610 passed (35 files)

npm run lint
passed: Core, Relay, Channel tsc and client vue-tsc

npm run build
passed: client assets (62), TypeScript/Host build, Host audit (366 files),
configured Relay tests (121 passed, 7 files)
```

使用现有 Node 20.16.0，Vite 版本警告仍存在，构建退出 0；未切换全局 Node 或安装依赖。测试为相关聚焦范围，不是完整测试，没有删除实际 Agent Home 的 sessions；完整测试前清理要求继续按第 6 节执行。

SEP-2 为 In Review。下一阶段为固定 task slot、递归 UI、Approval 归位及旧 Child viewer 替代；完整浏览器／真实 Provider 验收、Tool 分组和整体 Change closeout 仍未完成。

## 8. SEP-3 recursive inline client — 2026-11-04

owner 确认继续。本次仅交付固定 task slot、递归正文／Thinking／工具、来源隔离合并、已有 Approval 挂载和独立 Child viewer 替代；不实施 LLM-call 工具分组，不增加协议字段、后端注册表、权限、依赖或新观察模式。

实现与自动验证：

- 复用现有 per-Session live state。History records 留在查询 Session，按 sourceSessionId 投影到各来源的历史视图后，再复用 messageId／callId 合并；不把 Child 正文扁平插入 Root。相同 messageId／callId 出现在不同来源时互不消费，Tool Result 同时限定本地 Turn。
- task 在父 Tool Call 的既有位置渲染；生命周期只提供归属和状态，不按到达顺序追加 slot。完整身份但尚无父卡片的 lifecycle 暂存，等真实父调用出现再挂载，不补造调用；身份不足且无法匹配的事件仍走协议错误路径。
- MessageItem 递归复用正文、Thinking、工具输入／结果及审批动作；默认展开 Child 内容，显式折叠／展开选择在运行中 History 刷新和终态接管后保持。删除独立 ChildDetailPanel、相关 App 状态／订阅流程和专用样式，保留 Child History API 和 TTL 所有权。
- Child run_end 只结束其来源状态；Root 必须具有实际终态事件及之后的新快照，且该 Turn 的全部后代 scopes 已 terminal，才整体接管并清理相应 live 内容。running／unknown scope 阻止整体清理；中途订阅时 activeTurnId 为空不代表 Root 已结束。
- pending latest 刷新使用独立返回信号，覆盖“不带 Root 终态标记”的 Child 刷新；较早请求成功或失败后均可串行补刷，不因 terminalTurnIds 为空而丢失。旧运行中请求仍不能被事后追加终态清理标记。
- Root-addressed Approval 通过委派链和 Child turnId/callId 挂到真实工具卡。尚无可见卡片时保留可操作的 pending 入口，归位后仅显示一处。closure 同步匹配视图并退出 awaiting-decision 工具状态；历史不重激活已关闭请求。提交仍为既有 approval_resolve／approvalId。
- 新增 execution 聚焦测试 26 例，覆盖并发／递归、延迟关联、来源隔离、缺段及相同文字、未知／运行中 scope、终态接管、前后请求时序、旧分支替换、较早 Turn scopes 保留、折叠状态和 Approval。客户端完整保留 105 项 Turn 的 104 条 Child 消息，不再按请求最大值截断。
- 既有真实 SessionManager／WebSocket 测试增加客户端执行投影断言：Child 已删除后，socket 返回值与规范 History page 完全一致，祖先中的副本仍归入正确 task。

挂载浏览器验证：

使用本次生产构建的 Vue／CSS assets、真实浏览器和 loopback HTTP/WebSocket fixture；fixture 控制 History 快照、响应延迟和事件，不使用 Runtime 或真实 Provider。

1. Root 内 a、b 两个 task 保持调用顺序，虽先收到 b 的 start／文本，随后 a 的 Thinking／工具、c 的递归输出及交错 delta。a、b、c 的文本各只出现一次，c 位于 a 的真实工具下，不出现在 Root 正文。
2. nested Approval 在调用未出现时有可操作 fallback，调用出现后仅一份 Allow/Deny。实际点击嵌套 Allow，只提交一次 approval_resolve；approved closure 后工具退出 Approval required 状态。记录中只有 Root 订阅，没有 Child 订阅或 Child History 请求。
3. Child run_end 不终止正在运行的 Root。Root 终态新快照接管后，完整正文各一份、实时后缀无残留，显式折叠保持。另验证中途打开场景：无 Root run_start，Child end 和已 terminal 的 Child 快照仍不会清理 Root 未提交正文。
4. 延迟一个旧 History 响应，期间写入较新 Child 内容并发送 Child end；释放旧响应后实际发出一次串行补刷。两次请求后显示新持久 Child 内容，同时保留 Root 未提交后缀，不需要 Root run_end 才恢复。
5. 向前加载 20 个完整较早 Turn，Root 阅读锚点 top 从 184px 到 183.6875px，差约 0.31px；递归内容仍在。断线后自动恢复到 Online，重新订阅仍只有 Root，全部四条 Root／Child 正文各一份。
6. 390px viewport 下 Classic／Botanical 的 document scrollWidth 均为 390px，chat scrollWidth 分别等于其 clientWidth（373／375px），无横向溢出。Thinking 可展开；检查期间无 browser error／unhandled rejection。

命令与结果：

```text
npx vitest run --config vitest.unit.config.ts extensions\websocket-channel src\core\session
240 passed (16 files)

npm run lint
passed: Core, Relay, Channel tsc and client vue-tsc

npm run build
passed: 62 client assets, Host audit (366 files), Relay tests (121 passed, 7 files)
```

仍使用 Node 20.16.0，Vite 的版本警告仍在，构建退出 0；不据此认证该 Node 版本受支持。没有安装依赖、切换全局 Node、删除实际 Agent Home 会话、commit 或 push。测试为上述聚焦范围，不是仓库完整测试；完整测试前的 sessions 清理约定不变。浏览器 fixture 已停止并清理。

SEP-3 为 In Review。此处已挂载真实生产 UI，但使用受控 socket 数据，不等于真实 Provider／完整执行链路端到端验收。SEP-4 LLM-call Tool 分组和 SEP-5 整体 closeout 仍待推进。

## 9. SEP-4 LLM-call Tool 分组（2026-11-04）

实现使用已有调用边界，不增加 invocation UUID 或新的执行框架：

- Runner 的真实 Assistant 正常记录和 abort partial 留存顶层可选 `llmRound`（从 0 开始）；用户、工具结果及合成 Assistant 不伪造此字段，也不进入 Provider 消息或模型 Context。
- Session 写入与 Transcript 加载拒绝非 Assistant 或非非负安全整数的 round；v1/v2 首次使用该字段前原子升级 v3，保留已有 entry ID。安全 History 和各祖先展示副本保留该字段。
- 实时每个 `llm_call` 创建新 UI-local 组；History 每个带标记的 Assistant entry 独立分组，重复 round 不合并。缺历史事实或错过实时边界时不猜，收到权威 History 后可补齐。
- 保留原扁平顺序，只包装相邻同组工具，不跨正文／Thinking 搬移。Root 和各 Child 来源独立，递归 slot、工具状态和原 Approval 路径继续复用。
- 组默认展开，完成不自动折叠；运行中刷新与终态接管均保留组身份及显式折叠选择。折叠组的直接 pending 审批显示提示，展开后仍是单份原操作。

自动验证：

- 新增 17 例客户端分组测试，覆盖重复 round、来源隔离、真实 legacy 事件、text-only、错过边界、终止／新 Turn、旧历史、overlay 补齐、History 接管、完成不自动折叠、正文／Thinking 顺序及非法 round。
- 存储增加 9 例校验／旧版本升级测试，Transcript 增加 10 个非法字段案例；现有 Runner、递归祖先留存和真实 socket Child 清理恢复测试补充 round、abort partial 和不泄漏模型消息的断言。
- 递归 Vue 模板增加实际 SFC parse/compile 回归；不能只以 vue-tsc 成功代替生产模板编译。

```text
npx vitest run --config vitest.unit.config.ts
  src/core/session src/core/runner src/core/subagent
  src/runtime/RuntimeApp.test.ts
  src/runtime/runtime-builder.test.ts
  src/runtime/channel-lifecycle.test.ts
  src/runtime/subagent-orchestration.test.ts
  src/runtime/runtime-composition-manager.test.ts
  src/builtins/channels/cli/CliChannel.test.ts
  extensions/websocket-channel
passed: 685 tests, 41 files

npm run lint
passed

npm run build
passed: 62 client assets, Host audit (366 files), Relay tests (121 passed, 7 files)
```

挂载实际生产 assets、使用真实 SocketClient 和 loopback WebSocket 的受控浏览器检查通过：

- 初始 Root 两次 round 0 与 A/B 的 round 0 共四个独立组，均默认展开；旧消息无组。
- 实时 Root 再发两次 round 0、A 再发一次 round 0，共七组，未跨调用或来源合并；Child 仍挂在真实父工具卡。
- 折叠 Root 的历史组和实时组后，运行中 History 补齐及 Root 终态接管仍保留原组 ID／折叠选择；七组无重复，另一个展开组工具成功后仍展开。
- Child 组折叠时提示 Approval required；展开仅一份 Allow/Deny，Allow 仍只发送 `{ type: 'approval_resolve', id: 'review-1', decision: 'allow' }`，关闭后不残留 pending 提示。
- 390px Classic／Botanical 的 document scrollWidth 均为 390px；运行中及终态检查未捕获页面 error／unhandled rejection。

仍使用 Node 20.16.0，Vite 的版本警告仍在，最终构建退出 0；不据此认证该 Node 版本受支持。没有安装依赖、切换全局 Node、删除实际 Agent Home 会话、commit 或 push。本次 685 例是上述聚焦范围，不是仓库完整测试；完整测试前的 sessions 清理约定不变。

`git diff --check` 通过。浏览器已导航回空白页，临时 fixture 服务已停止、脚本已删除。

SEP-4 为 In Review。浏览器使用受控 socket 数据，不等于真实 Provider overflow 重试或完整 Runtime 执行链路端到端验收；重复 round 的分组行为有独立自动和页面检查，未声称实际 Provider overflow E2E。SEP-5 整体验收、独立审核及 owner 确认仍待推进。

## 10. SEP-5 整体回归与验收清单（2026-11-04）

### 清理与执行环境

owner 明确指定 Agent Home 为 `C:\dev\my-agent\my-agent\test-workspace`。只删除其 `sessions` 普通目录（检查无链接／重解析点），确认删除成功后再运行完整测试；没有删除 Agent Home 本身、其他数据或 `test-workspace1/sessions`。测试结束后指定 sessions 仍不存在。

最初 `npm run test:all` 使用默认发现规则，额外扫描了 `test-workspace1/rea-research` 等其他项目，结果为 1249 个文件失败、282 通过、14 跳过；343 例失败、3923 通过、89 跳过，另有 9 个未处理错误。该结果不标记通过，也不通过安装那些项目的依赖来扩大本次范围。改用仓库已有 unit／integration／fitness 配置明确本项目边界，未修改测试发现配置。

本机默认 Node 20.16.0 与现有 better-sqlite3 二进制 ABI 不匹配（需要 Node 22）。通过 `npm exec --yes --package=node@22 -- ...` 使用隔离的 Node 22.23.3；只获取测试运行时到 npm 缓存，没有更改全局 Node／PATH、项目依赖清单或 lockfile，也没有重编译共享原生依赖。

### 直接相关修正

- [RuntimeApp.intake.test.ts](../../../../src/runtime/RuntimeApp.intake.test.ts)：测试 SessionManager 替身补齐新增 `getSubagentPresentationRoute` 查询；FIFO claimed 输入断言严格核对各自原始 `user_message.messageId`，不通过宽松匹配忽略身份。无生产行为变更。
- [execution.test.ts](../../../../extensions/websocket-channel/client/src/client/execution.test.ts)：固定 slot 案例扩为三个 Child，启动顺序 c/b/a、交错文本和同名工具调用、完成顺序 b/a/c，核对父卡顺序 a/b/c、各来源结果及 terminal scope。原有两 Child 案例不能直接当作三 Child 验收证据。

### 最终检查

以下命令在仓库根执行：

```text
npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.unit.config.ts
passed: 1692 tests, 124 files

npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.integration.config.ts
passed: 23 tests, 7 files

npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.fitness.config.ts
failed: 4 tests, 39 passed; 3 files failed, 10 passed

npm exec --yes --package=node@22 -- npm run lint
passed

npm exec --yes --package=node@22 -- npm run build
passed: 62 client assets, Host audit (366 files), Relay tests (121 passed, 7 files)
```

Node 22 构建不再出现旧 Node 的 Vite 版本警告。全量单元及集成结果包含修正后的 intake／三 Child 案例，不以先前 685 例聚焦结果代替本节结果。

fitness 四项失败已对照 HEAD 核实存在基线漂移，未扩大范围处理：

| Check | 实际失败 | 基线核实与处置 |
|---|---|---|
| FT-01 production classification | `src/runtime/agent-home-lock.ts` 未分类 | 该源文件及 fitness 清单均为未修改的 HEAD 内容 |
| FT-09 stale authority scan | 强制扫描不存在的 `clients` 目录，ENOENT | HEAD 同样没有此目录，扫描规则仍引用它；未恢复旧目录或吞掉错误 |
| FT-12 authority metadata | 固定要求全部 Verified 为 2026-09-18，实际先遇到 2026-10-15 | HEAD 的 extensions／prompt／providers／runtime 文档已使用后续日期；本 Change 也依法更新受影响文档的验证日期，不为通过断言回退事实 |
| FT-12 output capability string | 要求 Chat Client 包含 `max_tokens: request.outputTokenLimit` | HEAD 已按 Model 选择 `max_tokens`／`max_completion_tokens` 动态键；Provider 与对应检查均未修改 |

因此不能宣称完整测试全绿，不能将 SEP-5 标记 Completed。默认发现边界及上述 fitness 治理应单独处理，不属于新增展示功能。

### 验收证据索引

| Area | 已有／本轮证据 |
|---|---|
| Routing | WebSocketChannel 的来源＋祖先受众并集、去重、取消订阅／重连和无 membership 提权；Runtime 的 Root captured generation 与终态 Fanout 等待，见第 7 节及完整单元回归 |
| Persistence | SessionManager.presentation 的各祖先一次、安全白名单、无观察者、Context／leaf 隔离、重载／fork／分支及写失败显式传播；真实 socket Child 清理后读回，见第 6–9 节 |
| Concurrency | 本轮三个 Child 交错文本／工具／不同完成顺序；递归三层恢复和来源隔离；第 8 节生产页面交错／递归检查 |
| Pagination | 请求 20 的 25／50／10／105 条完整 Turn、完整后代、游标及分支；客户端不二次截断，第 8 节浏览器分页锚点 |
| Message identity | Runner 正常／abort partial、输入／多次 steering、intake FIFO 原 ID、旧版本升级；内部 Tool 生命周期不伪造消息身份，Host／多工具结果沿既有安全投影 |
| Reconciliation | message-identity／history-observation／execution 测试的后缀与缺段、不同身份同文、未提交消息、后续工具状态、延迟补刷、后代收敛与 Root 终态 guard；第 8–9 节挂载生产页面恢复检查 |
| Approval | Root audience＋Child turn/call 挂载、未加载 pending fallback、单份操作、关闭同步和历史不激活；第 8–9 节页面操作仍只发原 approvalId |
| Failure／compatibility | ancestor start/end 写入及 Fanout 失败、资源释放、v1/v2→v3 保留 ID、旧数据不补造身份／round、unknown scope 不推断成功 |
| Tool grouping | 第 9 节实际边界、重复 round、来源隔离、默认展开、完成不自动折叠、刷新／终态选择保留及旧数据不猜 |
| Delivery | 旧窗口已移除；本轮补齐 Channels 架构中的祖先路由、递归 UI、messageId 合并和工具组说明，并修正活动 Spec 尾部的旧阶段状态 |

上述为实现／测试证据核对，不冒充独立实现复审。浏览器证据仍为受控 socket，不是实时真实 Provider E2E；本轮没有改变生产代码，不重复声称新增浏览器执行。独立实现复审、fitness 失败的验收处置及 owner 最终确认尚未完成；Change 保持 active，不归档、不 commit/push。

## 11. 独立实现复审与 fork 局部修正（2026-11-04）

只读独立实现复审提出两项 Medium 实现缺陷，均使用真实临时 Transcript 落盘／重载测试复现，不是既有 fitness 基线失败：

1. fork 复制直属 Child lifecycle 后 callerSessionId 仍指向原 Session，无完成 task-result handle 时客户端无法挂载内容。接受并按 owner 确认的局部范围修正。
2. Child 输入被复制至祖先后，来源 branch 回退并重试，祖先仍显示旧输入副本。复现成立；当时提出失效传播方案，但随后 owner 明确“处理出了问题，不能否定输入”。因此撤回“保留输入本身是缺陷／须传播分支失效”的判断；实际待修正的是同一输入因内部 retry 重复复制。后续处置见第 12 节，不引入撤回或失效事实。

fork 生产修正仅在现有复制循环内：对已选中的 presentation.subagent_start/end，且 callerSessionId 等于被 fork Session 时，以新对象重绑定为新 Session ID。无额外扫描、无递归字符串替换、不新增字段／公共 helper／客户端补偿；其他复制记录、来源身份、孙级关系及源内存／磁盘记录不变。

回归覆盖默认与显式切点 fork、running／terminal lifecycle、start/end 一致性、其他字段逐项保持、孙级关系和原 Session 不变。客户端跨层案例从重载的 fork History 恢复 interrupted Child，已清理 Child 文件且没有 task-result handle，核对实际父卡归属及 Child 内容可达。

```text
npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.unit.config.ts
  src\core\session\SessionManager.presentation.test.ts
  extensions\websocket-channel\client\src\client\history-observation.test.ts
passed: 22 tests, 2 files

npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.unit.config.ts
  src\core\session extensions\websocket-channel\client\src\client
passed: 201 tests, 13 files

npm exec --yes --package=node@22 -- npm run lint
passed
```

该轮未重跑完整仓库测试、未新增浏览器或真实 Provider E2E。第二项的旧失败复现只保留为调查证据，不能按已撤回的“必须撤销输入”语义定义正确行为；后续加入保留输入且 retry 只复制一次的回归，见第 12 节。独立实现复审已执行，不代表整体完成；fitness 处置及 owner 最终验收仍待收口。未改附件配置、fitness 或依赖，未 commit/push。

## 12. 统一执行输入身份与 retry 单份祖先展示（2026-11-04）

owner 明确：处理失败不能否定实际输入。Parent 保留输入是正确展示语义，不要求随 Child 模型分支回退撤销，因此不新增 chat 撤回、持久分支失效记录或同步框架。要修正的仅是同次输入因 compact/retry 多次落盘而产生重复祖先副本。owner 同时要求主 Agent、Child，以及未来的 Automation 等类型使用一致输入身份；未来类型仍在设计阶段，本次不实现其运行功能。

最小生产调整：

- 公共 `AgentRunner.run()` 保留传入 originMessageId；若未传入，生成一次输入身份，再发 run_start，并在所有 attempt 中复用。该值落盘为 user 消息的 messageId，不进入 Provider payload，不修改调用方参数。Child／直接执行复用此入口，不在每种 Agent 中另设 ID 逻辑。
- Runner 仍按原行为在每次通过 preflight 的 attempt 写入新的来源 entry，尾部清理只调整来源活动分支；不改 entry ID 或压缩语义，不重发 user_message。
- 复制端在目标原有写锁内，除原 sourceEntryId 幂等外，仅对 user 输入副本匹配相同 sourceSessionId＋turnId＋messageId。body／锚点一致则保留首份及其来源 entry；内容冲突沿原持久化错误路径显式抛出。其他角色、来源、Turn、不同输入 ID 或无 ID 旧消息不合并。
- 不执行历史重复副本迁移，不按文本判断，也不将 messageId 设为整个 Transcript 唯一键。

新增 7 例精确回归：

- supplied Root ID、缺省 Child ID、缺省直接执行 ID 三种真实 Runner 执行，第一次受控 Provider 调用抛 ContextOverflowError，实际进入 compact／summary／retry。核对一次 run_start、来源两条不同 entry 但相同 messageId、来源有效 History 一条；Child 祖先只一份并指向第一次来源 entry。Provider 消息没有身份字段。
- 独立两次 run 即使输入文本相同也生成不同输入身份，且不修改调用方参数。
- 并发 retry 副本在每层祖先只留一份；相同 ID 的不同来源／Turn／角色、不同 ID 的相同文本，以及无身份旧消息保持独立；Child 删除后重载结果一致。
- 相同输入身份但内容冲突必须显式失败，不静默吞掉或覆盖。
- 来源尾部清理后仍保留已提交输入，随后 retry 不追加第二份，Child 文件删除后仍可独立恢复。

```text
npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.unit.config.ts
  src\core\session src\core\runner src\core\subagent
  src\runtime\RuntimeApp.test.ts src\runtime\RuntimeApp.intake.test.ts
  src\runtime\subagent-orchestration.test.ts extensions\websocket-channel
passed: 626 tests, 38 files

npm exec --yes --package=node@22 -- npm run lint
passed

npm exec --yes --package=node@22 -- npm run build
passed: 62 client assets, Host audit (366 files), Relay tests (121 passed, 7 files)

npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.unit.config.ts
  src\core\runner\AgentRunner.test.ts src\core\session\SessionManager.presentation.test.ts
passed: 90 tests, 2 files
```

626 例运行后类型检查发现新测试的复合 filter 未推断为 MessageRecord，已改为明确先按记录类型筛选；之后 lint/build 及上述最终 90 例通过。没有重跑完整仓库测试或清理实际 Agent Home sessions。这里的 Provider 是受控 invocation port，用实际 Runner 与 Session 持久化执行恢复，不声称线上 Provider E2E。未改附件配置、fitness 或依赖清单，未 commit/push。

独立复审的 fork 归属已修正；“输入随模型分支失效须撤回”的建议经 owner 语义澄清后撤回，retry 单份展示已按统一输入身份实现并验证。未新增已确认的功能阻塞项；既有四项 fitness 的验收处置及 owner 最终确认仍未完成，Change 不归档。

## 15. 单 Tool 展示简化与实机验收反馈（2026-11-04）

owner 实机反馈单个 Tool 外再套 LLM call 分组占用空间，确认单 Tool 直接显示、同块出现第二个 Tool 后再显示 Group。只调整 `MessageItem` 的分组外观、标题和折叠可见性，不改调用归属、数据记录或多 Tool 折叠状态。

新增实际 Vue SFC 编译与服务端渲染回归，验证：

- 实时第一个 Tool 立即显示，无 Group 外框／标题；第二个 Tool 到达后显示 Group，两张卡片及原组身份保留；折叠仍生效。
- History 单 Tool 即使保留了组折叠状态，也不隐藏卡片和待审批按钮；不修改底层折叠选择。
- History 多 Tool 保留分组；递归 Child 使用相同规则，单 Tool Parent 不妨碍多 Tool Child 分组。

```text
npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.unit.config.ts
  extensions\websocket-channel\client\src\components\MessageItem.test.ts
  extensions\websocket-channel\client\src\client\tool-grouping.test.ts
  extensions\websocket-channel\client\src\client-migration.test.ts
passed: 24 tests, 3 files

npm exec --yes --package=node@22 -- npm run lint
passed

npm exec --yes --package=node@22 -- npm run prepare:websocket-client
passed: client build and 62-asset verification
```

没有执行新的浏览器／线上 Provider 验证，没有改审批入口；固定审批面板仍在讨论中，尚未实现。

owner 另反馈用户气泡显示 `<turn_start>…</turn_start>`。已追踪：`UserPromptBuilder` 在原始输入前附加模型用时间标记，Runtime 将增强后的内容交给 Runner，Runner 将其作为 user content 持久化；History 直接投影该文本。实时副本可暂时保留原始文字，但纯 History 恢复会暴露增强内容。此展示缺陷尚未修复，不能把本节单 Tool 修正当作该问题已解决，也不能标记最终验收完成。

## 17. Composer 上方单入口审批卡组（2026-11-05）

owner 确认并发多 Subagent／Tool 时不应到处寻找审批，要求移除 slot 内决策按钮，在输入框上方固定位置显示一张审批卡，多项用左右按钮切换。

- 新增小型 `ApprovalPanel`，通过 Composer 的 slot 放在输入框上方，不改变既有聊天 grid 的行数，也不创建遮罩或弹窗。展示位置／总数、来源、工具和完整参数；长参数限高内滚动。
- App 从现有 canonical pending map 按当前 audience Session 取请求。来源能由既有 scope 关联时显示 Child 类型和身份，尚无 scope 时只显示已知 Turn，不伪造 Child 信息。
- 仅 deck 保留 Allow／Deny；原 Tool 及不可挂载时的提示保留状态展示，不再有决策按钮。提交使用原始 approvalId，检查连接、pending 存在和当前 Session，不改服务端接口／授权。
- 新增请求保持当前 ID，当前请求收到 canonical closure 后推进；全部清空自动隐藏。切换 Session 重置选择；断线禁用按钮。移除 approval_requested 强制滚动聊天的行为，不抢输入焦点。
- 未引入批量批准、审批偏好或额外状态存储；没有先行增加新导航功能。现有 pending 查询承担恢复。

聚焦验证：

```text
npm exec --yes --package=node@22 -- node node_modules\vitest\vitest.mjs run --config vitest.unit.config.ts
  extensions\websocket-channel\client\src\components\MessageItem.test.ts
  extensions\websocket-channel\client\src\client\execution.test.ts
  extensions\websocket-channel\client\src\client\client-core.test.ts
  extensions\websocket-channel\client\src\client-migration.test.ts
passed: 45 tests, 4 files

npm exec --yes --package=node@22 -- npm run lint
passed

npm exec --yes --package=node@22 -- npm run prepare:websocket-client
passed: client build and 62-asset verification
```

只在已有组件渲染测试文件补一项 deck 测试，并修正旧 slot 操作断言，不铺开重复测试。真实 SFC 渲染覆盖无 slot 仍可审批、仅一张可见、多项计数、空态隐藏和断线禁用。首轮旧测试 fixture 只附 approval 却未设置工具审批状态，补齐实际状态后断言通过。

临时 loopback Vite 页面挂载实际 ApprovalPanel／ComposerPanel 与仓库 CSS，未连接实际 Agent 服务或发送真实批准。浏览器验证左右切换、追加不抢当前选择／输入焦点、按原 ID 发出 allow／deny、删除当前项自动推进、Session 切换、断线禁用、清空隐藏。390×844 下 Classic／Botanical 均无横向溢出，参数区限高 180px 且内部可滚动，输入框仍在屏内；聊天 scrollTop=800 时追加请求保持 800，审批面板位置不变。

临时页面已回 about:blank，预览进程停止、脚本清理。该证据是受控组件浏览器验证，不声称线上 Provider 审批 E2E；当时生产客户端已重新构建，等待 owner 实机体验。未清理 sessions、未 commit/push／归档。

## 18. Owner 人工审核通过（2026-11-06）

owner 确认本 Change 已经过多轮人工测试和修正，暂未发现还需修改的事项，可以视为人工审核通过。本记录补齐整体功能的人工验收结论，不将既有受控组件验证扩写为线上 Provider E2E，也不追加实现范围。

owner 授权按功能提交本次对话相关改动及其必要基础，不推送。无关架构治理／fitness 调整及独立的原始 message／模型 User prompt 分离改动不纳入本批提交。
