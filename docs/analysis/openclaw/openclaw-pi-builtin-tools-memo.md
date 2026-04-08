# OpenClaw / Pi 内置工具备忘

> 记录日期：2026-04-06  
> 目的：把这次关于 "OpenClaw 和 Pi 的内置工具分别有哪些" 的结论整理成一份可单独查阅的短备忘。

## 1. 先说结论

不要把 OpenClaw 理解成维护了一份单独、静态、平铺的 builtin tools 清单。

更准确的理解是：

1. Pi 侧先提供一组基础 coding tools。
2. OpenClaw 在接线层替换/重包其中一部分工具。
3. OpenClaw 再继续叠加自己的会话、消息、内容、自动化、channel、plugin 工具。

所以最终给 agent 的并不是一份单纯的 "Pi 内置工具"，而是一个组合后的默认工具面。

---

## 2. Pi 侧基础工具

按现有分析结论，`pi-coding-agent` 默认的 `codingTools` 主要是：

1. `read`
2. `bash`
3. `edit`
4. `write`

另外它还单独导出了：

1. `grep`
2. `find`
3. `ls`

这里要注意两点：

1. `pi-ai` / `pi-agent-core` 更偏向工具抽象和执行框架，本身不是最终面向 agent 的工具清单。
2. 真正接近 "Pi 默认编码工具包" 的，是 `pi-coding-agent` 提供的 `codingTools`。

---

## 3. OpenClaw 如何在 Pi 之上重组工具

OpenClaw 的编码工具接线入口在 `createOpenClawCodingTools()`。

它做的事情不是直接透传 Pi 的 `codingTools`，而是：

1. 保留并重包 `read`
2. 保留并重包 `write`
3. 保留并重包 `edit`
4. 去掉 Pi 自带的 `bash`
5. 加入 OpenClaw 自己的 `exec`
6. 加入 OpenClaw 自己的 `process`
7. 视模型/配置条件加入 `apply_patch`
8. 再叠加 channel tools
9. 再叠加 OpenClaw 自己的业务工具

因此，如果只看编码/工作区能力，OpenClaw 当前对外的主集合更接近：

1. `read`
2. `write`
3. `edit`
4. `apply_patch`
5. `exec`
6. `process`

其中 `apply_patch` 不是无条件存在，它受模型提供方和配置开关影响。

---

## 4. OpenClaw 自己追加的工具组

OpenClaw 业务工具入口在 `createOpenClawTools()`，当前源码里能看到的主要工厂包括：

1. `canvas`
2. `nodes`
3. `cron`
4. `message`
5. `tts`
6. `image_generate`
7. `gateway`
8. `agents_list`
9. `sessions_list`
10. `sessions_history`
11. `sessions_send`
12. `sessions_yield`
13. `sessions_spawn`
14. `subagents`
15. `session_status`
16. `web_search`
17. `web_fetch`
18. `image`
19. `pdf`

除此之外，最终工具面里还有两类动态来源：

1. channel-defined tools
2. plugin tools

所以 OpenClaw 的最终工具面，严格说是：

1. Pi 基础 coding tools 的重组版本
2. OpenClaw 的编码增强工具
3. OpenClaw 的业务/会话/消息/内容工具
4. channel 动态工具
5. plugin 动态工具

---

## 5. 一个重要细节：OpenClaw 当前并不依赖 builtInTools 数组

在现有分析里，一个容易混淆的点是：

1. `pi-coding-agent` SDK 概念上有 built-in tools。
2. 但 OpenClaw 当前接线会把最终可用工具统一组织到自己的组合层里。

也就是说，从 OpenClaw 视角看，与其问 "builtInTools 数组里有哪些"，不如问：

"当前 session 默认暴露给 agent 的工具集有哪些？"

这个问题的答案，就是上面几节整理出来的组合结果。

---

## 6. 推荐的理解方式

如果后面我们要对照自己的 builtin tool 设计，建议按下面这套口径理解 OpenClaw：

1. Pi 提供基础编码工具抽象与默认 coding tool bundle。
2. OpenClaw 不直接照搬，而是在 agent 接线层重包和替换。
3. OpenClaw 再把业务工具、session 编排工具、消息/内容工具、插件工具并入最终工具面。

所以 OpenClaw 的参考价值，不是在于一份固定的 builtin tools 名单，而在于：

1. 如何把基础 coding tools 和业务工具合并成统一工具面。
2. 如何在接线层做 provider/model/policy/sandbox 过滤。
3. 如何把 `exec` / `process` / `apply_patch` 这类高风险工具放到统一策略层里处理。

---

## 7. 关键入口

本备忘对应的主要参考入口如下：

1. `docs/analysis/openclaw/openclaw-tool-system-analysis-current.md`
2. `docs/analysis/openclaw/openclaw-tool-system-analysis.md`
3. `openclaw/src/agents/pi-tools.ts`
4. `openclaw/src/agents/openclaw-tools.ts`

如果要继续追具体接线，优先看：

1. `createOpenClawCodingTools()`
2. `createOpenClawTools()`
3. `listChannelAgentTools()`
4. `resolvePluginTools()`