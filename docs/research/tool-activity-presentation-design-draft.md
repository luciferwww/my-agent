# Tool Activity 展示设计草稿

> Status: Non-authoritative design draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> Scope: WebSocket Channel 附带浏览器客户端中的 Tool Call、Tool Result 和 Approval 展示

## 1. 问题与结论

当前浏览器客户端将一个 Turn 的全部 Tool Use 和 Tool Result 绑定到共享的 `toolsExpanded` 状态，同时把 Approval 渲染成始终展开的独立大卡片。共享展开状态使一个操作影响同一 Turn 内所有 Tool，Approval 的完整参数和已完成状态持续占据较高视觉权重，Tool Use 与对应 Result 也被拆成两个相邻但独立的卡片。

本草稿采用以下设计：

1. Tool Call Card 与 Approval Card 是两类独立卡片。
2. 每张卡片拥有独立 `expanded` 状态，默认 `false`。
3. Tool Call Card 始终存在，并原地承载 Tool Use、执行状态和 Tool Result。
4. Approval Card 只在真实收到 `approval_requested` 时存在；`allow_all` 等不产生 Approval request 的路径不创建该卡片。
5. 服务端继续向 Channel 提供完整 Tool input 和 result；Web 客户端只控制摘要、折叠、限高滚动和文本转义。
6. Session 历史只重建持久化的 Tool Call/Result，不重建 Approval Card。

## 2. 当前实现事实

- Runner 当前按 Provider 返回顺序逐个执行 Tool Call，并在每次 `tool_use` 后发送对应 `tool_result`，不并行执行 sibling Tool Call。
- Approval request 具有独立的 interaction `id`，用于授权交互生命周期。
- 浏览器客户端把 Tool Use、Approval 和 Tool Result 保存为 Turn `segments`。
- 一个 Turn 使用共享 `toolsExpanded` 控制全部 Tool Use/Result；Approval 不受该状态控制并始终展示完整参数。
- Tool Result 折叠预览保留头 6 行和尾 4 行；展开后显示完整内容。
- Vue 普通文本插值和 `<pre>{{ value }}</pre>` 会进行 HTML 转义；Tool 参数和 Result 不需要服务端 HTML 编码。
- Approval lifecycle 是 current-call、origin-bound 的进程内交互，不进入 Session Transcript。

## 3. Card 边界

### 3.1 Tool Call Card

每个 Tool Call 对应一张 Tool Call Card。它显示 Tool 名称、收起态参数摘要、当前状态，以及展开态完整 input 和 Tool 完成后的 result 或 error。

状态至少包括：

```text
requested
running
succeeded
failed
denied
aborted
not_executed
```

卡片默认收起，用户展开或收起某张 Tool Call Card 时不影响同一 Turn 内其他卡片。

### 3.2 Approval Card

Approval Card 只表示真实发生的用户授权交互。它显示 Tool 名称、interaction/approval ID 的短标识或调试信息、收起态参数摘要、pending 时的 `Deny` 和 `Allow` 操作，以及 resolved、denied、aborted、unavailable 或 failed 状态。

Approval Card 拥有独立 `expanded`，默认收起。审批按钮在收起态仍可见，用户无需展开即可决策；展开态用于核对完整 input。

Session 处于 `allow_all` 或静态策略直接允许 Tool 时，Runtime 不发送 `approval_requested`，客户端只显示 Tool Call Card。

## 4. Tool Call 关联

第一版不修改 Agent event 或 Approval 协议。浏览器客户端利用当前 Runner 的顺序执行约束：`tool_use` 创建一张 running Tool Call Card，下一条 `tool_result` 更新同一 Turn 中最近一张尚未完成的 Tool Call Card。

该规则只成立于当前 sibling Tool Call 串行执行契约。若未来引入并行 Tool Call，必须先单独设计稳定关联字段，再修改客户端配对方式；本草稿不提前扩展该协议。

## 5. 收起态

### 5.1 Tool Call Card

```text
+----------------------------------------------------------+
| web_fetch  url="https://example.com/..."        [v]   |
+----------------------------------------------------------+
```

执行完成后原地更新：

```text
+----------------------------------------------------------+
| web_fetch  Succeeded                             [v]   |
+----------------------------------------------------------+
```

失败、拒绝和 Abort 使用同一结构：

```text
+----------------------------------------------------------+
| exec  Failed                                      [v]   |
+----------------------------------------------------------+
```

### 5.2 Approval Card

```text
+----------------------------------------------------------+
| Approval required: web_fetch                      [v]   |
|                                           [Deny] [Allow] |
+----------------------------------------------------------+
```

终态卡片收缩为状态记录，不再显示按钮：

```text
+----------------------------------------------------------+
| Approval: web_fetch                           Denied [v] |
+----------------------------------------------------------+
```

## 6. 展开态

### 6.1 Tool Call Card

```text
+----------------------------------------------------------+
| web_fetch  Succeeded                              [^]   |
+----------------------------------------------------------+
| Input                                                    |
| url          "https://example.com/search?q=..."         |
| extractMode  "markdown"                                 |
| maxChars     12000                                      |
+----------------------------------------------------------+
| Result                                                   |
| 1   Page title                                          |
| 2                                                       |
| ... 178 more lines                                      |
| 185 ...                                                 |
+----------------------------------------------------------+
```

Result 保留现有等宽文本和头尾行预览风格。完整 Result 区域设置 `max-height` 并内部滚动，避免卡片无限增高。无 Result 内容时不渲染空 Result 区域。失败时使用 Error 区域展示现有错误文本。

### 6.2 Approval Card

```text
+----------------------------------------------------------+
| Approval required: web_fetch                      [^]   |
+----------------------------------------------------------+
| Input                                                    |
| url          "https://example.com/search?q=..."         |
| extractMode  "markdown"                                 |
| maxChars     12000                                      |
+----------------------------------------------------------+
|                                           [Deny] [Allow] |
+----------------------------------------------------------+
```

展开态使用完整 input，并通过固定最大高度和内部滚动控制布局。审批输入不得因展示优化在服务端被截断，否则用户可能无法核对影响决策的参数尾部。

## 7. Input 展示

服务端和 Runtime 保持完整 input；WebSocket Channel 发送现有结构化 input。浏览器负责展示投影：

- 折叠态只显示 1 至 3 个顶层参数摘要；
- 展开态每个顶层参数一行；
- 字符串中的换行和制表符以可见转义形式显示；
- 对象和数组可序列化为单行 JSON；
- 单行过长时由 CSS 省略或客户端生成带明确省略标记的预览；
- 展开区域必须提供完整 input 的可滚动文本视图，不能只提供截断副本；
- 使用 Vue 文本插值或 `textContent`；不得通过 `v-html` 渲染 Tool input。

HTML 转义属于各 Channel 的呈现职责。CLI、WebSocket、未来 GUI Channel 可以使用不同渲染方式，Core 和 Runtime 不生成 HTML-safe 字符串。

## 8. Result 展示与数据完整性

实时 Tool Result 继续按现有事件路径发送完整 `result.content`。现有 Runner Tool Result pruning 只服务于模型上下文预算，Session 持久化裁剪只服务于 Transcript 存储边界；二者都不应用于实时 Channel 展示。

Web 客户端继续使用当前头 6 行、尾 4 行的默认预览。用户展开 Result 时，内容区域限高并滚动，但数据保持完整。

如果未来完整 Result 造成不可接受的网络或浏览器内存成本，应单独设计：

```text
bounded preview + explicit truncated metadata + resultId + on-demand full-result retrieval
```

在完整结果可按需读取之前，服务端不得静默截断 Web 展示副本。任何不可逆裁剪都必须明确标记，且不能让用户误认为看到的是完整内容。

## 9. 实时与历史

### 9.1 实时 Turn

- `tool_use` 创建 Tool Call Card；
- `approval_requested` 创建独立 Approval Card；
- `approval_closed` 更新并收缩 Approval Card；
- `tool_result` 更新同一 Turn 中最近一张尚未完成的 Tool Call Card；
- 未发生 Approval 的路径不创建 Approval Card。

### 9.2 Session 历史

Session Transcript 保存 Tool Use 和 Tool Result 对话事实，不保存 Approval request、pending 状态、用户按钮决定或关闭原因。历史加载只重建 Tool Call Card。

客户端不得根据 Tool Result 文本猜测是否曾发生 Approval，也不得为 `allow_all` 路径合成 Approval Card。若未来需要持久化审批审计，应作为独立审计记录设计，不扩充模型对话 Transcript。

## 10. 客户端状态

建议每个 segment 独立保存展开状态：

```ts
interface ToolCallSegment {
  readonly type: 'tool_call';
  expanded: boolean;
  // input, status, result...
}

interface ApprovalSegment {
  readonly type: 'approval';
  readonly approvalId: string;
  expanded: boolean;
  // input, status...
}
```

新建卡片的 `expanded` 固定为 `false`。移除 Turn 级 `toolsExpanded`，展开其中一张卡片不改变任何其他卡片。

## 11. 无障碍与交互

- 展开按钮使用熟悉的 chevron 图标，并提供可访问名称；
- 按钮设置 `aria-expanded` 和关联区域 ID；
- Card 状态不只依赖颜色，必须同时显示文字或图标；
- pending Approval 的操作按钮具有清晰焦点顺序；
- resolved Approval 不保留可点击但失效的操作按钮；
- Result 内部滚动区域可通过键盘聚焦和滚动；
- 长参数和 Result 不应造成页面横向溢出。

## 12. 验收场景

1. 同一 Turn 中多张 Tool Call Card 可独立展开和收起，默认均收起。
2. Approval Card 可独立展开和收起，pending 时折叠态仍可 Allow/Deny。
3. `allow_all` 与静态允许路径只显示 Tool Call Card。
4. Approval interaction ID 继续只用于 Approval lifecycle。
5. 当前串行执行下，Tool Result 更新同一 Turn 中最近一张尚未完成的 Tool Call Card。
6. 有 Result、无 Result、失败、拒绝、Abort 和未执行状态均有稳定收起态。
7. 展开 Tool Call Card 沿用当前 Tool Result 头尾预览；完整内容限高滚动。
8. 服务端不因 Web UI 展示需求截断 Approval input 或实时 Tool Result。
9. HTML-like input/result 通过文本节点显示，不执行标记或脚本。
10. 页面刷新后加载 Session 历史只重建 Tool Call Card，不生成 Approval Card。
11. 断线导致 pending Approval 关闭时，对应 Approval Card 进入 unavailable 状态。
12. 删除共享 `toolsExpanded` 后，现有 Tool 计数或 Turn 文本顺序不发生回归。

## 13. 建议实施顺序

1. 将浏览器 Turn segments 改为独立 Tool Call Card，并按当前顺序执行约束归并 Result。
2. 将 Approval Card 保持独立，并增加独立 `expanded=false`。
3. 移除 Turn 级 `toolsExpanded` 和共享 Tool toggle。
4. 合并 Tool Use 与 Result 的 UI 渲染，同时保留当前 Result renderer。
5. 增加 Manual、Allow All、拒绝、失败、Abort、重连和多 Tool Card 测试。
