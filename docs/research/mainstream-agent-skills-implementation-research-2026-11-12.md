# 主流 Agent 的 Skills 实现机制调研

> Status: Non-authoritative research
> Date: 2026-11-12
> Scope: Claude Code、OpenAI Codex、GitHub Copilot、Gemini CLI、Cursor、OpenCode；补充 OpenClaw。
> 本文记录外部产品的机制与差异，不是 my-agent 的实现方案，不授权生产代码修改，也不覆盖现有架构、规格或已接受的决策。

## 1. 结论先行

**主流产品里的 Skill，首先是可发现、可按需加载的指令与资源包，不是一个独立 Agent，也不天然等于新 Tool。**

共同骨架是：

```text
发现 Skill → 展示名称、描述和定位信息 → 用户指定或模型选用
         → 加载详细指令 → 按需读取资源、调用既有工具
```

真正需要比较的是六件事：

1. **发现什么：** 哪些目录、插件或远程来源参与发现，名称冲突怎样处理。
2. **何时进入上下文：** 初始目录、完整正文和附属文件分别何时提供给模型。
3. **谁触发：** 用户显式指定、模型自主匹配，还是宿主直接选择并注入。
4. **获得什么权限：** 仅增加指令，还是另有文件目录授权、工具预批准或执行上下文变化。
5. **怎样生效和更新：** 当前对话、当前 Turn、后续 Turn、重载和新 Session 的边界。
6. **谁能看到：** 主 Agent、Subagent、不同工作目录，以及本地与云端是否共享同一份目录。

最有参考价值的实现分别是：

- **Gemini CLI：** 激活流程清晰，适合研究最小闭环：目录、激活 Tool、确认、正文和资源目录。
- **Codex：** 宿主显式注入与模型隐式选用并存，值得研究路径身份、上下文预算及执行环境边界。
- **OpenCode：** 目录广告、显式加载和权限检查分开，并处理目录增量更新。
- **Claude Code：** 产品能力最丰富，但参数、动态命令、权限扩展和 Subagent 执行不应一起当作基础需求照搬。
- **Copilot、Cursor：** 编辑器、运行后端和云端边界很重要，不能只看到兼容目录就认定实现一致。

## 2. 调研方法与证据边界

本文优先采用官方文档，并对 Codex、Gemini CLI、OpenCode 和 VS Code 的相关公开源码做交叉核对。没有运行这些产品做端到端实验，也没有把文档承诺等同于当前本机已安装版本的行为。

| 对象 | 本次主要证据 | 限制 |
|---|---|---|
| Agent Skills 标准 | [官方规范][spec] | 是文件格式和集成约定，不是所有厂商实现的完整协议 |
| Claude Code | [官方 Skills 文档][claude] | 未核对核心运行时源码 |
| Codex | [官方文档][codex]、固定提交的 Rust 源码 | 源码快照包含多执行环境和扩展路径，不等于每个发布版本均已启用 |
| GitHub Copilot | [官方概念文档][copilot]、[VS Code 文档][vscode-docs]、[CLI 文档][copilot-cli]、固定提交的 VS Code 源码 | 编辑器源码不能证明 CLI 或云端模型执行器的全部内部行为 |
| Gemini CLI | [官方文档][gemini-docs]、固定提交的 TypeScript 源码 | 文档描述与具体确认策略需要结合源码理解 |
| Cursor | [官方文档][cursor] | 未核对核心运行时源码 |
| OpenCode | [当前官方文档][opencode-docs]、固定提交的源码 | 本次是当前 V2 文档和开发源码，不能直接套用旧版示例 |
| OpenClaw | [官方文档][openclaw] | 补充比较，未完成源码级交叉验证 |

源码快照：

- Codex：`c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee`。
- Gemini CLI：`aeb6c04b093eb00c33585ba587c4889ae4c5e957`。
- OpenCode：`101776024cc69bafb3f9dc90027ab4d1eab40a2a`。
- VS Code：`52073a464821e207fc0510f2b6ccdba47f706aad`。

官方在线文档与 `main` / `dev` 源码都会更新。尤其是 VS Code 文档中带 feature 标记的能力，不作为所有稳定版、所有 Agent 后端都已支持的结论。

## 3. 标准到底规定了什么

[Agent Skills 规范][spec] 的核心是一个目录：

```text
example-skill/
  SKILL.md
  scripts/       可选
  references/    可选
  assets/        可选
```

`SKILL.md` 包含 YAML frontmatter 和 Markdown 正文。规范要求 `name`、`description`，另有 `license`、`compatibility`、`metadata` 等可选字段，`allowed-tools` 则仍是实验性字段。

规范倡导渐进披露：

| 层次 | 内容 | 作用 |
|---|---|---|
| 目录元数据 | 名称、描述等 | 让模型知道有什么、何时使用 |
| Skill 指令 | `SKILL.md` 的详细内容 | 被选用后提供过程知识 |
| 附属资源 | 引用文件、脚本、模板等 | 执行过程中按需读取或运行 |

需要避免四个误解：

- **渐进披露主要是模型上下文策略。** 不等于发现阶段绝不读取正文；Gemini CLI 会先读取并缓存文件内容，再延迟把正文交给模型。
- **推荐长度不是通用硬限制。** 规范的正文长度建议，不等于每个运行时都用同一个字数或 Token 上限拒绝加载。
- **标准兼容不等于所有扩展字段兼容。** `context: fork`、`paths`、厂商专用 `metadata` 和工具权限语义需要逐产品确认。
- **带脚本不等于自动执行。** 普通资源访问仍走 Agent 工具；Claude 的动态命令预处理、OpenClaw 的工具直派属于额外机制。

## 4. 机制对照

| 产品 | 发现与作用域 | 选用与正文加载 | 权限或生命周期的关键差异 |
|---|---|---|---|
| Claude Code | 个人、项目、嵌套项目、托管配置和插件 | 模型按描述选用；用户 `/name`；支持正文参数替换 | `allowed-tools`、禁用工具、动态命令、显式 fork；正文可保留在对话中 |
| Codex | 项目祖先链的 `.agents/skills`、个人、管理员、内置等来源 | `/skills`、`$name` 或隐式选用；显式选择可以由宿主读取并注入 | 路径消歧、隐式调用开关、目录预算、执行环境和权限边界 |
| Copilot | 依 IDE、CLI、云端和所选 Agent 后端而异 | 官方文档描述目录 → 正文 → 资源；支持手动和自动使用 | 不能把 CLI 工具预批准或 VS Code feature-gated 能力泛化到所有终端 |
| Gemini CLI | 内置、扩展、个人、工作区；工作区受信任状态控制 | 模型调用 `activate_skill({name})`；返回正文与目录结构 | 走工具确认策略，激活后增加资源目录访问范围；Session 内记录 active 状态 |
| Cursor | 原生和兼容目录；嵌套项目与路径匹配 | 根据描述和适用路径选用，也可 `/name` | 本地作用域、个人同步和云端执行环境需要分别考虑 |
| OpenCode V2 | 原生、兼容、配置目录、插件及远程来源 | 目录提供 ID、名称、描述；`skill({id})` 加载正文；用户可 `@skill-id` | Skill 级 allow / ask / deny；目录可产生 added / changed / removed 更新 |
| OpenClaw | 工作区、个人库、托管、内置和插件等多来源 | 目录、显式引用和读取工具；有工具直派扩展 | 环境依赖筛选、Agent 可见性、版本快照和宿主 / 沙箱分离 |

这张表比较的是机制，不是“谁功能最多”。同名能力在不同产品里可能对应不同权限和状态边界。

## 5. 各产品的实现细节

### 5.1 Claude Code：指令包基础上叠加工作流能力

依据：[官方文档][claude]。

**发现与加载**

- 原生位置包括个人 `~/.claude/skills`、项目 `.claude/skills`，以及托管来源、插件和附加目录。
- 支持嵌套项目发现与插件命名空间，不能简单理解为启动时只扫描一次仓库根目录。
- 通常先暴露描述，相关任务再选用；用户也可以显式 `/skill-name`。
- 当前文档允许缺省 frontmatter 字段，例如名称取目录名、描述取正文的首个非空行。这比标准格式的必填规则宽松，不能反推标准本身也不要求这些字段。

**调用策略**

- `disable-model-invocation: true` 用于禁止模型自主调用，描述不进入自动调用上下文；当前文档也限制其被预加载到 Subagent。
- `user-invocable: false` 用于隐藏用户调用入口，但保留模型使用路径。
- 参数和正文替换是调用时渲染；动态命令语法可以在正文交给模型前执行命令并插入结果。命令仍有自身的权限检查和失败行为，不能视为无条件执行。

**权限与 Subagent**

- `allowed-tools` 是调用期间的工具预批准，**不是只允许这些工具的白名单**；另有 `disallowed-tools` 表达禁用。文档说明这些临时变更在下一条用户消息时清除。
- 不应把 workspace trust 当作所有项目 Skill 权限行为的统一前置门槛；具体要按该产品文档和权限模式理解。
- `context: fork` 才会启动专门的 Subagent。当前文档明确：该 Subagent 得到 Skill 作为任务提示，但不继承主对话历史；这不同于复制当前对话的 fork。
- Subagent 自身也可声明预加载 Skills，但这是另一条配置路径，不代表主 Agent 已加载内容会自动全部继承。

**生命周期**

- 已调用的正文以会话消息形式保留；重复调用相同渲染内容可能只提示已加载，压缩时另有恢复与预算规则。
- 已存在目录的文件变化可以被监视；首次新增原本不存在的发现根目录等情况可能需要 `/reload-skills`。插件重载也有独立命令。

**值得借鉴：** 清楚区分“用户可调用”和“模型可自主调用”。不宜作为第一版基线：动态 shell、模型覆盖、hooks 和 fork 全量组合。

### 5.2 Codex：显式宿主注入与隐式模型选用并存

依据：[官方文档][codex]、[选择逻辑][codex-selection]、[正文注入][codex-host-prompt]、[上下文片段][codex-fragments]。

**发现与身份**

- 官方文档列出从当前工作目录到仓库根的祖先目录中的 `.agents/skills`，以及个人 `~/.agents/skills`、管理员目录和系统内置 Skills。
- 当前文档明确同名 Skill 不自动合并。源码同时保留逻辑路径、规范路径等身份信息，而不只用名称当唯一键。
- 显式结构化 Skill 输入优先按路径解析；文本 `$name` 需要消歧，并考虑与连接器名称冲突。不能实现成全局字符串替换。

**正文如何到达模型**

所核对的 Host 路径是：

```text
选择 Skill → HostSkillsSnapshot.load_skill_prompts
          → read_skill_text → SkillInstructions 上下文片段
```

源码里目录片段使用 `developer` 角色，已选择 Skill 的详细指令片段使用 `user` 角色，并携带名称和路径。这是该源码路径的事实，不是所有产品的通用消息角色约定。读取失败会产生警告；部分插件来源还有正文预算处理。

模型隐式选用与后续文件 / 脚本访问则另有识别路径。[invocation 源码][codex-invocation] 能识别读取 `SKILL.md` 或运行相关脚本的调用，**这属于调用识别，不能据此推断发现或激活时自动执行脚本**。

**元数据、预算与更新**

- `agents/openai.yaml` 承载 UI 信息、工具依赖和调用策略；`policy.allow_implicit_invocation: false` 禁止隐式选用，但保留显式调用。
- `[[skills.config]]` 可以按路径或名称禁用 Skill，不应只从磁盘是否存在推导是否可用。
- [目录渲染源码][codex-render] 有预算、缩减描述和省略条目的处理；“没有预加载所有正文”不代表目录没有上下文成本。
- [解析源码][codex-parser] 具有字段处理与一定容错，不是直接把标准文档的全部规则照搬为运行时严格拒绝条件。
- 官方文档说明文件变化可自动检测，但配置或异常情况下仍可能需要重启；不要把所有修改都归纳成同一个即时刷新保证。

**值得借鉴：** 路径身份、明确的加载结果与警告、目录预算。多执行环境和扩展体系不是最小实现的必需品。

### 5.3 GitHub Copilot：先分终端，再分运行后端

依据：[概念文档][copilot]、[VS Code 文档][vscode-docs]、[CLI 文档][copilot-cli]、[Skill resolver 源码][vscode-resolver]、[补全源码][vscode-completion]。

**不能只说“Copilot 支持某目录”**

- 官方资料涉及 IDE、CLI、云端等多个表面；个人本地文件不会因为目录格式相同就自动出现在云端。
- VS Code 当前文档又区分 Copilot、Claude、Codex 等 Agent 后端。原生目录包括 `.github/skills`、`.claude/skills`、`.agents/skills`；兼容转发、个人目录和配置范围依后端而异。
- 因此，目录发现和命令补全属于编辑器集成的一部分，正文怎样进入模型还要看运行后端。

**加载与入口**

- 文档明确三层：先发现名称和描述，相关时加载正文，引用时才读取附属资源。
- 支持模型自主使用，也支持 `/skill-name`；当前 VS Code 文档提供用户调用和模型调用开关。
- 公开 resolver 按后端聚合 Skill 清单，并区分可用、不可用、禁用等状态。补全则基于当前会话有效定制项过滤，并处理插件命名空间等问题。

**权限与扩展边界**

- Copilot CLI 文档描述 `allowed-tools` 预批准 shell 等工具；这是 CLI 的具体语义，不直接推导 IDE 或云端具有同样行为。
- VS Code 支持扩展贡献 Skills；当前文档还涉及插件和 MCP Skills，后者有独立开关与同意流程，不能把“信任 MCP server”等同于“同意加载其全部 Skills”。
- `context: fork` 在所核对 VS Code 文档中带 feature 标记，并要求启用相应 Skill Tool 设置；不作为所有终端、后端和稳定版本的普遍保证。

**值得借鉴：** 将“来源、有效作用域、可用状态”和“实际执行后端”分开建模。不能把编辑器里的统一入口误认为底层只有一套实现。

### 5.4 Gemini CLI：明确的激活 Tool 和 Session 状态

依据：[官方文档][gemini-docs]、[loader][gemini-loader]、[manager][gemini-manager]、[activate-skill][gemini-activate]。

**发现**

- 优先级从低到高是内置、扩展、个人、工作区；同层 `.agents/skills` 别名优先于 `.gemini/skills`。
- 管理器只在工作区可信时加载工作区 Skills；重名覆盖有告警。
- loader 支持根目录的 `SKILL.md` 或下一层目录的 `SKILL.md`，不是任意深度递归。
- 发现时已读取并缓存正文；延迟的是向模型披露完整正文，不是绝对延迟磁盘读取。

**激活链路**

```text
目录中的名称和描述
  → 模型调用 activate_skill({name})
  → 工具确认策略
  → manager 记录 active
  → 增加 Skill 目录访问范围
  → 返回正文和目录结构
```

确认接入正常工具策略；当前代码对内置 Skill 有特殊处理，因此不能说每次激活必然弹出同一个确认框。

目录访问扩展不等于授予任意 shell 权限，也不代表自动安装或执行脚本。后续脚本运行仍要经过相应工具。

**生命周期**

- active 名称是 Session 状态，可以重置。
- 提供列表、启用、禁用、重载和安装等管理入口；个人与工作区配置有作用域区分。

**值得借鉴：** 最容易看清“选择、确认、加载、活动状态”各自归属。但若自身产品不需要单独确认或 active 状态，也不必机械复制。

### 5.5 Cursor：发现范围、路径匹配与编辑器体验

依据：[官方文档][cursor]。

- 支持 `.agents/skills`、`.cursor/skills` 及相应个人目录，另有 `.claude/skills`、`.codex/skills` 等兼容位置。
- 可以按分类子目录组织 Skills；分类目录不等于 Skill 的身份名称。
- 嵌套项目 Skills 有子树作用域，`paths` 还可进一步表达适用文件范围。
- 模型按描述和适用性选用，用户可以 `/name`；`disable-model-invocation` 控制自动使用。
- 资源和脚本经现有 Agent 工具访问。此次没有证据支持把 Claude 的工具预批准或 fork 语义直接套到 Cursor。
- 个人 Skills 的云同步是独立的可选机制；不能从本地目录支持推断云 Agent 或 Automation 必然拿到相同文件。

**值得借鉴：** 工作目录 / 文件范围可以影响目录可见性，不必让所有项目技能永久占据所有任务的上下文。路径自动匹配属于产品扩展，不是基础标准要求。

### 5.6 OpenCode V2：目录广告、权限和加载分离

依据：[当前文档][opencode-docs]、[发现实现][opencode-discovery]、[Skill Tool][opencode-tool]、[目录提示][opencode-instructions]、[正文输出][opencode-skill]。

**版本提醒：本节不是旧版 `skill({name})` 的复述。**

- 来源包括 `.opencode/skills`、个人配置目录、`.claude/skills` / `.agents/skills` 兼容来源，以及配置的本地目录、远程目录和插件。
- 当前实现接受 `<id>/SKILL.md`，也接受平铺 Markdown Skill 文件；frontmatter 可选。
- **ID 来自路径，YAML `name` 是显示名称。** 这与把标准 `name` 同时当唯一标识的实现不同。
- 描述决定是否进入自动使用目录；没有描述不等于不能被显式注册或加载。
- `metadata["opencode/autoinvoke"]: false` 或 `disable-model-invocation: true` 可隐藏自动目录，仍保留显式加载；两者同时存在时前者优先。
- 同 ID 后注册的来源覆盖前者；不能泛化成所有 Agent 都采用“同名用户目录覆盖项目目录”。

**加载与权限链路**

```text
available_skills 目录
  → skill({id})
  → 查找定义
  → permission.assert(action: skill, resources: [id])
  → 返回正文、base directory 和抽样资源列表
```

Skill 权限支持 allow / ask / deny；deny 不仅阻止加载，也从可用目录过滤。工具返回正文和最多十个资源路径样本，不等于读取了整个资源目录的全部内容。

用户还可以显式 `@skill-id`。目录提示实现比较前后清单，生成 added / changed / removed 更新；这证明存在上下文目录更新机制，但不单凭此推断所有来源都有相同文件监视时机。

**值得借鉴：** 将“可发现、可自动选用、可显式加载、获准加载”分开。V2 自有身份与扩展语义不宜作为跨产品标准直接采用。

### 5.7 OpenClaw：个人 Agent 的环境与多 Session 问题

依据：[官方文档][openclaw]，仅作补充。

- 除工作区、个人、内置和插件来源，还涉及托管库与具体修订。来源优先级与 Agent 可见性不是同一件事。
- `metadata.openclaw` 可以声明平台、二进制、环境变量和配置依赖；依赖就绪不等于授予工具权限。
- 宿主检测到二进制存在，不代表沙箱容器也装了它；宿主侧环境注入也不自动进入容器。
- 目录有预算，正文读取还可通过专门的搜索 / 读取工具完成；不能只把目录截断后假定未展示的 Skill 永远不存在。
- 普通文件来源有发现、发布快照和后续 Turn 接收更新的机制；托管库的已选修订则可以保持固定，直到显式 attach / refresh。不能把两者归纳为“一改文件，所有进行中的调用立即改变”。
- `command-dispatch: tool` 可以把 slash 命令直接路由到已注册工具，绕过模型。这是厂商扩展，并不是普通 Skill 天生具有的执行能力。

**值得借鉴：** 清楚定义 Skill 的可见性、环境就绪性和修订生命周期。多来源托管库、环境注入、安装器与沙箱同步明显超出基础 Skills 支持范围。

## 6. 哪些东西不能当成统一协议

| 表面相似的配置或行为 | 实际差异 |
|---|---|
| `name` | 标准中的必填名称；部分运行时可缺省；OpenCode V2 另有路径 ID |
| `allowed-tools` | 标准中为实验字段；Claude / Copilot CLI 有各自预批准语义，不能泛化为跨产品白名单 |
| 禁止模型调用 | Claude、Cursor、VS Code、Codex、OpenCode 的字段位置及目录处理并不完全相同 |
| `/name`、`$name`、`@id` | UI 和运行时协议不同；不是标准规定的统一指令语法 |
| `context: fork` | 是厂商执行扩展；不是每次加载 Skill 都新建 Subagent |
| `.agents/skills` | 多家采用的目录约定，但祖先遍历、优先级和作用域仍不同 |
| “支持自动加载” | 可以是模型选用、宿主选择注入、读文件，或专门激活 Tool；不是同一实现 |
| “支持热更新” | 文件变化、配置变化、新根目录、会话快照与当前已注入正文有不同边界 |
| “支持脚本” | 多数指可以经普通工具执行资源脚本，不等于激活即执行或绕过审批 |

尤其不能根据 Skills 目录格式相同，就承诺一个包在所有产品里有相同权限、Subagent 行为、执行位置和生命周期。

## 7. 对后续设计讨论的有限建议

以下是研究推论，不是对 my-agent 当前实现的结论，也不是交付范围。

### 值得优先考虑

1. **先做指令与资源包。** 以标准 `SKILL.md` 为基础，使用目录元数据和按需正文，不先引入新的执行引擎。
2. **明确一个加载路径。** 模型专用 Tool 或宿主显式注入都已有成熟先例；先按现有运行时选择一种，不为“兼容所有产品”同时建多套路径。
3. **复用既有权限。** 读取和脚本执行继续走正常工具边界；解析到扩展字段不代表已安全实现其权限语义。
4. **定义身份和上下文边界。** 同名如何消歧、加载失败怎样显式呈现、重复加载如何处理，以及正文何时对当前 Agent 生效，应有清晰规则。
5. **对主 Agent / Subagent 使用同一机制。** 同一发现和加载规则可以按执行工作区与权限计算不同可见集合；不等于强行共享全部主会话内容。

### 可部分采纳，但需要实际需求

- 用户显式调用与模型自主调用的独立开关。
- 简单、确定的项目 / 个人来源优先级和禁用入口。
- 上下文预算、较大的目录搜索、刷新与快照策略。
- 编辑器补全、路径作用域、已加载状态展示。

### 不宜作为基础支持一起引入

- Skill 专属模型、hooks、动态 shell 插值和独立 Subagent 执行。
- MCP 远程分发、依赖自动安装、Marketplace 和云同步。
- 环境变量注入、沙箱复制和跨宿主库版本管理。
- 在没有检索瓶颈证据时，预先加入向量库或复杂自动路由器。

**合理的第一步是形成最小语义闭环，而不是复刻功能最多的产品。** 本次研究到文档为止；若进入实现，仍需结合现有源码和规格确认边界。

## 8. 资料索引

### 标准与官方文档

- [Agent Skills Specification][spec]
- [Claude Code: Extend Claude with skills][claude]
- [OpenAI Codex Skills][codex]：原入口在本次访问时重定向至 [Build skills][codex-redirect]。
- [GitHub Copilot: About agent skills][copilot]
- [GitHub Copilot CLI: Add agent skills][copilot-cli]
- [VS Code: Agent Skills 文档源码][vscode-docs]
- [Gemini CLI: Agent Skills][gemini-docs]
- [Cursor: Agent Skills][cursor]
- [OpenCode: Agent Skills][opencode-docs]
- [OpenClaw: Skills][openclaw]

### 固定版本源码

- Codex：[解析][codex-parser]、[显式选择][codex-selection]、[调用识别][codex-invocation]、[Host 正文注入][codex-host-prompt]、[消息片段][codex-fragments]、[目录渲染与预算][codex-render]。
- Gemini CLI：[发现与解析][gemini-loader]、[管理与作用域][gemini-manager]、[激活 Tool][gemini-activate]。
- OpenCode：[文件来源注册][opencode-discovery]、[Skill Tool 与权限][opencode-tool]、[目录上下文更新][opencode-instructions]、[正文和资源输出][opencode-skill]。
- VS Code：[按后端解析可用 Skills][vscode-resolver]、[当前会话命令补全][vscode-completion]。

[spec]: https://agentskills.io/specification
[claude]: https://code.claude.com/docs/en/skills
[codex]: https://developers.openai.com/codex/skills
[codex-redirect]: https://learn.chatgpt.com/docs/build-skills
[copilot]: https://docs.github.com/en/copilot/concepts/customizations/agent-skills
[copilot-cli]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
[vscode-docs]: https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agent-customization/agent-skills.md
[gemini-docs]: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/skills.md
[cursor]: https://cursor.com/docs/skills
[opencode-docs]: https://opencode.ai/docs/skills/
[openclaw]: https://docs.openclaw.ai/tools/skills
[codex-parser]: https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/skills/src/parser.rs
[codex-selection]: https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/skills/src/selection.rs
[codex-invocation]: https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/skills/src/invocation.rs
[codex-host-prompt]: https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/ext/skills/src/host_prompt.rs
[codex-fragments]: https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/ext/skills/src/fragments.rs
[codex-render]: https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/ext/skills/src/render.rs
[gemini-loader]: https://github.com/google-gemini/gemini-cli/blob/aeb6c04b093eb00c33585ba587c4889ae4c5e957/packages/core/src/skills/skillLoader.ts
[gemini-manager]: https://github.com/google-gemini/gemini-cli/blob/aeb6c04b093eb00c33585ba587c4889ae4c5e957/packages/core/src/skills/skillManager.ts
[gemini-activate]: https://github.com/google-gemini/gemini-cli/blob/aeb6c04b093eb00c33585ba587c4889ae4c5e957/packages/core/src/tools/activate-skill.ts
[opencode-discovery]: https://github.com/anomalyco/opencode/blob/101776024cc69bafb3f9dc90027ab4d1eab40a2a/packages/core/src/config/plugin/skill-file.ts
[opencode-tool]: https://github.com/anomalyco/opencode/blob/101776024cc69bafb3f9dc90027ab4d1eab40a2a/packages/core/src/tool/plugin/skill.ts
[opencode-instructions]: https://github.com/anomalyco/opencode/blob/101776024cc69bafb3f9dc90027ab4d1eab40a2a/packages/core/src/skill/instructions.ts
[opencode-skill]: https://github.com/anomalyco/opencode/blob/101776024cc69bafb3f9dc90027ab4d1eab40a2a/packages/core/src/skill.ts
[vscode-resolver]: https://github.com/microsoft/vscode/blob/52073a464821e207fc0510f2b6ccdba47f706aad/src/vs/workbench/contrib/chat/common/promptSyntax/languageProviders/promptSkillResolver.ts
[vscode-completion]: https://github.com/microsoft/vscode/blob/52073a464821e207fc0510f2b6ccdba47f706aad/src/vs/platform/agentHost/node/agentHostSkillCompletionProvider.ts
