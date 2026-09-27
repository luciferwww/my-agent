# HTTP + SSE (Server-Sent Events) Channel 设计草稿

> Status: Non-authorlibative design draft
> Authorization: 不授权实现，不覆盖 Current Architecture、Accepted Decisions、Stable Specifications 或源代码
> Scope: 将 WebSocket Channel 替换/重构为基于 HTTP + SSE 的轻量级通信方案

## 1. 问题与背景

当前的 `websocket-channel` 依赖 WebSocket 协议实现全双工通信。虽然 WebSocket 提供了极佳的实时性，但对于 `my-agent` 的典型使用场景（指令下发 $\to$ 任务执行 $\to$ 进度/日志流式推送）存在以下痛点：

1.  **开销过大**：维持长连接的 TCP 状态、心跳机制以及复杂的帧协议（Framing）对于低频指令交互而言过于沉重。
2.  **中间件不友好**：WebSocket 在穿透 Nginx 代理、Cloudflare CDN 或复杂的企业级防火墙时经常需要特殊的配置（如 Upgrade 报文、长连接超时调整）。
3.  **协议冗余**：Agent 的交互模式大部分时间是单向的状态流（Streaming），并不需要客户端频繁地向服务端发送密集型二进制数据。

## 2. 设计目标

本草稿提出一种 **"HTTP REST (Command) + SSE (Observability)"** 的混合架构方案，旨在实现：
1.  **轻量化**：利用标准的 HTTP/1.1 或 HTTP/2 协议，实现零额外协议开销。
2.  **高兼容性**：完全兼容所有标准的 HTTP 代理、缓存和负载均衡器。
3.  **低复杂度**：利用浏览器原生的 `EventSource` API 自动处理断线重连和流式解析。
4.  **职责分离**：将“指令下发（Request-Response）”与“状态监控（Streaming）”解耦。

## 3. 核心架构设计

### 3.1 通信模式拆分

设计将通信链路拆分为两个独立的逻辑通道：

#### A. 交互通道 (Command Channel) —— 基于 HTTP POST
*   **职责**：客户端向 Agent 发送结构化指令（例如：开始任务、停止任务、模型切换等）。
*   **模式**：**Request $\to$ Response**。
*   **协议**：`POST /api/channel/command`。
*   **数据格式**：`application/json`。
*   **特点**：短连接，完成即关闭。

#### B. 监控通道 (Observability Channel) —— 基于 SSE (Server-Sent Events)
*   **职责**：服务端向客户端推送 Agent 的运行状态、Tool Call 进度、实时日志、Execution Step 及结果。
*   **模式**：**Server $\to$ Client (Unidirectional Stream)**。
*   **协议**：`GET /api/channel/stream`。
*   **数据格式**：`text/event-stream`（Event-based data chunks）。
*   **特点**：长连接，单向流，利用浏览器的 `EventSource` 实现自动重连。

### 3.2 数据协议规范 (SSE Payload)

每一个 SSE 事件应包含 `event` 类型和 `data` 负载。

**示例 1：工具调用触发 (Tool Use Event)**
```text
event: tool_use
data: {"tool_name": "web_fetch", "params": {"url": "..."}}
```

**示例 2：执行状态更新 (Status Event)**
```text
event: status
data: {"status": "running", "message": "Fetching content..."}
```

**示例 3：工具执行结果 (Tool Result Event)**
```text
event: tool_result
data: {"tool_name": "web_fetch", "status": "success", "result": "..."}
```

## 4. 客户端实现逻辑

### 4.1 交互流程 (Client Side)
1.  **监听层**：初始化 `new EventSource('/api/channel/stream')`。
2.  **事件驱动**：根据 `event` 字段的类型，将接收到的 `data` 注入到 Vue/React 的 `segments` 状态中（参考 `tool-activity-presentation` 设计）。
3.  **指令发送**：当用户点击按钮时，调用 `fetch('/api/channel/command', { method: 'POST', body: ... })`。

### 4.2 自动重连处理
由于使用了 `EventSource`，当网络波动导致浏览器与 Agent 断开连接时，浏览器会自动尝试重新连接。客户端需要实现一个 **"Reconnection Sync"** 机制：连接重建后，通过向服务端请求最后一次已收到的 `message_int` 或 `timestamp` 来补全缺失的日志。

## 5. 服务端实现要求

1.  **Endpoint 实现**：
    *   `GET /api/channel/stream` 需要保持长连接响应，并持续写入 `data: ...\n\n` 格式的数据包。
    *   控制 `Cache-Control: no-cache` 以防止代理服务器缓存流数据。
2.  **状态同步**：
    *   服务端需要维持一个轻量级的全局状态（或按 Session 隔离），记录当前正在进行的任务进度，以便新连接的 SSE 客户端能够“追赶”进度。

## 6. 复杂度分析 (Complexity Analysis)

| 维度 | 复杂度 (WebSocket) | 复杂度 (HTTP + SSE) | 评价 |
| :--- | :--- | :--- | :--- |
| **协议解析** | 需要解析 WebSocket Frame 分帧逻辑 | 标准 HTTP 报文解析 | SSE 胜 |
| **状态机** | 需要维护复杂的双向会话心跳 | 仅需维护单向流的持续写入 | SSE 极简 |
| **重连逻辑** | 需手动编写 WebSocket Reconnect 逻辑 | 浏览器 `EventSource` 原生支持 | SSE 胜 |
| **并发扩展性** | 每一个连接都占用较多内存 | 极其轻量，易于通过 HTTP 负载均衡扩展 | SSE 胜 |

## 7. 结论与后续计划

**结论**：迁移到 HTTP + SSE 方案是技术上更成熟、架构上更现代化的选择。它降低了 Agent 插件的维护成本，同时利用了 Web 标准的稳定性。

**后续任务 (Next Steps)**：
1.  [ ] **定义数据模型**：统一 `command` 的 JSON 结构与 `stream` 的 Event 结构。
2.  [ ] **原型开发**：实现一个最小化的 `http-sse-channel` 插件原型。
3.  [ ] **客户端重构**：修改 `chat.html` 的通信层，从 `new WebSocket()` 迁移至 `new EventSource()`。
4.  [ ] **回退方案**：保留或兼容原有的 `websocket-channel` 以应对极端双向交互需求。
