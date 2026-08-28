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

- [Development Workflow](docs/development-workflow.md)
- [Contributing](CONTRIBUTING.md)
- [Agent Runner Design](docs/architecture/core-runner-design.md)
- [Runtime / App Assembly Design](docs/architecture/runtime-design.md)
- [LLM Client Design](docs/architecture/adapters-llm-design.md)
- [Prompt Builder Design](docs/architecture/core-prompt-design.md)
- [Session Design](docs/architecture/core-session-design.md)
- [Tools Design](docs/architecture/core-tools-design.md)
- [Workspace Design](docs/architecture/core-workspace-design.md)
- [OpenClaw Analysis](docs/analysis/openclaw/openclaw-analysis.md)
- [OpenClaw Prompt System Deep Dive](docs/analysis/openclaw/openclaw-prompt-system-deep-dive.md)
- [OpenClaw Context Files Flow](docs/analysis/openclaw/openclaw-contextfiles-flow.md)
