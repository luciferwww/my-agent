# 新 Session 模型设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> Input: [Agent Session 管理对比调研](agent-session-management-comparison.md)

## 1. 问题与结论

当前系统把调用方提供的 `sessionKey` 同时用于：

- `sessions.json` 的索引和 `SessionManager` CRUD；
- Runtime 的串行 gate、消息队列、steering inbox、active turn 和 Abort；
- Channel request/event 协议与 WebSocket audience；

新设计只定义一个干净的新格式：

- `sessionId` 是系统生成、不可变的唯一身份；
- `title` 是可选、可变、可重复的展示元数据；
- Transcript 路径固定由 `sessionId` 推导，不在 Session 元数据中重复保存；
- `createSession` 只在内存中预留 `sessionId`，零消息 Session 不持久化、不进入列表；
- 首次 `sendMessage` 将预留 ID 和 Session 元数据转为正式 Session，并从消息内容本地生成初始标题；消息仍由 Runner 的常规路径持久化；
- 本草稿只定义 Session 本身的身份、元数据、持久化和管理语义；
- create、send、stop、archive、delete 和 fork 具有独立语义。

实施前置条件：启用新实现时 `<agentHome>/sessions/` 为空。

## 2. 目标与非目标

### 2.1 目标

1. 用户和客户端通过稳定 `sessionId` 精确寻址 Session。
2. Session 可拥有可变、可重复的 `title`，标题不参与唯一性和路由。
3. 提供一致的 create/list/get/rename/archive/delete/fork 语义。
4. 保持“同一 Session Turn 串行、不同 Session 可并发”的运行约束。
5. 运行状态与持久化元数据分离。
6. Session identity 不编码可变展示属性或其他上下文语义。
7. Session-scoped 的内部和外部接口只使用一种 canonical Session identity。
8. 服务端签发但尚未首发的 Session ID 只存在于内存登记表，不形成空 Transcript 或列表项。

### 2.2 非目标

- 本草稿不决定最终 CLI/TUI 视觉形态。
- 不重构 Transcript 消息树、Compaction 或 Provider history。
- 不引入云同步、跨设备 Session 或多进程写锁。
- 不承诺标题全局唯一，也不把标题设计成 URL slug。
- 不在本轮修改生产代码、测试或当前架构文档。
- 不重新设计 Session 消费方的内部模型；只规定其与 Session identity 交互时必须遵守的边界。

## 3. 领域模型

### 3.1 Session

```ts
interface SessionEntry {
  sessionId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  parentSessionId?: string;
}
```

约束：

- `sessionId`：系统生成、不可变、唯一，是 API、事件、队列和 Transcript 的主身份。
- `title`：可选、可变、可重复；首次 materialize 时从首条用户消息本地生成，无法提取文本时保持未设置，由客户端显示 ID 前缀或本地化占位名称。
- `createdAt`：创建后不可变。
- `updatedAt`：Session 元数据或 Transcript 成功变更后刷新。
- `archivedAt`：若接受 archive 语义，用于从默认列表隐藏但保留 Transcript。
- `parentSessionId`：只表示可恢复的 Session fork。

更新接口必须使用显式可变字段类型，不能接受 `Partial<SessionEntry>`：

```ts
interface UpdateSessionInput {
  title?: string | null;
}
```

`sessionId`、`createdAt` 和 Transcript 定位均不能通过元数据更新接口修改。现有 token、Compaction 和最近运行结果等统计字段如需保留，应作为独立设计加入，不能重新承担身份职责。

#### 3.1.1 初始标题生成

初始标题属于展示元数据，不能成为 Session 首次持久化的外部依赖。`materializeSession` 使用纯本地、确定性的 `deriveInitialSessionTitle(firstMessage)`：

1. 只读取首条用户消息中第一个非空的用户文本内容，不使用附件内容、系统注入文本或工具结果。
2. 去除首尾空白，将连续空白归一为单个空格。
3. 按 Unicode grapheme cluster 截断到最多 48 个字符，超出时使用省略号且省略号计入上限；不能切断组合字符或 emoji。
4. 消息没有可用文本时返回 `undefined`，不把通用占位文字持久化为标题。
5. 标题生成不得调用 LLM，不得因标题处理失败阻止 Session 固化。

未来如增加 LLM 自动命名，应作为首个 Turn 之后的异步增强单独设计：失败时保留本地标题，且只能在标题仍为自动生成值时 compare-and-set，不能覆盖用户 rename。该能力不属于当前 materialize 契约。

### 3.2 Store 与 Transcript

```ts
interface SessionStore {
  version: 1;
  sessions: Record<string, SessionEntry>;
}
```

```text
<agentHome>/sessions/
├── sessions.json
├── <sessionId>.jsonl
└── ...
```

规则：

1. `sessions` 的对象 key 必须等于 `SessionEntry.sessionId`。
2. Transcript 路径始终为 `<sessionsDir>/<sessionId>.jsonl`，不保存 `sessionFile`。
3. Store 的 `version: 1` 表示该 Schema 的首个版本。
4. Store 中出现 key/entry ID 不一致、非法 ID 或重复关系时直接报数据错误。
5. 删除操作以 `sessionId` 同时定位元数据和 Transcript。

### 3.3 Pending Session ID 登记

```ts
interface PendingSessionRegistration {
  sessionId: string;
  createdAt: number;
}
```

`PendingSessionRegistry` 是应用层的进程内 ID 预留表，不是第二套 Session Store：

1. `createSession()` 生成服务端 ID，只写入登记表并返回 `{ sessionId }`；不创建 `SessionEntry`、Transcript 或 Store 条目。
2. 登记记录只包含 `sessionId` 和 `createdAt`，不保存标题、消息、运行状态或其他 Session 元数据。
3. 首次 `sendMessage` 必须先按 `sessionId` 进入串行 gate，再依次查询持久化 Store 和登记表。
4. Store 未命中但登记表命中时，应用层通过单个 materialize 操作生成初始标题，并持久化 `SessionEntry` 与 Transcript 根记录；全部成功后才删除登记记录。消息内容只用于标题派生，仍由 Runner 在 preflight 后通过常规路径持久化。
5. Store 和登记表均未命中时返回 `SESSION_NOT_FOUND`，不得根据调用方提供的未知 ID 隐式创建。
6. `list/get/resume/fork` 只操作持久化 Session，不暴露 pending ID；从未收到 send 的预留 ID 因此永远不进入 Session 列表。
7. pending ID 随进程退出失效，并通过 TTL 与容量上限清理废弃登记；具体默认值在实现规格中确定。
8. Session 转正后，`SessionEntry.createdAt` 沿用登记记录的 `createdAt`，`updatedAt` 使用 materialize 成功提交的时间。

该方案以单进程 Runtime 为边界。未来若支持多进程或多实例，必须使用 sticky routing 或共享预留存储，不能假设一个进程内 `Map` 对所有请求可见。

### 3.4 运行状态

```ts
type SessionRuntimeStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_permission'
  | 'stopped';
```

状态由 Runtime 根据活跃 Turn、队列和等待点计算，默认不写入永久 Session Store。`failed`、`abortedLastRun` 等“上次结果”可以作为持久化摘要另行设计，但不得与“当前是否运行”混用。

## 4. API 语义

### 4.1 管理能力

| 操作 | 建议语义 |
|---|---|
| `createSession()` | 生成并登记 pending ID，返回 `{ sessionId }`；不持久化、不进入列表 |
| `listSessions({ scope?, archived? })` | 默认返回当前作用域内未归档 Session，按 `updatedAt` 倒序 |
| `getSession(sessionId)` | 按稳定 ID 精确获取 |
| `renameSession(sessionId, title?)` | 只更新标题；允许清空为未命名 |
| `archiveSession(sessionId)` | 停止接受新 Turn，并从默认列表隐藏；保留 Transcript |
| `unarchiveSession(sessionId)` | 恢复到默认列表 |
| `deleteSession(sessionId)` | 永久删除元数据和 Transcript；必须定义 descendant 策略 |
| `forkSession(sessionId, entryId?)` | 复制所选历史路径，生成新 Session ID |

如果首期不接受 archive，可先交付 create/list/get/rename/delete，并把“stop 不删除”写入协议；但不应使用 delete 模拟整理列表。

### 4.2 Turn 与事件协议

新请求和事件统一携带：

```ts
interface SessionRef {
  sessionId: string;
}
```

- 已存在 Session 的消息必须提供 `sessionId`。
- 创建 Session 通过独立 `createSession()` 预留 ID，不通过“发送未知 ID 时自动创建”。
- `sendMessage({ sessionId, message, requestId })` 对 pending ID 先执行首次 materialize，再进入与持久化 Session 相同的 Turn 路径；Runner 在 preflight 后追加消息。
- 未知或已过期的 `sessionId` 返回 `SESSION_NOT_FOUND`。
- Runtime 的 queue、Abort、steering 和 active-turn map 全部以 `sessionId` 为键。
- WebSocket audience 订阅 `sessionId`。
- Session 管理请求、Session-scoped Turn 请求/响应和事件不再出现 `sessionKey`。

“未知身份自动创建”应被移除，因为它会把拼写错误或未授权客户端输入静默变成新资源。

## 5. 组件职责

| 组件 | 目标职责 |
|---|---|
| `SessionManager` | 正式 Session 持久化、ID CRUD、首次 materialize、标题更新/归档/fork |
| 应用层 Session capability | 管理 `PendingSessionRegistry`，组合 ID 预留与首次 materialize，不让 Channel 直接访问登记表 |
| Runtime | 以 `sessionId` 编排 Turn、队列、Abort 和 live status；首次 send 在串行 gate 内完成 materialize；Runner 是用户消息的唯一写入者 |
| Channel/Host | 暴露管理交互、选择当前 Session、传递 canonical ID |
| WebSocket 协议 | 定义 Session CRUD、Session events 和 ID 路由 |

Session 管理能力应由 Session 层拥有，由 Runtime capability 或独立 application service 暴露。不要把持久化 CRUD 直接塞进具体 CLI/WebSocket Channel，也不要让 Channel 读取 `sessions.json`。

## 6. 实施阶段

### 阶段 0：接受契约

- 决定 Session 作用域、archive 是否进入 MVP 和 delete descendant 语义。
- 接受新 Store 和公共协议。
- 确认运行环境满足空 Session 目录的实施前置条件。

退出条件：设计成为 Accepted Change 或 Specification；本 Research Draft 本身不满足该条件。

### 阶段 1：替换持久化模型

- 将 `SessionManager` 改为只按 ID create/get/list/update/delete。
- 将正式创建收敛为 `materializeSession(sessionId, createdAt, title?)`；消息内容不进入该持久化接口。
- 在 Session 层实现确定性的 `deriveInitialSessionTitle(firstMessage)`；首次落盘不调用 LLM。
- 使用 `SessionEntry` 和 `SessionStore` 新格式。
- 更新接口只允许修改显式可变元数据。
- Transcript 路径只由 `sessionId` 推导。
- 从 Session Store/API 删除 `sessionKey`、`sessionFile` 和未知 key 自动创建语义。

退出条件：重复标题可正常工作；身份与路径字段不可更新；无旧 Store 读取分支。

### 阶段 2：Runtime canonicalization

- Runtime 的 queue、Abort、steering、in-flight 和 active-turn map 改用 `sessionId`。
- 应用层增加进程内 `PendingSessionRegistry`；`createSession()` 只预留服务端生成的 ID。
- `sendMessage` 只接受已持久化或已登记的 `sessionId`；首次 materialize 在 per-session gate 内完成。
- 持久化成功后删除 pending 登记；失败时保留登记供重试或等待过期清理。

退出条件：同 Session 仍严格串行，不同 Session 仍可并发；Abort 不会命中错误 Session。

### 阶段 3：Channel 与协议

- 增加 Session management capability 和 WebSocket CRUD/events。
- CLI 从固定 `main` 转为“创建或选择当前 Session”。
- 所有请求、响应和事件只使用 `sessionId`。

退出条件：CLI 与 WebSocket 都能创建、列表、重命名、恢复和删除；Session 管理与 Session-scoped Turn 协议中不存在 `sessionKey`。

## 7. 风险与防护

| 风险 | 防护 |
|---|---|
| 把字段重命名误当成设计完成 | 以 Session Store、Runtime map 和 Session-scoped Channel 协议全部使用 `sessionId` 为完成标准 |
| 未首发的 ID 形成空 Session | create 只登记内存 ID，首次 send 到达并通过 admission 后才进入 Store/list |
| 首次并发发送重复 materialize | 在查询 Store/登记表之前进入现有 per-session 串行 gate |
| pending 登记无限增长 | 使用 TTL、容量上限和惰性或周期性清理；登记只保存 ID 与创建时间 |
| 首次 materialize 部分成功 | Transcript 根与 Store 提交组成 materialize；失败不得删除登记或暴露列表项，并清理或恢复部分产物 |
| 标题生成拖慢或阻断首次发送 | 首次标题只做本地确定性提取；无文本或处理失败时允许 `title` 未设置 |
| 异步标题覆盖用户 rename | 若未来引入 LLM 标题，必须 compare-and-set 且仅更新仍为自动值的标题 |
| 同一 Session 多写导致 Transcript 交错 | 继续保持单 Runtime 内 per-session gate；跨进程写入明确不支持 |
| archive 与运行状态混淆 | `archivedAt` 属于持久生命周期，`running/idle` 属于 Runtime 状态 |
| 一次性修改范围过大 | 持久化、Runtime 和 Channel 分阶段，每阶段只改变一种 Session 职责 |

## 8. 方案比较

### 方案 A：保留 `sessionKey` 为公共主键

改动最小，但标题不能安全重命名，调用方仍需管理唯一性，不应继续把调用方字符串作为 Session 公共主键。

### 方案 B：系统生成 UUID，标题独立

模型最简单，与四个调研产品的共同模式一致。需要跨 Runtime 和协议改造，但从第一天起只有一个 canonical identity。

**推荐方案 B。**

### 方案 C：可读 slug 作为主键

看似兼顾可读性，但必须处理重命名、冲突、转义和历史引用，最终通常还会再引入内部 ID。复杂度高于方案 B，不推荐。

## 9. 实施前待决问题

以下问题会改变公共契约或数据所有权，必须在接受设计时明确：

1. **Session 作用域：** 当前 agentHome 全局、工作目录、Git repository，还是由 Channel/tenant 显式指定？推荐将 scope 作为独立筛选字段，不编码进 ID。
2. **Archive 的 MVP 范围：** 首期实现 archive/unarchive，还是只定义 stop 与 delete 的区别后延后 archive？推荐定义字段和语义，但可延后 UI。
3. **删除后代：** forked Session 使用 restrict、cascade 还是保留 orphan？推荐默认 restrict 或显式 cascade。
4. **管理能力入口：** 放在现有 Runtime capabilities 还是独立 application service？推荐先在应用层定义窄接口，Runtime 只组合，不让具体 Host 拥有 Store 逻辑。
5. **Pending 清理参数：** TTL、容量上限和容量耗尽时的错误码由实现规格确定；这些参数不改变 pending ID 不持久化的领域语义。

## 10. 最小验收集合

- 新 Store 只接受 `SessionStore.version === 1` 和 ID-keyed entries。
- Transcript 路径严格由 `sessionId` 推导，Store 不保存 `sessionFile`。
- 两个同名 Session 可创建、列表并按 ID 精确操作。
- rename 不影响历史、队列、Abort 或订阅。
- 身份与路径字段不能通过更新接口修改。
- `createSession()` 只返回已登记 ID，不创建 Store 条目、Transcript 或列表项。
- 首次 send admission 成功后 Session 元数据与 Transcript 根可恢复，并从 pending 登记删除。
- 首次 materialize 从用户文本确定性生成最多 48 个 grapheme 的标题，不调用 LLM。
- 无文本首条消息仍可 materialize，`title` 保持未设置。
- 首次 materialize 失败时不产生可列出的 Session，pending ID 仍可重试直到过期。
- Runner 在 preflight 后持久化首条用户消息；preflight 前失败允许保留一个由实际 send 固化但尚无消息的 Session。
- 未知或已过期 ID 发消息返回 `SESSION_NOT_FOUND`，不创建新 Session。
- 同一 pending ID 的并发首发最多 materialize 一次。
- TTL 或容量清理后的 pending ID 不再可用于首发。
- 同 Session Turn 串行、跨 Session 并发行为不变。
- Session 管理、Session-scoped Turn 请求/响应和对应内部 map 不再使用 `sessionKey`。
- fork 产生新 ID，原 Transcript 和原 active leaf 不变。
- stop/archive/delete 的数据保留行为分别有契约测试。
