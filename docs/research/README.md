# Research

> Status: Non-authoritative research surface

This directory is reserved for external comparisons and exploratory analysis. Research cannot override Current Architecture, accepted Decisions, stable Specifications, source/tests, or active accepted Changes.

## Current research

- [Agent Session Management Comparison](agent-session-management-comparison.md) - external comparison of Claude Code, GitHub Copilot CLI, OpenAI Codex CLI, and OpenCode.
- [Tool Activity Presentation Draft](tool-activity-presentation-design-draft.md) - non-authorizing design for independent Tool Call and Approval cards, per-card disclosure, and realtime/history presentation boundaries.
- [Tool Result 结果状态持久化设计草稿](tool-result-outcome-persistence-design-draft.md) - 四态 status 与内嵌审批的讨论来源，已由完成并归档的 [Unified Async Tool Execution Framework Change](../changes/archive/async-tool-use/plan.md) 承接；本文不再作为实现权威。
- [Turn 内统一异步 Tool Use 设计草稿](async-tool-use-design-draft.md) - 所有 Tool 共用的非阻塞控制流程、调用级活动计时与取消、宿主期限和 steering/结果交付边界；不授权实现，协议与取消收敛仍待决策。
- [Subagent Structured Tool Execution 隔离草稿](subagent-identity-event-routing-design-draft.md) - 保留上下文隔离、Child 身份/路由、并发汇总等专项分析；通用异步监督转入上一份草稿，不维护 Subagent-only 平行机制。
- [Built-in LLM Provider Design Draft](builtin-llm-providers-design-draft.md) - non-authorizing Chinese design draft for one Built-in Provider, one upstream connection, multiple Protocol Clients, and manually registered models.
- [New Session Model Draft](session-model-design-draft.md) - non-authorizing clean-format proposal derived from the comparison and current implementation.
- [Runtime Steering 与 Runner 配置设计草稿](runner-configuration-and-steering-design-draft.md) - 不授权实现的四个候选事项：Runtime steering 全局开关、Runtime/Runner 配置与默认值所有权、pending steering 批处理、可选 Model 调用预算。
- [Thinking 展示与开关设计草稿](thinking-display-and-control-design-draft.md) - 不授权实现的全 Provider thinking 采集、`thinking_delta` 事件透传、Web/CLI 展示与 `llm.thinking` 全局开关设计。
