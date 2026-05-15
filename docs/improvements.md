# 可改进项

## read_file 的 Image 支持

### 现状

`ToolResult.content` 目前只是 `string`，所有工具结果都以纯文本返回。

`read_file` 遇到图片文件（`.png`、`.jpg` 等）时行为未定义，可能返回乱码或报错。

> `web_fetch` 不在此范围内。它定位是"抓取可读文本"的工具，OpenClaw 同样不对图片 URL 做特殊处理（直接用 `TextDecoder` 强行解码二进制字节，返回乱码）。这个边界是合理的，不值得改。

### 目标

让 `read_file` 能够读取图片文件，并通过 Anthropic API 的 tool result content block 机制传给 LLM：

```
tool_result.content = [
  { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
]
```

### 需要改动的层

1. **`ToolResult` 类型**（`src/core/tools/types.ts`）
   - `content: string` → 支持 content block 结构（text block + image block）

2. **`read_file`**（`src/core/tools/builtin/fs/read-file.ts`）
   - 文件扩展名 / MIME 类型为图片时，读取为 base64 image block 返回

3. **Image sanitization**（参考 OpenClaw `tool-images.ts`）
   - 发给 LLM 前检查尺寸（建议上限 2000px）和文件大小（建议上限 5MB）
   - 超限时自动缩放 / 重压缩为 JPEG，实在无法压缩则替换为错误文本

4. **`CliChannel` 渲染**（`src/adapters/channel/CliChannel.ts`）
   - tool result 预览中对 image block 显示元数据占位符，如 `[image/png 42kb]`，而非截断 base64 字符串

### Binary 内容

**Binary 文件（如 `.exe`、`.zip`、`.pdf` 等）不在支持范围内，LLM 无法处理原始二进制内容。**

`read_file` 遇到非图片二进制文件时，应明确返回错误，提示用户该文件类型不受支持，而不是尝试将字节流作为文本返回。

---

## Tool Result 截断策略增强

### 现状

`src/core/runner/context/tool-result-pruning.ts` 已经实现了两层截断：

| 层 | 函数 | 阈值 | 策略 |
|---|---|---|---|
| Layer 1 | `pruneToolResults()` | `contextWindowTokens × 2 × toolResultContextShare` | 单条超限 → head + tail |
| Layer 1.5 | `pruneToolResultsAggregate()` | `contextWindowTokens × 4 × 0.3` | 总量超预算 → 按比例分摊 head + tail |

参考 OpenClaw 的 `pi-embedded-runner/tool-result-truncation.ts`，下面几点值得增强。

### 1. 增加绝对硬上限（建议落地）

OpenClaw：`min(contextWindowTokens × 0.3 × 4, 40_000)`，单条 tool result 永远不超过 40K 字符。

my-agent 只有动态阈值，没有兜底。以 200K 上下文窗口为例，单条理论上限是 `200_000 × 2 × 0.3 = 120_000` 字符，过大。

**建议**：在 `pruneToolResults()` 里加 `MAX_LIVE_TOOL_RESULT_CHARS = 40_000` 兜底，与动态阈值取较小值。

### 2. 截断点对齐到换行边界（建议落地）

OpenClaw 用 `lastIndexOf('\n')` 在 head/tail 切割点附近找最近的换行符，避免切在半行或 JSON 结构中间。

my-agent 当前是 `content.slice(0, headChars)` / `content.slice(-tailChars)` 硬切，结构化输出（JSON / 表格 / 代码）会被切坏。

**建议**：修改 `pruneToolResultContent()`，在 ±20% 邻域内找最近换行符。改动很小，对 LLM 可读性提升明显。

### 3. 智能尾部保留（待权衡）

OpenClaw 的 `hasImportantTail()` 检测尾部是否含 `error` / `traceback` / JSON 闭合 `}` / `summary` 等关键字，只有尾部"看起来重要"时才切 head+tail，否则只保留 head。

my-agent 当前无条件切 head+tail。

**权衡**：
- 优点：避免给"明显无价值的尾部"浪费预算
- 缺点：基于关键字的启发式判断不可靠，可能误伤
- 收益不一定明显，建议先观察实际使用中是否有"尾部噪音占用预算"的真实问题再做

### 4. 聚合裁剪是否优先截较新的（待权衡）

OpenClaw 的聚合截断按 index 倒序排序，**优先截较新的 tool result**，保留较老的历史上下文。

my-agent 当前按比例分摊，所有结果一视同仁。

**权衡**：
- OpenClaw 策略：保护历史，新结果易被压缩 → 适合长会话保留早期决策依据
- my-agent 策略：公平分摊 → 调试更直观，行为可预测
- 两者无绝对优劣，看具体使用场景决定，**暂不建议改动**
