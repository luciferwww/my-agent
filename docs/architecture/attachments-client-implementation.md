# 用户消息附件支持 · 客户端实施文档（chat.html）

> 配套 spec：[attachments-support-spec.md](./attachments-support-spec.md)
> 服务端实施：[attachments-server-implementation.md](./attachments-server-implementation.md)（已合入）
> 改动范围：单文件 [clients/html/chat.html](../../clients/html/chat.html)
> 不含：CliChannel 附件输入（Phase 2）、document/PDF chip、image bubble 富交互（缩放 / 下载 / 灯箱）

---

## 1. 与服务端契约对齐（不重新设计，只摘要）

| 项 | 约定 | 来源 |
|---|---|---|
| wire payload `message` 字段 | `string \| InboundContentBlock[]`，纯文本时仍发 string（不强制升数组） | spec 决策 1 |
| `InboundContentBlock` shape | `{type:'text', text}` 或 `{type:'image', source:{type:'base64', media_type, data}}`；**不带 `dimensions`**，由 server 重新 sniff | spec 决策 2 + server impl PR-4 |
| 附件编码位置 | 客户端 FileReader → base64，channel 透传 | spec 决策 2 |
| 单图原图上限 | `ATTACHMENT_RAW_MAX_BYTES = 10 MB`；超过 server 直接丢弃 | spec 决策 4 |
| Inline 阈值 | `2 MB`：超过此值 server 会静默 resize 后入库 | spec 决策 4 |
| 附件失败行为 | server 不发任何事件、不拒收 turn；可能在消息文本尾追加「N 个附件…已忽略」 | server impl §2.x |
| Steering 携带附件 | server 静默剥离非 text block，仅文本进 steering inbox | spec 决策 6 + server impl PR-6 |
| 「已压缩」展示 | 前端用上传原始字节本地推断（> 2 MB 即标注），不依赖 server 回传 | server impl §4 |

> **关键蕴含**：客户端无需任何 server-side 校验回执，也不需要 server 推送的 `attachment_*` 事件——这类事件根本不存在。客户端做的所有校验都是 UX 体验层（让用户少等、少传一次），不构成正确性闭环。

---

## 2. 现状盘点（chat.html 1649 行，Vue 3 单文件 SFC-like）

| 锚点 | 行号 | 现状 |
|---|---|---|
| Send payload 构造 | [1303-1317](../../clients/html/chat.html#L1303) `sendMessage()` | `message: text`（string 硬编码） |
| Composer DOM | [1128-1149](../../clients/html/chat.html#L1128) `<footer class="composer">` | 单 textarea + 两个按钮（Reset / Send⇄Steer） |
| `canSend` 计算 | [1202-1205](../../clients/html/chat.html#L1202) | 依赖 `draft.trim().length > 0` |
| 用户气泡渲染 | [1120-1123](../../clients/html/chat.html#L1120) | `<div class="bubble">{{ item.text }}</div>`，**仅 string** |
| chat 状态模型 | [1167-1196](../../clients/html/chat.html#L1167) `data()` | `chatItems[]` + `turnMap` + `isWaitingForReply` 等；无任何附件相关字段 |
| Steering 判定 | [1306](../../clients/html/chat.html#L1306) | `isSteer = this.isWaitingForReply`；UI 上仅 Send 按钮文案变 |
| CSS 体系 | [9-909](../../clients/html/chat.html#L9) | CSS 自定义变量（`--bg` / `--panel` / `--accent` 等）+ 类 BEM 命名；无 utility 框架 |
| 历史回放 | none | 不拉历史，刷新即归零（spec/server 也未要求；本 PR 不补） |

---

## 3. 实施步骤

按内聚改动切两段；可在单个 PR 内交付，但 review 时按 §3.1 → §3.2 顺序检查。

### 3.1 入站侧：附件输入 + chip 预览 + payload 装配

#### 新增 `data()` 字段

```js
attachments: [],     // Array<Attachment>，详见下方 shape
attachError: '',     // 用户可见错误文案（一次性，下次 attach 动作清空）
dragHover: false,    // composer 拖拽高亮态
dragDepth: 0,        // dragenter/leave 计数器，规避子元素冒泡误关高亮
```

> **`nextId` 不新增**：[chat.html:1189](../../clients/html/chat.html#L1189) `data()` 已声明 `nextId: 1`（chatItems id 用），附件 id 复用同一计数器即可，避免双轨。

`Attachment` 形状（**纯 client 内部模型**，不与 wire 重名以防混淆）：

```ts
{
  id: number;           // this.nextId++
  file: File;           // 原始 File（仅用于二次推断 size / type，不直接发送）
  name: string;         // file.name
  mediaType: string;    // file.type，必须命中 SUPPORTED_IMAGE_MIME（见下）
  sizeBytes: number;
  base64: string;       // 已 strip data URL prefix 的纯 base64
  willResize: boolean;  // sizeBytes > 2 MB → true，UI 显示「已压缩」chip
  previewUrl: string;   // URL.createObjectURL(file)，仅本地缩略图用；revoke 时机见下
}
```

#### 新增常量（紧邻 `DEFAULT_*`）

```js
const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ATTACHMENT_INLINE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const ATTACHMENT_RAW_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
```

> **数值与 server `src/core/media/constants.ts` 严格对齐**——spec 决策 4 已声明这些是「跨模块·含前后端」的共享常量，client 不擅自收紧。`MAX_ATTACHMENTS_PER_MESSAGE = 20` 在 spec 里定位为「数组长度安检防 `Array(1e6)` 病态输入」，真正约束是 `ATTACHMENT_TOTAL_MAX_BYTES = 10 MB`（`ingestFiles` 累计 sizeBytes 时同时校验，超出则截断）。
>
> **为什么 client 也校验？** spec 明示 server 会丢弃违规附件。client 提前校只为省一次上传（10 MB 在弱网下 > 30s）和一次「为什么这张图没在历史里」的困惑；不是正确性必需。`SUPPORTED_IMAGE_MIME` 同理——server sniff 会拒非图片，client 提前拒只为提示文案更友好。
>
> **未来漂移**：若 server 调高常量，client 这份必须同步——v1 通过 review 红线保证；Phase 2 可考虑 `/static/media-constants.json` fetch（spec 决策 0 已留口子）。

#### 新增方法

```js
// ── 附件采集 ──
async ingestFiles(fileList) {
  // 1. 过滤 mime → SUPPORTED_IMAGE_MIME；不命中累计到 attachError
  // 2. 过滤 sizeBytes > ATTACHMENT_RAW_MAX_BYTES；超过累计到 attachError
  // 3. 校验累计总字节 ≤ ATTACHMENT_TOTAL_MAX_BYTES（已入 this.attachments + 本次通过的）；
  //    超出从尾部截断 + 累计「总额超限」提示
  // 4. 校验数量 ≤ MAX_ATTACHMENTS_PER_MESSAGE（数组长度安检，正常用户不会触到）；
  //    溢出截断 + 累计提示
  // 5. 对每张通过的：await readAsBase64(file) → push Attachment（同步 base64，不 chunked，因为已限 10 MB）
  // 6. setAttachError(累计文案)
},

readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('FileReader failed'));
    r.onload = () => {
      const s = String(r.result ?? '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);  // strip "data:image/png;base64," 前缀
    };
    r.readAsDataURL(file);
  });
},

removeAttachment(id) {
  const idx = this.attachments.findIndex(a => a.id === id);
  if (idx >= 0) {
    URL.revokeObjectURL(this.attachments[idx].previewUrl);
    this.attachments.splice(idx, 1);
  }
},

clearAttachments() {
  for (const a of this.attachments) URL.revokeObjectURL(a.previewUrl);
  this.attachments = [];
},

// ── DOM 事件入口 ──
onAttachClick() { this.$refs.fileInput?.click(); },
onFileInputChange(e) {
  this.ingestFiles(e.target.files);
  e.target.value = '';  // 同一文件再次选择能再次触发
},
onPaste(e) {
  const files = [];
  for (const it of e.clipboardData?.items ?? []) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();           // 阻止 base64 字符串污染 textarea
    this.ingestFiles(files);
  }
},
onComposerDragEnter(e) {
  e.preventDefault();
  this.dragDepth++;
  this.dragHover = true;
},
onComposerDragOver(e) { e.preventDefault(); },  // 必须 preventDefault 才能触发 drop
onComposerDragLeave(e) {
  // dragleave 在子元素切换时也会触发；用计数器抵消，避免高亮闪烁
  this.dragDepth = Math.max(0, this.dragDepth - 1);
  if (this.dragDepth === 0) this.dragHover = false;
},
onComposerDrop(e) {
  e.preventDefault();
  this.dragDepth = 0;
  this.dragHover = false;
  this.ingestFiles(e.dataTransfer?.files);
},
```

#### 修改 `canSend`

```js
canSend() {
  if (!this.isConnected || !this.helloAcknowledged) return false;
  if (this.pendingApprovalCount > 0) return false;
  if (this.isWaitingForReply && this.attachments.length > 0) return false;  // ← Steering 不许带图
  const hasText = this.draft.trim().length > 0;
  const hasAttachments = this.attachments.length > 0;
  return hasText || hasAttachments;
},
```

> **Steering + 附件硬禁，不软警告**：spec 决策 6 锁死了「steering 不带附件」。server 端会静默剥离，但 client 让按钮 disabled 才能让用户立刻明白——否则用户会以为「图发出去了」，结果只有文本到了 LLM，调试痛苦。文案提示：`canSend === false && attachments.length > 0 && isWaitingForReply` 时在 chip 区域上方一行红字「打断中的回复不能携带附件，请移除后发送」。

#### 修改 `sendMessage`

```js
sendMessage() {
  if (!this.canSend) return;
  const text = this.draft.trim();
  const isSteer = this.isWaitingForReply;
  const hasAttachments = this.attachments.length > 0;

  // wire payload 构造
  let wireMessage;
  if (!hasAttachments) {
    wireMessage = text;                                    // 纯文本走原 string 路径
  } else {
    const blocks = [];
    if (text) blocks.push({ type: 'text', text });
    for (const a of this.attachments) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType, data: a.base64 },
      });
    }
    wireMessage = blocks;
  }

  // 本地气泡：保留文本 + chip 缩略；不再是单 string
  this.appendChatItem({
    kind: 'user',
    label: 'You',
    text,
    isSteer,
    attachments: hasAttachments
      ? this.attachments.map(a => ({
          id: a.id,                   // 稳定 key，气泡 v-for 用
          previewUrl: a.previewUrl,   // 直接复用 ObjectURL，本地内存指针
          name: a.name,
          sizeBytes: a.sizeBytes,
          willResize: a.willResize,
        }))
      : [],
  });

  this.sendJson({
    type: 'run_turn',
    sessionKey: this.form.sessionKey,
    message: wireMessage,
    ...(this.form.model ? { model: this.form.model } : {}),
  });

  this.pushEvent(
    isSteer ? 'steer' : 'run_turn',
    `Sent ${isSteer ? 'steer ' : ''}message to session ${this.form.sessionKey}` +
      (hasAttachments ? ` (${this.attachments.length} attachment${this.attachments.length !== 1 ? 's' : ''})` : ''),
  );

  this.draft = '';
  this.attachments = [];   // 不 revoke，因为本地气泡还在用同一个 previewUrl 引用
  this.attachError = '';
  this.isWaitingForReply = true;
},
```

> **ObjectURL 不在 send 时 revoke**：因为本地气泡的 `<img :src="att.previewUrl">` 仍在引用同一 URL；revoke 后图会立刻断裂。`previewUrl` 的生命周期 = 该气泡的 DOM 生命周期 = 整个 session 标签页存活期。`clearAttachments()` 仅在「用户点了 chip × 删除」或「显式 reset」时 revoke——发送成功不 revoke。会泄漏？是，每图 ~几 KB，单 session 内可接受；浏览器关 tab 自动回收。

#### Composer DOM 改造

替换现有 `<footer class="composer">` 块：

```html
<footer
  class="composer"
  :class="{ 'is-dragging': dragHover }"
  @dragenter="onComposerDragEnter"
  @dragover="onComposerDragOver"
  @dragleave="onComposerDragLeave"
  @drop="onComposerDrop"
>
  <!-- chip 预览区：仅在有附件或有 attachError 时显示 -->
  <div v-if="attachments.length > 0 || attachError" class="composer-attachments">
    <div v-if="attachError" class="composer-attach-error">{{ attachError }}</div>
    <div v-if="attachments.length > 0" class="attachment-chip-row">
      <div v-for="a in attachments" :key="a.id" class="attachment-chip">
        <img :src="a.previewUrl" :alt="a.name" />
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">{{ a.name }}</span>
          <span class="attachment-chip-size">{{ formatBytes(a.sizeBytes) }}</span>
          <span v-if="a.willResize" class="attachment-chip-badge">已压缩</span>
        </div>
        <button class="attachment-chip-remove" @click="removeAttachment(a.id)" aria-label="移除附件">×</button>
      </div>
    </div>
    <div v-if="isWaitingForReply && attachments.length > 0" class="composer-attach-error">
      打断中的回复不能携带附件，请移除后发送。
    </div>
  </div>

  <label>
    Message
    <textarea
      v-model="draft"
      placeholder="给 agent 发送一条消息…"
      @keydown.enter.exact.prevent="sendMessage"
      @paste="onPaste"
    ></textarea>
  </label>

  <input
    ref="fileInput"
    type="file"
    accept="image/png,image/jpeg,image/webp,image/gif"
    multiple
    hidden
    @change="onFileInputChange"
  />

  <div class="composer-row">
    <div class="composer-hint">
      <span>Enter 发送，Shift+Enter 换行。📎 / 拖拽 / 粘贴均可附图（≤ 10 MB，最多 {{ MAX_ATTACHMENTS_PER_MESSAGE }} 张）。</span>
    </div>
    <div class="button-row">
      <button
        class="secondary"
        @click="onAttachClick"
        :disabled="!isConnected || isWaitingForReply"
        :title="isWaitingForReply ? 'Steering 状态不支持附件' : '添加图片'"
      >📎 图片</button>
      <button class="secondary" @click="resetComposer" :disabled="!draft && attachments.length === 0">Reset</button>
      <button class="primary" @click="sendMessage" :disabled="!canSend">
        {{ pendingApprovalCount > 0 ? 'Approval pending…' : isWaitingForReply ? 'Steer' : 'Send' }}
      </button>
    </div>
  </div>
</footer>
```

新增 `resetComposer()`：`this.draft = ''; this.clearAttachments(); this.attachError = '';`（取代原 `draft = ''` 内联）。

#### CSS 新增（追加到 `<style>` 末尾，复用现有 CSS 变量）

```css
.composer.is-dragging { outline: 2px dashed var(--accent); outline-offset: -8px; }
.composer-attachments { display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; }
.composer-attach-error { color: var(--danger, #c0382b); font-size: 12px; }
.attachment-chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
.attachment-chip {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border: 1px solid var(--border, #2a2a2a); border-radius: 8px;
  background: var(--panel-muted, rgba(255,255,255,0.03));
}
.attachment-chip img { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; }
.attachment-chip-meta { display: flex; flex-direction: column; font-size: 11px; line-height: 1.3; }
.attachment-chip-name { color: var(--fg, #e5e5e5); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-chip-size { color: var(--fg-muted, #888); }
.attachment-chip-badge {
  display: inline-block; margin-top: 2px; padding: 0 6px; border-radius: 999px;
  background: var(--accent-soft, rgba(100,180,255,0.15)); color: var(--accent, #6cb6ff); font-size: 10px;
}
.attachment-chip-remove {
  appearance: none; background: transparent; border: none; cursor: pointer;
  color: var(--fg-muted, #888); font-size: 16px; padding: 0 4px;
}
.attachment-chip-remove:hover { color: var(--danger, #c0382b); }
```

> **CSS 变量回退值**：现有 `<style>` 区可能未定义 `--danger` / `--accent-soft` / `--border` / `--panel-muted`；提供 fallback 值即可，必要时再补到根变量声明。

#### `formatBytes` helper

```js
formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
```

### 3.2 出站侧：用户气泡渲染附件

修改 [1120-1123](../../clients/html/chat.html#L1120)：

```html
<template v-else>
  <div class="bubble">
    <div v-if="item.text" class="bubble-text">{{ item.text }}</div>
    <div v-if="item.attachments && item.attachments.length > 0" class="bubble-attachments">
      <div v-for="att in item.attachments" :key="att.id" class="bubble-attachment">
        <img :src="att.previewUrl" :alt="att.name" />
        <div class="bubble-attachment-meta">
          <span>{{ att.name }}</span>
          <span>{{ formatBytes(att.sizeBytes) }}{{ att.willResize ? ' · 已压缩' : '' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
```

CSS：

```css
.bubble-text + .bubble-attachments { margin-top: 8px; }
.bubble-attachments { display: flex; flex-wrap: wrap; gap: 8px; }
.bubble-attachment { display: flex; flex-direction: column; gap: 4px; max-width: 240px; }
.bubble-attachment img { width: 100%; max-height: 240px; object-fit: contain; border-radius: 6px; background: rgba(0,0,0,0.2); }
.bubble-attachment-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--fg-muted, #888); }
```

> **不展示 server-side 「N 个附件…已忽略」回执**：server 的 silent-drop + 可选 notice 走的是消息文本尾追加，不是事件。client 只会在历史回放（未来 PR）里看到那段尾巴。当前 PR 不补历史回放，所以「我发了 12 MB 图但 server 丢了」对客户端表现为：本地气泡有图（用 `previewUrl` 显示），但下次刷新页面就没有了。这是预期且 spec 不要求堵漏；如要在 v1 堵，需要 server 在发送响应里回吐「dropped 列表」——明确不做（与 spec 决策一致）。

---

## 4. 不在本文档范围（v1 客户端）

- **历史回放**：刷新页面拉过往 JSONL 并渲染（包含 image entry）。当前 client 本就不拉历史，本 PR 不破例。
- **Image bubble 富交互**：点击放大 / 灯箱 / 右键下载。`<img>` 简单嵌入即可。
- **拖拽到非 composer 区域**：仅 composer 内 dragover/drop 生效，避免劫持全局拖拽与浏览器默认打开图片的行为。
- **进度条 / 取消**：base64 编码同步、单图 ≤ 10 MB；编码耗时可忽略，无需取消。WebSocket 发送也不显示进度。
- **HEIC / AVIF / SVG**：HEIC 浏览器无解码、SVG 是 XML 不走 image block；mime 白名单显式排除。

---

## 5. 测试矩阵

> 客户端测试以**手工 + 本地 server**为主；不写 Playwright（项目无 e2e 基础设施）。

### 5.1 手工冒烟（必跑）

| 场景 | 步骤 | 期望 |
|---|---|---|
| 📎 单图发送 | 起 server → 连 ws → 点📎选 200 KB png → Send | chip 出现 → 发出后 chip 消失 + 气泡含缩略 → server JSONL 写入 image entry |
| 多图（3 张）| 同上选 3 张 png + 输入文本 → Send | 3 个 chip + 文本 → wire payload 为 4-block 数组（text first）→ 气泡按顺序显示文本和图 |
| Paste | 截图后焦点 textarea → Ctrl+V | chip 出现，textarea 文本未被 base64 污染 |
| 拖拽 | 拖图到 composer | composer 高亮（`is-dragging`），松手后 chip 出现 |
| 「已压缩」标 | 选 3 MB jpg | chip + 气泡均显示「已压缩」 |
| 超大拒收 | 选 12 MB png | chip 不出现，`attachError` 显示「超过 10 MB」 |
| 类型拒收 | 选 .svg 或 .pdf | chip 不出现，`attachError` 显示 mime 不支持 |
| 总额上限 | 连续选若干张累计 > 10 MB（例 6 张 2 MB jpg） | 累计未超的入 chip，超出部分被截断 + `attachError` 显示「总额超限」 |
| 数量上限（安检） | 选 21 张小图（每张 < 100 KB，累计 < 10 MB） | 前 20 张入 chip，第 21 张被截断 + `attachError` 显示「最多 20 张」 |
| Steering 禁附件 | 发起一轮回复（不要 send 完）→ 趁 isWaitingForReply 点📎 | 📎按钮 disabled |
| Steering 既有附件兜底 | 先选图（draft 空）→ assistant 开始回复（isWaitingForReply=true）→ 点 Send | Send 按钮 disabled + 红字提示「移除后发送」 |
| Remove chip | 选 2 张 → 点其中一张的 × | 仅该 chip 消失 + `previewUrl` 已 revoke（DevTools 可观察） |
| Reset | 输入文本 + 选图 → 点 Reset | 文本清空、chip 全清、`attachError` 清空 |

### 5.2 端到端联调

server 端运行 `pnpm dev`（或集成脚本里的 RuntimeApp），用 chat.html 发：
- 1 张 4 MB png + 文本「描述这张图」→ 期望 LLM 收到 resize 后 base64；JSONL 含 image entry（base64 长度 < 原图 char 数）。
- 1 张 6 MB png + 1 张 200 KB png → wire payload 两个 image block；server `attachment-pipeline` 仅对 6 MB 那张 resize。

不写自动化 e2e。如未来加，对接 `scripts/test-runtime-attachments-integration.ts` 的 ws server 起停模式即可。

---

## 6. 风险检查表

| 风险 | 触发条件 | 缓解 / 检测 |
|---|---|---|
| Paste 把 base64 字符串写进 textarea | 漏 `e.preventDefault()` | 手工冒烟「Paste」场景 |
| ObjectURL 提前 revoke 导致气泡图断裂 | sendMessage 内调 `clearAttachments()` | 改 `this.attachments = []` 不调 revoke；冒烟「单图发送」后等几秒看图是否还在 |
| 拖拽劫持浏览器默认打开图片 | 仅 composer 绑事件，未阻止 window 默认 | 拖到 composer 外不响应（默认浏览器打开是预期），拖到 composer 内 `e.preventDefault()` |
| 大 base64 卡 UI | FileReader 同步阻塞 | 限 10 MB；base64 化 ~10 MB 耗时 < 100 ms，可接受；不引入 worker |
| `image/gif` 动图被 server resize 成静帧 | sharp resize 默认取首帧 | 已在 spec/server impl 风险表登记；client 只透传，不二次决策 |
| Steering 携带附件被 server 静默剥离 | 漏 §3.1 的 `canSend` / Send disabled 逻辑 | 冒烟「Steering 禁附件」+「Steering 既有附件兜底」 |
| `<img :src="ObjectURL">` 在 v-for 重排时闪烁 | Vue key 用 index 而非 id | composer chip 用 `:key="a.id"`、用户气泡 `attachments` 快照固化 `id` 字段后 `:key="att.id"` |
| 大量历史气泡持有 ObjectURL 内存泄漏 | 长 session 反复发图 | v1 接受；未来加历史回放 + 滚动卸载时再处理 |
| client `SUPPORTED_IMAGE_MIME` 与 server sniff 白名单漂移 | server 后续支持 avif，client 仍拒 | 风险登记；不解决（client 更严无害，只是少能发） |

---

## 7. 改动文件清单

| 文件 | 动作 |
|---|---|
| [clients/html/chat.html](../../clients/html/chat.html) | 唯一改动文件：常量 + `data()` + 8 个新方法 + `canSend` / `sendMessage` 修改 + composer DOM + 用户气泡 DOM + CSS |
| [clients/html/chat2.html](../../clients/html/) | 已在本 PR 前置清理中删除（遗留，无 import 引用） |

无新增依赖。无 TypeScript 改动。无 server 改动。

---

## 8. 合入顺序

单 PR 即可。若 review 想细拆，按 §3 自然边界：

```
3.1 (intake + chip + payload) ──→ 3.2 (bubble rendering)
```

3.2 可单独 merge 不影响 3.1 行为（仅气泡显示退化为「只有文本」，附件仍走 wire 到 server 并入库）。
