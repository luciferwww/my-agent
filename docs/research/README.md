# Research

> Status: Non-authoritative research surface

This directory is reserved for external comparisons and exploratory analysis. Research cannot override Current Architecture, accepted Decisions, stable Specifications, or source/tests.

## Current research

- [Smart Approval 设计草稿](smart-approval-design-draft.md) - 非权威讨论：明确 Smart 不等于 allow_all；拟采用 manual/smart/allow_all，Smart 与 allow_all 要求 Sandbox 开启；区分 Tool permission 放行和资源许可。下一步由 [Proposed 模型评估 Change](../changes/active/smart-approval-evaluation/plan.md)先验证二态/三态、后果识别与本地可行性，再决定产品标准；不授权实现、模型运行或 Change 接受。
- [Sandbox 基础文件权限设计草稿](sandbox-filesystem-baseline-design-draft.md) - 非权威讨论：区分显式依赖读取、后端 / OS 系统基线、私有临时写入与用户 read/write/deny；记录移除 System32 显式授权的本机有限对照，讨论可信程序资源及发布形态；补充取消 Home 内外特殊审批的方向和宿主文件访问边界；已确认暂保留 System32 显式授权、资源冲突交由原生规则及先接入文件工具路径校验再移除特殊审批；不授权实现、实验或权限扩大，PATH 发现和默认工作目录暂缓。
- [Default Agent Prompt 与动态 Tool Use Instructions 调研](default-agent-prompt-and-dynamic-tool-instructions-research-2026-11-23.md) - 非权威调研：核对 VS Code Copilot Chat 的 patch/edit 指导、Prompt 组件、模型选择及 section 组装顺序；结合本项目 Builder、模式、Root/Child 与持久化边界，讨论动态工具指导、可信来源、Review、测试与渐进演进；不授权实现或 Spike。
- [本地个人 Agent 的工具后果风险评估、Smart Approval 与跨平台 Sandbox 调研](smart-approval-and-cross-platform-sandbox-research-2026-11-23.md) - 非权威调研：以可能有害的操作后果而非恶意意图为核心，分离效果证据、损害维度、授权与审批；讨论可信 State、轻量模型领域适配及训练评测、Windows 优先的三平台隔离能力与失败边界；不授权实现。
- [Markdown 特殊渲染与 Mermaid 支持设计草稿](markdown-special-rendering-and-mermaid-design-draft.md) - 非权威讨论：特殊 Markdown 的闭合即显、稳定身份、结果复用与失效；以已有 KaTeX 优化和新增 Mermaid 为首批用例，覆盖安全、流式生命周期、主题、滚动及验证边界；不授权实现或 Spike。
- [主流 Agent 的 Skills 实现机制调研](mainstream-agent-skills-implementation-research-2026-11-12.md) - 比较 Claude Code、Codex、Copilot、Gemini CLI、Cursor、OpenCode，并补充 OpenClaw；核对发现、渐进加载、调用、权限、Subagent 和更新边界，区分标准、厂商扩展及源码快照；不授权实现。
- [代码结构调整建议](code-structure-recommendations.md) - 面向维护者的非权威结构分析，讨论 Settings 职责提取、Session 消息调度、应用能力契约归属、Core 基础设施边界与 Runtime 目录收敛；不授权实现。
- [Dynamic Settings 设计草稿](dynamic-settings-design-draft.md) - 主体已由 [归档 Change](../changes/archive/dynamic-settings/plan.md) 交付；暂保留其中尚未落地的自动重启候选及其 Host 协调、连接恢复与启动失败边界。不授权实现，文中的早期设计不代表当前契约。
- [Automation 系统设计草稿](automation-system-design-draft.md) - 基于 OpenClaw 与主流计划 Agent 的非权威中文设计草稿，讨论持久 Job/Run、Scheduler 边界、Detached Root Agent、Fresh Session、无人值守权限、恢复和本地常驻 Host；不授权实现。
- [Session-addressed Approval 设计草稿](session-addressed-approval-design-draft.md) - 面向 Automation 的非权威 Approval 演进草稿，讨论 Origin 与无 Origin 路由、多 Channel first-settlement-wins、WebSocket Session replay、Session 列表提醒和 process-local 边界；不授权实现。
- [主流浏览器 AI Agent 技术实现与特色调研](mainstream-browser-ai-agents-technical-research-2026-10-04.md) - 对 OpenAI、Anthropic、Google、Manus、Browser Use 与 Playwright 的浏览器控制架构、SPA/AJAX 处理、安全边界和技术选型进行非权威比较。
- [Agent Session Management Comparison](agent-session-management-comparison.md) - external comparison of Claude Code, GitHub Copilot CLI, OpenAI Codex CLI, and OpenCode.
- [Tool Activity Presentation Draft](tool-activity-presentation-design-draft.md) - non-authorizing design for independent Tool Call and Approval cards, per-card disclosure, and realtime/history presentation boundaries.
- [Turn 内统一异步 Tool Use 设计草稿](async-tool-use-design-draft.md) - 所有 Tool 共用的非阻塞控制流程、调用级活动计时与取消、宿主期限和 steering/结果交付边界；不授权实现，协议与取消收敛仍待决策。
- [Subagent Structured Tool Execution 隔离草稿](subagent-identity-event-routing-design-draft.md) - 保留上下文隔离、Child 身份/路由、并发汇总等专项分析；通用异步监督转入上一份草稿，不维护 Subagent-only 平行机制。
- [临时单 Turn Agent Session 观察与保留设计调研](ephemeral-single-turn-agent-session-design-draft.md) - 研究普通 Session 显式 subscribe/unsubscribe，以及 Subagent 与 Automation Run 共用的 Session-addressed 只读观察、terminal retention、TTL 清理和 Turn viewer；不授权实现。
- [REST 状态管理与实时事件传输边界调研](rest-and-realtime-transport-boundary-design-draft.md) - 研究 REST 状态/管理平面、Chat WebSocket 实时平面和可选 Observation WebSocket 的职责划分，提出 snapshot + delta、一致性、迁移与安全边界；不授权实现。
- [Built-in LLM Provider Design Draft](builtin-llm-providers-design-draft.md) - non-authorizing Chinese design draft for one Built-in Provider, one upstream connection, multiple Protocol Clients, and manually registered models.
- [New Session Model Draft](session-model-design-draft.md) - non-authorizing clean-format proposal derived from the comparison and current implementation.
- [Thinking 采集与展示设计草稿](thinking-capture-and-display-design-draft.md) - 非权威研究与Spike证据；Chat Completions/Responses实现已由完成并归档的[Thinking Change](../changes/archive/thinking-capture-and-display/plan.md)承接，Anthropic仍暂缓。
- [Thinking 生成与展示控制设计草稿](thinking-generation-and-display-controls-design-draft.md) - 非授权讨论来源；每模型reasoning能力、消息级选择、默认兼容、三协议映射与Relay双协议路由已由完成并归档的[Thinking Generation Controls Change](../changes/archive/thinking-generation-controls/plan.md)交付。
