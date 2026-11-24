# 本地个人 Agent 的工具后果风险评估、Smart Approval 与跨平台 Sandbox 调研

> Status: Non-authoritative research & exploratory analysis
> Date: 2026-11-23
> Revision: 从通用安全护栏分类转向工具效果与后果风险评估
> Scope: 本地轻量分析模型、工具智能审批与 Windows / macOS / Linux 隔离后端；不授权实现，不改变当前权限、Approval 或执行契约。

---

## 1. 核心结论与问题定义

本项目需要回答的不是“Agent 是否恶意”“是否受到 Prompt 攻击”或“调用是否符合用户意图”，而是：

> 这个具体调用在当前执行环境下，可能造成什么损害？影响多大？能否恢复？哪些后果无法确定？现有约束能实际限制哪些损害？

工具调用中的大量步骤由 Agent 自主选择，用户目标并不逐一指定这些步骤。善意调用同样可能因错误路径、参数、脚本副作用造成损害；符合任务目标不构成安全证明。恶意意图识别和任务相关性不是本调研的核心，也不得作为降低后果检查标准的理由。

建议分离三个职责：

1. **Tool Effect / Risk Assessment**：识别可能效果、损害范围、可恢复性和不确定性。
2. **Approval Policy**：根据可信配置、资源授权与可接受损害范围，决定 `allow / requires_approval / deny`。
3. **Sandbox Enforcement**：在执行时强制限制文件、网络、进程和资源访问，约束误判后的损害半径。

轻量模型是效果分析的辅助组件，不是安全边界；审批表达是否允许执行，不是对“绝对安全”的承诺。

### 1.1 项目现状：已有审批，没有 OS 级隔离

依据 [Tool Contract and Policy](../architecture/tools.md)、[Builtin Tools](../architecture/builtin-tools.md)、[Approval Lifecycle](../specifications/approval-lifecycle.md) 及 `src/runtime/policy/tool-approval-policy.ts`：

- `manual` 模式下所有 `exec` 调用都要求当前调用 Approval，缺少审批能力时拒绝。
- `allow_all` 自动授权非 `tools.deny` 的调用；工具名 deny 在两种模式中均为最终限制。
- 策略不推断命令效果；外部结构化路径按 `resolve/relative` 做词法分类，不规范化符号链接。
- Agent Home 是相对路径锚点，不是硬文件边界；`cwd` 是执行上下文，不是 confinement。
- Windows 使用 `cmd.exe /d /s /c`，Unix 使用 `/bin/sh -c`；不是 PowerShell/Bash 统一语义。
- Exec 的调用级 `env` 合并到宿主 `process.env`，存在将宿主敏感环境传入子进程的风险。
- 已有超时、取消及进程树清理机制：Windows 尝试 `taskkill`，Unix 使用进程组；这些是生命周期管理，不是文件或网络隔离。
- 维护者主要使用 Windows，目标用户覆盖 Windows、macOS、Linux。

以上是调研时的实现观察，不替代权威文档。未来若新增资源授权、保护策略或异步分析，需正式设计及验证，不能把研究建议描述成现成功能。

### 1.2 为什么需要 Smart Approval

全量人工确认易产生审批疲劳；对每次调用额外使用重型 LLM 又会增加延迟、资源消耗和输出处理复杂度。

目标是在可验证的风险边界内减少重复确认，而不是让模型凭高分自动放行任意命令。宁可保留无法分析调用的人工确认，也不把“不知道危险在哪里”当成“已经安全”。

---

## 2. 术语、三态与 Prompt 机制

### 2.1 如何称呼这类模型

| 名称 | 含义与边界 |
|---|---|
| 二分类器 / 多分类器 | 输出固定类别，例如 true/false；输出形式不决定安全能力 |
| 判别式模型 | 建模标签或分数，不要求生成自由文本；与生成式路线区分 |
| Zero-shot Classifier | 运行时给标签或问题，无需每个任务重新训练；不保证代码理解能力 |
| Typed Decision Model / Decision Model | 强调有限选项与结构化结果；不是唯一统一行业术语 |
| System One Model | TypeSafe 对 Jev 的类别名称，强调快速集中判断 |
| NLI | 输入前提与假设，输出 entailment/contradiction/neutral；neutral 表示证据关系，不等同于危险或模型低置信度 |
| Selective Prediction / Classification with Abstention | 信息不足、低置信度等情况下弃权；可形成 true/false/undefined |
| Guardrail / Safety Classifier | 按用途命名；很多模型审核内容或检测注入，而非分析工具后果 |

`undefined` 建议定义为“无法充分判定所问效果”，而不是“没有恶意”，也不是 Qwen3Guard 的 `controversial` 的直接同义词。

### 2.2 是否通过 Prompt 判断

- **固定分类头**：输入实际调用及环境特征，类别与判断标准主要学习在权重中，不需要自由自然语言指令。
- **指令/标签条件化分类器**：输入 State、instructions、候选标签，直接打分；有广义 Prompt，但没有自由文本生成。
- **小型生成式 Guard**：用模板输入并生成短标签；也可训练专用分类头或读取有限候选得分。

“不生成文本”不意味着不受输入诱导、不会误判或概率天然可靠。固定分类头也可能受对抗输入影响。

对于 Jev，可确认的是 API 接收自然语言问题及结构化选项，返回类型化决策而非解释文本；闭源情况下不能断言内部具体编码器、分类头或一次前向实现方式。

---

## 3. 模型与技术路线：候选，不是命令安全保证

### 3.1 Jev：接口与设计理念参考

TypeSafe 将 Jev 定位为 System One 模型，输入 state 和独立的类型化问题：

- `Noul`：返回 0–1 的真值概率。
- `Choice`：有限选项、概率分布与 confidence。
- `Score`：有序量表、分布及评分。
- 图像 Box 原语与本项目命令审批无直接关系。

可直接定义三选项，或对二元结果设置弃权区间。每个问题独立评估，逻辑组合由应用代码完成；复杂、多步后果追踪不应压成一句“安全吗”。

官方宣传 RLCD（Reinforcement Learning for Calibrated Decisions）、低延迟和低成本。概率校准是数据集层面的性质，不保证单次正确；“不生成文字”避免自由文本格式问题，不等于零事实错误或零误放行。

权重未公开，公开文档主要提供云 API。本地部署/VPC 是否可用及条件需与厂商确认，不能默认企业可以自托管。云调用可能暴露命令、路径和上下文；本项目优先本地方案。

### 3.2 候选分类与适配边界

| 候选 | 可借鉴之处 | 对 command 后果评估的限制 |
|---|---|---|
| GLiClass v4 Edge | 模型卡标注约 0.4B、Apache-2.0、非生成式、可动态传指令和标签；附 Jev-style API 示例 | 通用决策基线；尚无本项目 Bash/cmd/PowerShell、资源后果和对抗测试证据，不作为直接放行依据 |
| GLiClass 多语言版本 | 中文上下文的候选基线 | 需分别检查实际语言、代码能力、长度限制与部署支持 |
| Qwen3Guard-Gen-0.6B | 小型、多语言、Apache-2.0；已有 safe/controversial/unsafe 内容审核标签 | 内容安全不等于命令效果；controversial 不等于信息不足。仅作为对比或迁移学习候选 |
| Llama Prompt Guard 2 等 | 外部输入的注入检测辅助 | 不评估文件损害、进程权限或数据外泄；具体版本类别和许可需逐版核对 |
| Granite Guardian / ShieldGemma | 内容、对话或其他专门风险基线 | 各版任务、大小、许可不同；不是开箱即用的跨平台命令后果裁判 |
| 小型代码模型＋效果分类头 | 可研究 Qwen2.5-Coder-0.5B、Qwen3-0.6B 等底座的定向训练 | 编码能力不代表能证明任意程序效果；模型、训练成本和许可需实测核对 |
| 小型 Encoder / 特征分类器 | DeBERTa、MiniLM 等加多标签头，或逻辑回归/LightGBM 融合可信特征 | 适合明确且有限的效果识别；需要领域训练和未知分布测试 |

SCX Router 的 decoder-KV 分类设计可作为上下文复用参考，但其模型选择评测不证明命令风险能力；缓存还必须绑定策略、环境和输入版本。

**方向调整：**不再推荐“换一个内容安全 Guard 就能直接审命令”。先建立后果标签与评测，再比较规则、特征分类器、通用零样本模型和定向训练模型。

### 3.3 本地集成与性能验证

`package.json` 有 `@xenova/transformers ^2.17.0`；`onnx-proto` 出现在 overrides 中，不应称为直接运行依赖。已有 Transformers.js 不保证任意 GLiClass/Qwen/自定义 ONNX 图能直接执行。

候选部署方式：

- 明确受支持的 ONNX 模型在 Node worker 或独立本地进程运行。
- 自定义推理图使用 ONNX Runtime binding 或本地 sidecar。
- 小型 Decoder 可探索 llama.cpp 等，但需验证具体架构、转换和分类头支持。

需测：冷启动、常驻内存、CPU/GPU、输入长度、P50/P95 延迟、并发、量化后质量和校准。厂商模型卡的 11ms 等数字仅为原测试条件下声明，不能承诺用户机器上毫秒级表现。不要在主事件循环做长时间阻塞推理；模型超时、崩溃、截断或无法加载不应导致放行。

---

## 4. 后果风险评估：输入、输出与不确定性

### 4.1 风险维度

1. **效果**：读、写、覆盖、删除、执行代码、改变权限、持久化配置、联网发送、资源消耗。
2. **对象**：临时产物、源码、用户文档、凭证、系统文件、服务或外部账号。
3. **范围**：单文件、目录、整个项目、用户目录、宿主、外部系统。
4. **可恢复性**：可重建、可验证回滚、有备份、未知、不可逆；外泄通常无法撤回。
5. **不确定性**：动态路径、脚本、环境、编码、未解析语法、未知可执行文件等。
6. **执行约束**：实际可读/可写集合、网络出口、权限、资源限额、工作副本。

读操作可能泄露秘密，写在工作区也可能损坏重要数据。Git 存在不等于所有文件可恢复；未提交内容、未跟踪文件、数据库和外部副作用不一定能回滚。

### 4.2 State 必须由可信组件构造

只传 `bash`、`cmd` 或 `exec` 没有意义。需要原始调用与实际环境，不要求用户意图来授权自主步骤。

建议结构（探索示例，不是当前接口）：

```json
{
  "tool": "exec",
  "platform": "win32",
  "shell": "cmd.exe",
  "command_raw": "npm test",
  "cwd": "C:/work/project",
  "executable": {"resolved_path": "C:/tools/node/npm.cmd", "verified": false},
  "analysis": {
    "possible_effects": ["execute_project_code"],
    "target_paths": [],
    "unresolved_parts": ["test script and transitive dependencies"],
    "network_effect": "unknown"
  },
  "resources": {"backup_verified": false, "disposable_copy": false},
  "execution_constraints": {
    "backend": "host-direct",
    "filesystem_confinement": false,
    "network_confinement": false
  }
}
```

未知字段显式用 `unknown`、未验证标记或缺失原因，不能默认 `false`。未检测到网络命令不意味着没有网络效果。

- 保留完整原始命令，可信解析结果与不可信文本分字段存储。
- 记录实际 shell、cwd、环境白名单、解析后的执行文件与目标资源。
- 授权和隔离能力来自 Runtime/执行器，不接受 Agent 自称“已备份”“已隔离”“用户允许”。
- 用户目标可用于任务相关性分析，但不能降低风险；Agent 理由仅是不可信说明。
- 不必要的外部原文不入评估输入；必要的不可信内容必须标明来源。分隔符不能保证抗注入。
- 超长命令或脚本不能静默截断后给安全结论。

### 4.3 分析命令不能只靠命令名

- Bash/POSIX、cmd、PowerShell 需要各自的语法处理，不能混用。
- `shlex` 是词法切分器，不是完整 Shell AST/效果分析器。
- 可研究 tree-sitter、PowerShell 官方解析能力等；解析成功不代表全部副作用可知。
- 管道、重定向、命令替换、`find -exec`、动态脚本、别名及 PATH 劫持需要逐层检查。管道或 base64 本身不是恶意或有害证明，但可能增加效果不确定性。
- `npm test`、`vitest`、`cargo check`、`python -c` 等可以执行代码，不能列为天然只读安全白名单。
- `git diff` 等也需核实配置、外部 helper、参数与实际执行环境。
- 有条件时优先结构化工具和已解析的 executable/argv，减少 Shell 字符串；已有 exec 接口的变更仍需正式设计。

任意程序完整效果预测一般不可得。复杂调用需要保守结果、约束执行或人工确认，而不是模型兜底证明。

### 4.4 输出效果证据，再作审批

建议分析结果包括：

```json
{
  "possible_effects": ["overwrite_files", "execute_project_code"],
  "affected_scope": "workspace",
  "reversibility": "unknown",
  "uncertainty": "high",
  "evidence_source": "static-analysis-and-model",
  "unresolved_parts": ["runtime-generated paths"]
}
```

可对原子效果输出 true/false/undefined 或概率；模型分数必须标明其含义。softmax 分数不是已经验证的损害发生概率，多标签效果也可能同时成立。

---

## 5. Smart Approval 策略与项目接入

### 5.1 建议流程

```text
Hook 变换后的有效 Tool input
  → Schema 验证
  → 可信环境/资源事实与效果预分析
  → 必要时轻量模型提供候选效果和不确定性
  → 策略根据损害范围、恢复条件、授权及可执行约束裁决
  → allow / requires_approval / deny
  → 执行器落实约束，执行前再次检查关键事实
```

- **allow**：已足够明确的效果在预设可接受范围内；不是单凭模型 P(safe) 高。
- **requires_approval**：损害可能较大、缺少授权或关键事实无法确定；人工确认也不意味着操作安全。
- **deny**：违反明确不可覆盖的限制，或无法满足执行必须具备的约束。

当前 `manual/allow_all` 契约不变：研究不能直接加入一个悄悄覆盖 `allow_all` 的模型审批。新增独立、不可绕过的执行约束或新模式需要正式决策；UI 必须区分审批自动化与隔离强度。

阈值只是需要领域标定的实验参数，不采用未经验证的 0.9/0.85 作为安全承诺。高风险低置信不能被平均得分掩盖；规则 deny 不被模型覆盖。

### 5.2 现有生命周期不能被绕过

按 [Tool Contract and Policy](../architecture/tools.md) 和 [Approval Lifecycle](../specifications/approval-lifecycle.md)：

- 分析有效的、Hook 变换后的输入，审批和执行绑定同一调用及参数。
- 复用现有 `TurnInteractionManager`，不创建平行 Approval registry。
- 保留 Session/Turn/callId、Origin 路由、first-settlement-wins、Abort、Shutdown 语义。
- 自动策略放行不能伪装成用户审阅；模型分析失败不得伪装为用户拒绝。
- 分析时策略或环境变化，需要失效/重检；检查到执行之间仍存在 TOCTOU。
- 后台/yield 进程交接、取消与清理必须继续遵循现有 Framework/Process 生命周期。

接入位置是候选：Runtime policy 组合分析能力，Builtins 的执行器落实 OS 约束；纯契约不能依赖具体模型 SDK 或 Win32 实现。当前同步 `decide()` 若要接异步推理，需另行设计，不应直接塞阻塞推理进去。

### 5.3 示例：同样命令，不同后果

| 调用与环境 | 判断重点 |
|---|---|
| 删除已核实可重建的临时目录 | 目标精确性、未混入用户数据、删除范围 |
| 覆盖未备份文档 | 信息损失与不可恢复性，不考虑 Agent 的善意解释 |
| 上传项目日志 | 内容敏感性、收件方与外泄，不以任务相关性放行 |
| 在宿主运行未知仓库 npm test | 任意代码、网络、宿主权限及持久化效果未知 |
| 在无网络的可丢弃工作副本运行同一测试 | 宿主风险降低，仍限制 CPU、内存、磁盘及可见数据 |

---

## 6. 自行训练、校准与验证

### 6.1 训练目标

优先效果多标签和风险维度，不将“用户是否点击允许”直接当作安全标签。分别保存：

1. 可能效果及损害标签；
2. 用户授权/接受风险的决定；
3. 实际执行观察与恢复结果。

这次执行未出事故不证明所有环境安全；经常批准的测试命令也不能自动学成无害。

可从明确工具和常见命令的有限任务开始，比较规则基线、特征模型、小 Encoder、代码底座及通用零样本模型。合成数据可扩展覆盖，但强模型标注不是事实，需要人工/可信静态分析/受控实验核验，禁止在宿主直接执行危险样本。

### 6.2 数据覆盖

覆盖 Windows cmd、PowerShell、POSIX Shell，文件与网络工具、多种环境和资源状态：删除/覆盖、凭证读取与发送、脚本执行、配置持久化、权限变化、资源耗尽、越界路径、软链/junction、动态命令及编码。

使用反事实样本：相同命令、不同 cwd/备份/隔离条件；相同“善意理由”、不同损害。测试集按仓库、脚本模板和命令族隔离，防止近重复泄漏。

### 6.3 评测与发布门槛

- 最重要指标是有害调用误放行率，按损害严重度和工具族分别报告。
- 同时报告自动处理覆盖率、弃权率、误阻断、校准、延迟与内存。
- 温度缩放等校准方法仅在相应分布上有效，量化/模型更新后重测。
- 检查未知分布、输入诱导、长命令、工具配置变化以及环境竞态。
- 先 shadow mode，只记录不改现有审批，再有限灰度；不保证数据数量达到几百/几千就能充分安全。
- 本地日志征得同意、脱敏、可删除；不记录明文密钥和多余文件内容。模型、策略、分析器版本可追溯。

---

## 7. 跨平台 Sandbox：限制后果，不预测意图

### 7.1 威胁与覆盖边界

未来隔离应覆盖被执行脚本及其子进程的越界文件读写、秘密访问、数据外发、资源耗尽与持久化。不是承诺抵抗所有内核漏洞或宿主管理员。

仅隔离 exec 不能限制宿主运行的 `read_file`、`apply_patch`、`web_fetch` 或 Extension 的直接 I/O。文件/网络工具需可信 broker 或统一访问限制；不可信 Extension 若在宿主任意执行 Node 代码，不受审批入口天然约束，需另行隔离或明确只支持可信 Extension。

### 7.2 跨平台后端比较

| 后端 | 适用性 | 重要限制 |
|---|---|---|
| Windows Job Object | 进程树、资源与生命周期管理 | 不提供文件/网络隔离；受限 Token、低完整性也不能单独保证不可读秘密 |
| Windows AppContainer＋受限 Token/helper | 原生文件/网络访问控制候选 | ACL、能力、继承句柄和开发工具兼容复杂；需真实验证，不承诺零安装或无兼容问题 |
| macOS Seatbelt / sandbox-exec | 轻量原生策略候选 | deprecated 与版本兼容风险，非长期稳定 API 保证；规则要显式限制读取与 IPC |
| Linux bubblewrap | namespace、挂载与禁网候选 | 依赖安装与内核/发行版配置；只读挂载仍可读取秘密；资源限额另配 |
| Linux Landlock/seccomp | 文件限制及 syscall 约束候选 | 内核能力、继承与网络限制版本不同，不与 bwrap 完全等价 |
| Docker/Podman | 跨平台受控 Linux 执行环境 | 用户依赖、目录 I/O 和工具链差异；Linux 通常共享宿主内核，不能宣称无逃逸或三端一致 |
| WSL2＋受限执行环境 | Windows 的可选 Linux 路线 | WSL 本身不是项目沙箱；必须限制 /mnt、Windows interop 和宿主入口 |
| VM / MicroVM | 独立内核隔离候选 | 打包、运行权限、启动和资源成本较高；不同平台能力不一致 |
| Wasm/WASI / 受限脚本运行时 | 纯计算工具、显式 capabilities | 不能代替任意系统命令；宿主 imports、目录和资源开放仍需限制；Node vm 不是安全边界 |

Node permission 不是任意子程序安全沙箱。允许启动外部程序不能期待 Node 文件权限自动约束它们。

### 7.3 文件、网络与秘密

- `realpath`、最近存在父目录检查有助于分类，但存在 TOCTOU；Windows 还需处理 junction/reparse point、大小写、UNC、设备路径等。
- 文件操作的硬限制需执行时安全打开、平台强制边界或受控 broker，不称“加一次 realpath 就修好沙箱”。
- 不把整个宿主根目录或 HOME 只读暴露给不可信进程；采用最小可见集合和独立临时 HOME。
- Agent Home 可能同时存配置、记忆、会话等，不应默认整体可写挂载给命令。工作目录和 Agent 数据/凭证需区分。
- 环境变量从最小白名单构造，不能仅删名称带 TOKEN 的项；PATH、启动配置和继承句柄也需审核。
- 网络禁用与 HTTP 域名允许不是同一能力；代理需强制不可绕过，考虑重定向、DNS、私网/元数据地址、localhost、WebSocket 等入口。
- exec 禁网不自动限制宿主 web_fetch；读取文件后经另一个工具外发也要受策略控制。

### 7.4 容器与恢复

容器直接可写挂载项目仍能删项目。高风险任务优先可丢弃工作副本，显式审阅/应用 diff；diff 应用也是需要检查的副作用。

候选基线：非 root、最小挂载、无网络或强制代理、drop capabilities、no-new-privileges、资源/PID/磁盘限额，避免 Docker socket、宿主凭证或广泛设备挂载。运行时镜像与依赖也是信任输入。

隔离不等于回滚；回滚也不能撤回外发数据或外部 API 修改。

### 7.5 Windows 优先与能力感知

不因 macOS/Linux 后端较容易就忽略维护者主要在 Windows 的实际体验：

1. 先定义与 OS 无关的效果和约束契约，以及 `host-direct` 的明确标签。
2. 优先做 Windows helper 可行性实验：Job Object 生命周期及 AppContainer/受限执行对 node、git、python、npm 的真实兼容测试。
3. 提供可选 Docker/Podman 或受限 WSL2 Linux 后端，但不偷偷把 Windows 命令改为 Linux 执行。
4. 并行评估 macOS Seatbelt 和 Linux bwrap，统一的是能力描述与策略，不是底层语义或安全强度。

后端报告实际可强制的能力：filesystem read/write、network、process tree、resource limit、工作副本等；缺少严格要求的能力时拒绝执行或要求用户显式选择较弱模式，不能自动静默降级。Job-only 必须标为进程管理，无文件/网络隔离。

SandboxProvider/SandboxRunner 的目录归属、契约、配置及探测只是候选，需按项目依赖方向另行决策。

---

## 8. 建议推进顺序与未决问题

### 8.1 推进顺序（非授权路线）

1. 建立后果维度、可信 State 与未知语义，明确现有行为及非目标；不先承诺模型自动批准。
2. 加固环境与资源暴露；验证 Windows 隔离可行性和可选 Linux 容器工作副本，建立真实约束能力。
3. 用确定性分析和有限工具效果模型做 shadow 评测；评估 GLiClass 等基线与自训分类器。
4. 验证失败降级、生命周期与权限变更语义，再设计有限自动审批范围。
5. 覆盖三平台端到端测试，记录实际隔离、恢复、性能及兼容证据。

不坚持“模型先上线，最后才做沙箱”。自动放行能力必须与已验证的损害限制相匹配。

### 8.2 尚待决策/验证

- 首批支持哪些工具效果，哪些命令一律保持确认？
- 工作区、Agent Home、可读数据与秘密如何分离？
- 是否需要资源授权或新的 permission mode，如何与 allow_all 共存？
- Windows 原生后端可保证哪些限制，是否需要管理员安装？
- 模型推理异步接入、worker/sidecar、超时与版本更新如何管理？
- 后台进程、Extension、Subagent 与宿主文件/网络工具如何共同执行约束？
- 用户批准高风险操作是否只能降低审批要求，不能扩大不可覆盖的硬边界？
- 如何防检查后脚本/路径/策略变化，如何避免缓存错误授权？

---

## 9. 证据与资料限制

项目文档和源码用于实现观察；模型卡及厂商页面用于候选能力描述。当前没有本项目模型评测、隔离实现或三平台逃逸/兼容测试，不能将以下外部资料等同于产品保证。零样本准确率、概率校准、模型部署支持及 OS 后端能力均需实证。

- [项目文档索引](../README.md)、[当前架构](../architecture/overview.md)、[Tool Contract and Policy](../architecture/tools.md)、[Builtin Tools](../architecture/builtin-tools.md)、[Runtime](../architecture/runtime.md)、[Approval Lifecycle](../specifications/approval-lifecycle.md)。
- 项目源码观察：`src/runtime/policy/tool-approval-policy.ts`、`package.json`。
- TypeSafe [System One](https://docs.typesafe.ai/concepts/system-one)、[Primitives](https://docs.typesafe.ai/primitives)、[Enterprise](https://typesafe.ai/enterprise)。
- [Jev 评测预印本 arXiv:2609.37647v2](https://arxiv.org/abs/2609.37647v2)：通用分类/序列任务，不是本项目命令后果能力证据。
- [GLiClass v4 Edge 模型卡](https://huggingface.co/knowledgator/gliclass-v4-edge)、[源码](https://github.com/Knowledgator/GLiClass)：接口、许可及性能为对应版本声明。
- [Qwen3Guard 技术报告](https://arxiv.org/abs/2510.14276)、[0.6B 模型](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B)：内容审核三类，不等于后果三态。
- [SCX Router](https://arxiv.org/abs/2609.02292)：模型路由分类与缓存设计参考。
- 后续核验入口：[bubblewrap](https://github.com/containers/bubblewrap)、[Landlock](https://docs.kernel.org/userspace-api/landlock.html)、[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Node permissions](https://nodejs.org/api/permissions.html)。这些是进一步实验的参考入口，不表示已核验每个平台最新版本。

### 9.1 本次方向修订摘要

- 从恶意/注入或任务意图判断，转向具体工具的可能有害后果。
- 从笼统 safe/unsafe 直接放行，转向效果证据＋损害维度＋确定性策略。
- 从内容 Guard 开箱即用推荐，转向领域评测与定向训练候选。
- 从用户 Allow/Deny 作为安全标签，转向风险、授权、执行观察分离。
- 从先模型后 Sandbox，转向已验证约束与自动化程度共同设计。
- 去除“毫秒保证”“抗注入最强”“realpath 构成硬边界”“只读根安全”“容器三端 100% 一致”等过强表述。
