# Research

> Status: Non-authoritative research surface

This directory is reserved for external comparisons and exploratory analysis. Research cannot override Current Architecture, accepted Decisions, stable Specifications, source/tests, or active accepted Changes.

## Current research

- [Agent Session Management Comparison](agent-session-management-comparison.md) - external comparison of Claude Code, GitHub Copilot CLI, OpenAI Codex CLI, and OpenCode.
- [Session History Progressive Loading Draft](session-history-loading-design-draft.md) - non-authorizing design for active-branch history pagination, bounded transport DTOs, and incremental WebSocket client loading.
- [Tool Activity Presentation Draft](tool-activity-presentation-design-draft.md) - non-authorizing design for independent Tool Call and Approval cards, per-card disclosure, and realtime/history presentation boundaries.
- [Built-in LLM Provider Design Draft](builtin-llm-providers-design-draft.md) - non-authorizing Chinese design draft for one Built-in Provider, one upstream connection, multiple Protocol Clients, and manually registered models.
- [New Session Model Draft](session-model-design-draft.md) - non-authorizing clean-format proposal derived from the comparison and current implementation.
- [Runtime Steering 与 Runner 配置设计草稿](runner-configuration-and-steering-design-draft.md) - 不授权实现的四个候选事项：Runtime steering 全局开关、Runtime/Runner 配置与默认值所有权、pending steering 批处理、可选 Model 调用预算。
