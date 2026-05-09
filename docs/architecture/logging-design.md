# 日志子系统设计（Logging Design）草案

> 状态：草案 · 待审阅
> 适用范围：my-agent（Phase 1）
> 参考：OpenClaw 的 logging-core 实践

---

## 1 概要

目的：为 `my-agent` 设计一个统一、可扩展且测试友好的日志子系统，满足开发与生产环境的可观测性需求，同时在作为库（library）被其他项目引用时保持最小侵入性。

目标要点：
- 统一子系统（subsystem）日志接口（按子系统获取 logger）
- 可配置的输出：控制台（pretty/json/compact）与可选文件（JSONL，日期滚动）
- 敏感数据脱敏工具（redact helpers）
- 外部传输钩子（registerLogTransport）用于 telemetry/OTel 等扩展
- 测试友好：测试环境下默认静默或快速路径，暴露测试辅助 API

非目标（Phase 1 不包含）：
- 内置集中式采集/聚合（仅提供 transport 接口供外部集成）
- 多租户审计或复杂保留策略

---

## 2 设计原则

- 最小侵入：默认仅输出到控制台；文件写入需显式开启或通过配置文件进行配置（不使用环境变量映射）。
- 安全优先：提供脱敏工具，避免在日志中泄露明文凭证/PII。
- 可观测性：支持外部 transport 注册，供 diagnostics/OTel/第三方上报。
- 测试友好：在 Vitest 环境下默认不写文件，并提供 `setLoggerOverride` 以便测试注入。
- 可扩展：API 与命名尽量与 OpenClaw 保持一致（createSubsystemLogger、registerLogTransport）。

---

## 3 Phase 1 范围与交付物

- API：`createSubsystemLogger`, `getLogger`/`getChildLogger`, `registerLogTransport`, `redactSensitiveText`, `setLoggerOverride` / `resetLogger`, `getResolvedLoggerSettings`。
- 默认控制台输出（`info`），支持 `pretty|compact|json` 三种风格。
- 可选文件写入：JSONL，每日滚动（my-agent-YYYY-MM-DD.log），默认关闭。
- 外部 transport（非阻塞）与测试 fast-path。
- 文档、示例与单元测试。

---

## 4 需求细化

- 一致性：所有子系统通过 `createSubsystemLogger(subsystem)` 获取 logger；日志条目包含 `time/level/subsystem/message/meta`。
- 配置优先级：
  - 配置优先级（仅针对日志）：
    1. 程序化覆盖（`setLoggerOverride()`）
    2. 配置文件（顶层 `logging` 全局配置）
    3. 默认值（控制台 `info`，文件默认关闭）

    注：本设计故意不使用环境变量映射来覆盖日志配置；如需临时调试，请使用 `setLoggerOverride()` 或修改配置文件。
- 安全：提供轻量 `redactSensitiveText()`，供记录前对 suspect 字段做脱敏处理。
- 非阻塞：日志写入/transport 不得阻塞主流程或抛出未捕获异常。
- 动态生效：配置变更能触发 logger 重建以应用新策略（缓存失效逻辑）。

---

## 5 API 草案（TypeScript 风格）

```ts
// 基本类型
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface LoggerSettings {
  level?: LogLevel;
  file?: string; // 可选，启用文件写入（可为文件路径或留空）
  /** 文件输出格式：'pretty' = 人类可读, 'jsonl' = 结构化, 'both' = 同时写两者 */
  fileFormat?: 'pretty' | 'jsonl' | 'both';
  maxFileBytes?: number;
  consoleStyle?: 'pretty' | 'compact' | 'json';
}

// 子系统 logger
export interface SubsystemLogger {
  subsystem: string;
  isEnabled(level: LogLevel, target?: 'any' | 'console' | 'file'): boolean;
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
  raw(msg: string): void; // 直接记录原始字符串（用于日志尾）
  child(name: string): SubsystemLogger;
}

// 导出函数
export function createSubsystemLogger(subsystem: string): SubsystemLogger;
export function getLogger(): unknown; // 底层 logger access
export function getChildLogger(bindings?: Record<string, unknown>, opts?: { level?: LogLevel }): unknown;
export function registerLogTransport(transport: (record: Record<string, unknown>) => void): () => void;
export function redactSensitiveText(input: string, options?: { mode?: 'default' | 'tools' | 'identifiers' }): string;
export function setLoggerOverride(settings: LoggerSettings | null): void;
export function resetLogger(): void;
export function getResolvedLoggerSettings(): LoggerSettings;
```

（具体类型可放在 `src/logging/types.ts`，实现分布在 `src/logging/*.ts`）

---

## 6 行为契约

- 文件日志采用 JSONL（每行一个 JSON 对象），便于外部采集器解析。控制台根据 `consoleStyle` 做彩色化或 JSON 输出。
- 日志 I/O 错误应被吞噬并在 stderr 记录一次警告；不得中断主流程。
- 注册的 transport 以非阻塞方式接收 log record；transport 异常不会影响主流程。
- 对于 high-volume 路径（如 stream/text delta），默认仅在 `debug/trace` 启用详细日志，避免性能开销。

### 渲染与渠道输出策略（新增）

- 记录层产出结构化 record（{ timestamp, level, subsystem, message, meta }），不在记录点固化为字符串。
- 各 channel/transport 自行渲染 record：
  - `console` / `telnet`（默认）：渲染为人类可读的 plain text（`pretty`）；可配置为 `json`。
  - `file`（默认）：渲染为 plain text（便于直接 `tail -f`），可通过 `fileFormat` 切换为 `jsonl` 或 `both`（同时写 pretty 和 jsonl）。
  - `telemetry` / `transport`：接收原始结构化 record，用于上报与索引（不经二次字符串化）。
- 配置建议示例（伪配置）：

```yaml
logging:
  level: info
  consoleStyle: pretty
  file:
    enabled: true
    path: /var/log/my-agent/my-agent-%Y-%m-%d.log
    fileFormat: jsonl # options: pretty | jsonl | both
```

- 用户可通过内置 CLI 或外部工具实时查看 JSONL，例如：

```bash
# pretty-print JSONL in real time (Unix)
tail -f my-agent-YYYY-MM-DD.log | jq --unbuffered '.'

# or use built-in pretty-printer if provided
my-agent logs --follow
```

此策略兼顾机器友好与运维友好：默认让交互渠道对人友好，同时允许文件以结构化格式被采集。

---

## 7 脱敏策略（redactSensitiveText）

- 提供轻量正则规则覆盖常见敏感样式：API keys（长随机串）、token-like、email、UUID-like、部分身份证明/卡号样式。
- 支持 `mode` 参数以调整严格度（例如 `tools` 模式对工具输入做更严格的掩码）。
- 实现建议：优先使用简单、可测试的正则与白名单；复杂脱敏交给上层或专门服务处理。

---

## 8 模块與文件建议

- `src/logging/types.ts` — 类型定义（LogLevel / LoggerSettings / SubsystemLogger）
- `src/logging/logger.ts` — 核心实现：设置解析、构建底层 logger、registerLogTransport、getLogger/getChildLogger
- `src/logging/subsystem.ts` — `createSubsystemLogger`：console formatting、routing 到 file/console/transports
- `src/logging/redact.ts` — 脱敏 helpers 与默认规则
- `test/logging/` — `logger.test.ts`, `subsystem.test.ts`, `redact.test.ts`

实现可参考 OpenClaw 的 `src/logging/logger.ts` 与 `src/logging/subsystem.ts` 的结构和测试 fast-path 设计。

---

## 9 测试计划（简要）

- 单元：
  - `redactSensitiveText` 对样例字符串断言掩码行为。
  - `registerLogTransport` 能收到记录并且注销函数生效。
  - `setLoggerOverride` 能阻止文件写入并改变解析设置。
- 集成：
  - 在 `VITEST=true` 场景下验证默认不写文件。
  - 控制台 `pretty/json` 输出格式断言。
- 性能：
  - 验证在高频日志级别下，记录函数快速返回，不产生明显开销（file disabled 时）。

---

## 10 使用示例（伪代码）

```ts
import { createSubsystemLogger, registerLogTransport, redactSensitiveText } from 'my-agent/logging';

const log = createSubsystemLogger('channel/websocket');
log.info('client connected', { clientId: 'abc', sessionKey: redactSensitiveText(sessionKey) });

const unregister = registerLogTransport((record) => {
  // 发送到 telemetry
});
// later
unregister();
```

---

## 11 风险与待决策项

- 默认是否开启文件写入？（建议：默认关闭，以兼容库调用场景）
- 脱敏严格度：Phase 1 使用轻量规则，复杂需求交由 Phase 2 或上层处理。
- 依赖选择：采用 `tslog` 等成熟库降低实现成本，或用自研轻量实现以减少依赖。

**已决定**：保留 `createSubsystemLogger` / `child` 工厂模式以支持子系统级配置、继承与测试覆盖。

---

## 12 交付物與下一步

- 交付物（Phase 1）：
  1. `docs/architecture/logging-design.md`（本草案）
  2. 最小实现：`src/logging/{types,logger,subsystem,redact}.ts`
  3. 单元/集成测试
- 下一步建议：你审阅本草案并确认两项关键决策（文件写入默认开/关、是否采用外部库）。确认后我可提交草稿为 PR 或直接实现最小模块并添加测试。
