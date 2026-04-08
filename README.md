# my-agent

Personal AI Agent for learning purposes — exploring prompt building, workspace management, and agent architecture patterns.

## Project Structure

```
src/
├── workspace/              # Workspace initialization & context file loading
├── prompt-builder/         # System & User prompt construction
├── session/                # Session management (tree-shaped JSONL)
├── llm-client/             # LLM API client (Anthropic SDK)
├── tools/                  # Tool definitions, executor, builtin tools
└── agent-runner/           # Agent execution engine (tool use loop)
```

## Getting Started

This project is pinned to Node 22, and npm will reject installs on other Node major versions.

```bash
nvm use
npm install
npm run build
npm test
```

## Documentation

Design documents are grouped by purpose under the `docs/` directory. Start with [Documentation Index](docs/README.md).

- [Agent Runner Design](docs/architecture/agent-runner-design.md)
- [LLM Client Design](docs/architecture/llm-client-design.md)
- [Prompt Builder Design](docs/architecture/prompt-builder-design.md)
- [Session Design](docs/architecture/session-design.md)
- [Tools Design](docs/architecture/tools-design.md)
- [Workspace Design](docs/architecture/workspace-design.md)
- [OpenClaw Analysis](docs/analysis/openclaw/openclaw-analysis.md)
- [OpenClaw Prompt System Deep Dive](docs/analysis/openclaw/openclaw-prompt-system-deep-dive.md)
- [OpenClaw Context Files Flow](docs/analysis/openclaw/openclaw-contextfiles-flow.md)
