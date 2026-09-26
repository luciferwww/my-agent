# Session 历史渐进加载设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> Input: [Agent Session 管理对比调研](agent-session-management-comparison.md)

## 1. 问题与结论

当前 WebSocket 客户端可以列出和选择持久化 Session，但选择操作只切换页面内的 Session 状态，不读取对应 Transcript。客户端因此只能显示当前页面生命周期内接收的消息，刷新页面或选择历史 Session 后无法恢复既有对话。

Session Transcript 可以长期增长。选择 Session 时一次返回完整历史会使切换延迟、响应体积、浏览器解析成本、DOM 数量和内存占用随 Session 生命周期持续增加。单条图片或 Tool Result 也可能使仅按消息数量限制的响应显著膨胀。

本草稿采用以下设计：

1. Session 历史是独立的只读 Runtime 能力，由 Core Session 读取当前 active branch。
2. 历史通过反向游标分页，第一页读取最新消息，后续页向更早消息移动。
3. 服务端同时限制条目数和估算后的传输字节数。
4. Channel 接收稳定的展示 DTO，不读取 JSONL，不暴露内部 Transcript 状态。
5. 浏览器按 Session 缓存已加载页面，只为当前可见 Session 创建消息 DOM，并限制缓存规模。
6. UI 展示历史与 Runner 的模型上下文加载保持独立；Compaction 不删除用户可浏览的持久化历史。

## 2. 当前实现事实

- `SessionManager.getMessages(sessionId)` 已按 `parentId` 解析当前 active branch，并返回按时间正序排列的 `MessageRecord[]`。
- Runtime Application 和 `ChannelRuntimeCapabilities.sessions` 只暴露 Session 元数据与生命周期操作，没有 Transcript 查询能力。
- WebSocket 协议支持 Session create/list/get/rename/archive/unarchive/delete/fork，没有历史请求。
- 浏览器客户端为每个 Session 保存独立的页面内 `chatItems`，选择 Session 时只切换本地状态。
- Transcript 持久化 `user`、`assistant` 和内部 `toolResult` 消息；内容可能包含 base64 图片、Tool Use 和 Tool Result block。
- Runner 根据 Compaction 记录构造模型调用历史。该视图服务于模型 token 预算，与用户浏览完整对话的需求不同。

## 3. 领域边界

### 3.1 Core Session

Core Session 负责：

- 验证 Session 存在且 Transcript 可读取；
- 解析当前 active branch；
- 根据 `beforeEntryId` 定位窗口；
- 应用条目数和传输预算；
- 将持久化记录投影为稳定的历史 DTO；
- 返回继续向前读取所需的游标。

### 3.2 Runtime 与 Extension API

Runtime 将 Core 查询暴露为 Channel-neutral Session capability。Extension API 只导出查询参数和结果 DTO，不导出 `TranscriptState`、JSONL 路径或 SessionManager。

### 3.3 WebSocket Channel

WebSocket Channel 负责：

- 解析和验证历史请求；
- 调用 Runtime capability；
- 将结果发送给发起请求的 client；
- 使用已有 `ChannelOperationError` 映射 Session 错误。

### 3.4 浏览器客户端

浏览器客户端负责请求编排、加载状态、页面合并、滚动位置保持和缓存淘汰。它不解析 Transcript 树，也不重放历史记录为实时 Agent Event。

## 4. 查询契约

建议在 Core/Channel 公共边界定义：

```ts
interface SessionHistoryQuery {
  readonly sessionId: string;
  readonly beforeEntryId?: string;
  readonly limit?: number;
}

interface SessionHistoryPage {
  readonly sessionId: string;
  readonly items: readonly SessionHistoryItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}
```

`beforeEntryId` 是可选的排他游标：

- 省略时，从当前 active branch 的末尾返回最新一页；
- 提供时，返回该 Entry 之前的消息，不包含游标指向的 Entry；
- 返回项始终按从旧到新的展示顺序排列；
- `nextCursor` 为当前页第一项的 `entryId`；
- `hasMore=false` 时 `nextCursor=null`；
- 游标必须属于该 Session 当前 active branch，否则返回明确的 Session 查询错误。

例如 active branch 为 `A B C D E F`，`beforeEntryId=E, limit=3` 返回 `B C D`。

建议默认值与硬上限：

```text
default limit       = 50
maximum limit       = 100
maximum page bytes  = 1 MiB
tool result preview = 20 KiB per block
```

服务端先选择游标之前最多 `limit` 条，再从较新的条目向较旧条目应用字节预算，使第一页优先保留最接近当前对话位置的内容。至少返回一个经过安全投影且可放入响应预算的条目，避免超大单条消息造成无进展分页。

## 5. 展示 DTO

持久化 `MessageRecord` 不直接成为公共协议。建议使用按角色区分的 DTO：

```ts
interface SessionHistoryItemBase {
  readonly entryId: string;
  readonly timestamp: string;
}

type SessionHistoryItem =
  | (SessionHistoryItemBase & {
      readonly role: 'user' | 'assistant';
      readonly blocks: readonly SessionHistoryBlock[];
      readonly abortMeta?: {
        readonly partial: boolean;
        readonly stopReason: 'aborted';
      };
    })
  | (SessionHistoryItemBase & {
      readonly role: 'toolResult';
      readonly blocks: readonly SessionHistoryToolResultBlock[];
    });
```

展示 block 规则：

- text：保留文本，并计入页面字节预算；
- image：返回 MIME、宽高和 `omitted: true`，不返回 base64 数据；
- tool use：返回调用 ID、名称和有界输入预览；
- tool result：返回 Tool Use ID、有界内容预览及 `truncated`；
- `abortMeta`：保留，以便客户端标识部分响应；
- Compaction record：不作为普通聊天项返回。

DTO 必须允许客户端稳定区分用户消息、Assistant 文本、Tool 调用与 Tool 结果。字段命名使用当前 TypeScript 和 WebSocket 协议采用的 camelCase。

## 6. WebSocket 协议

请求：

```json
{
  "type": "get_session_history",
  "requestId": "history-7",
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "beforeEntryId": "optional-entry-id",
  "limit": 50
}
```

`beforeEntryId` 和 `limit` 均可省略。响应：

```json
{
  "type": "session_history",
  "requestId": "history-7",
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "items": [],
  "nextCursor": null,
  "hasMore": false
}
```

响应只发送给发起请求的 socket。查询本身不加入 Session audience；选择 Session 时已有 permission 查询或后续 Turn 可建立 audience。客户端同时校验 `requestId` 和 `sessionId`，忽略切换后迟到的响应。

## 7. 浏览器交互

### 7.1 选择 Session

1. 用户选择 Session。
2. 客户端立即切换标题和输入区，显示历史加载状态。
3. 若该 Session 已有完整的最新页缓存，直接显示缓存并异步刷新 Session 元数据和权限模式。
4. 否则发送不带 `beforeEntryId` 的请求，加载最新 50 条。
5. 响应到达后替换该 Session 的历史视图，并滚动到底部。

页面内实时消息与历史页按 `entryId` 去重。当前实时事件还没有持久化 Entry ID 时，客户端在收到新的历史页后以服务端历史为基线重新协调，避免同一条消息重复显示。

### 7.2 加载更早消息

当 `hasMore=true` 时，在列表顶部显示“加载更早消息”。请求使用上一页的 `nextCursor`。新页面插入顶部后，客户端恢复原锚点元素相对视口的位置，避免滚动跳动。

同一 Session 同时只允许一个历史请求。重复点击不创建并发页请求。

### 7.3 缓存与渲染

- 缓存最近访问的 3 个 Session；超出后按 LRU 淘汰非当前 Session 的历史与 `turnMap`；
- draft、附件和 permission 状态可继续按现有 Session UI state 保存；
- 长列表使用虚拟滚动或窗口化渲染，DOM 节点数量不随已加载历史无限增长；
- 断线重连后重新请求当前 Session 最新页，实时事件流不承担历史补发职责。

## 8. 一致性与并发

分页基于每次查询时的 active branch 快照。Transcript 是 append-only，正常追加不会改变较早 Entry 的 ID，因此 `beforeEntryId` 对向前分页保持稳定。

`SessionManager.branch()` 可改变进程内 active leaf。若游标不再属于当前 active branch，服务端返回游标无效；客户端清除该 Session 历史缓存并重新加载最新页。

页面加载期间出现新消息时：

- 新实时事件继续追加到对应 Session 的页面内状态；
- 最新页响应只替换其请求开始前的历史基线，并按稳定标识去重；
- `requestId + sessionId` 防止跨 Session 污染；
- 删除 Session 后，客户端丢弃该 Session 的所有未完成响应。

## 9. 错误语义

建议新增可映射到 `ChannelOperationErrorCode` 的错误：

```text
SESSION_HISTORY_CURSOR_INVALID
SESSION_HISTORY_LIMIT_INVALID
```

既有错误继续覆盖 Session 不存在、归档策略或 Transcript 数据损坏。错误响应不得包含 Transcript 路径、原始消息内容、凭据或底层异常对象。

客户端查询失败时保留 Session 选择和输入能力，历史区域显示可重试错误。失败不清除已成功加载的缓存页。

## 10. 与 Compaction 的关系

历史展示读取持久化 active branch，允许用户查看 Compaction 之前的原始消息。Runner 继续使用现有 Compaction summary 和 retained-history boundary 构造模型上下文。

后续可以提供“从摘要继续”的显式产品能力。该能力应创建新的上下文边界或 Session 分支，并与本草稿的只读历史查询分开设计。

Approval request、pending 状态、用户决定和关闭原因属于实时 interaction lifecycle，不进入 Session Transcript。历史加载只根据持久化 Tool Use 和 Tool Result 重建 Tool Call Card，不重建或推断 Approval Card。详细呈现规则见 [Tool Activity 展示设计草稿](tool-activity-presentation-design-draft.md)。

## 11. 验收场景

1. 不传 `beforeEntryId` 时返回 active branch 最新最多 50 条，顺序从旧到新。
2. 传入有效游标时排除游标项，并返回其前最多 `limit` 条。
3. 第一页少于默认条数时返回 `hasMore=false` 和 `nextCursor=null`。
4. 分支废弃记录不进入结果，active branch 记录顺序正确。
5. 未知 Session、非法 limit、未知或非 active-branch 游标返回稳定错误。
6. 图片 base64 不进入响应，Tool Result 和 Tool Use 输入按规定截断。
7. 条目数未达到上限但字节预算已满时正确停止，并可通过游标继续。
8. Session 快速切换产生的迟到响应不污染当前视图。
9. 加载更早消息后滚动锚点保持稳定，重复页不产生重复消息。
10. 实时 Turn 与历史加载并发时不丢失、不重复已持久化消息。
11. 删除 Session 后相关缓存和未完成响应被清理。
12. 历史查询不改变 active leaf、Session `updatedAt`、permission mode 或 Runtime 执行状态。

## 12. 建议实施顺序

1. 在 Core Session 增加 DTO 投影和 active-branch 分页查询，并完成边界测试。
2. 将查询能力贯通 Runtime Application、Runtime Builder 和 Extension API。
3. 在 WebSocket Channel 增加请求解析、响应映射和协议测试。
4. 在浏览器客户端实现首次加载、向前分页、迟到响应隔离和错误重试。
5. 增加大 Transcript、超大 Tool Result、图片和快速 Session 切换的集成测试。
6. 实测长 Session 的响应字节、切换延迟和浏览器内存，再校准默认页大小与缓存数量。
