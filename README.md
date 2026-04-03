# my-agent

Personal AI Agent for learning purposes — exploring prompt building, workspace management, and agent architecture patterns.

## Project Structure

```
src/
├── workspace/              # Workspace initialization & context file loading
├── prompt-builder/         # System & User prompt construction
├── session/                # Session management (tree-shaped JSONL)
├── llm-client/             # LLM API client (Anthropic SDK)
└── agent-runner/           # Agent execution engine (tool use loop)
```

## Getting Started

```bash
npm install
npm run build
npm test
```

## Documentation

Design documents are in the `docs/` directory:

- [Prompt Builder Design](docs/prompt-builder-design.md)
- [Workspace Design](docs/workspace-design.md)
- [OpenClaw Analysis](docs/openclaw-analysis.md)
- [OpenClaw Prompt System Deep Dive](docs/openclaw-prompt-system-deep-dive.md)
- [OpenClaw Context Files Flow](docs/openclaw-contextfiles-flow.md)
