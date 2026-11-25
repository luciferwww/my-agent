# Smart Approval 设计草稿

> - **Status:** Non-authoritative design draft
> - **Date:** 2026-11-25
> - **Authorization:** 仅整理讨论，不授权实现、模型运行、Change 接受或提交
> - **Scope:** 审批模式、Sandbox 前提、通用工具风险评估和有限 shadow 验证
> - **Basis:** [原始调研](smart-approval-and-cross-platform-sandbox-research-2026-11-23.md)、[Approval Lifecycle](../specifications/approval-lifecycle.md)、[Sandbox Execution](../specifications/sandbox-execution.md)

## 1. 目标与术语

减少有意义的低风险调用上的重复确认，不以无条件放行代替风险判断。
工具审批决定是否执行；Sandbox/软件路径策略限制执行能访问的资源，两者不互相替代。
Owner 明确 Smart 是用户友好特性：不为它引入 Python 依赖或复杂推理系统。
只考虑现成、轻量的 Node.js CPU 推理路线；CPU 是必需条件，不以 GPU
或云模型代替。接入/维护成本不合适时可以不做。

本文区分三件事：

- **规则放行**：命中用户预配置 allow 等确定性策略，不分析本次调用风险。
- **Smart Approval**：根据有效调用和实际环境评估，再决定免确认或转人工。
- **`allow_all`**：用户显式选择不做逐调用审批；所有非工具 deny 调用直接获准。

Smart 的结果可以是免确认，但 Smart 不等于 `allow_all`。
“自动批准”不是本文另增的第四种模式，不用它同时指代上述不同机制。

## 2. 当前事实与拟议模式

当前源码只有 `manual / allow_all`；Smart 尚未实现。
当前 `allow_all` 不要求 Sandbox，`manual` 下 Exec 必审，其它工具遵循 allow/deny。
Windows/Linux MXC 和七个文件/搜索工具的软件路径策略已交付；原调研中
“没有 OS 隔离”和 Home 内外特殊审批的描述属于旧快照。

拟议模式如下，不能当作当前行为：

| 模式 | 行为 | Sandbox 前提 |
| --- | --- | --- |
| `manual` | 保留普通规则，Exec 必审；其它工具命中 allow 可免确认，未允许调用需人工审批 | 不要求 |
| `smart` | 保留最终工具 deny；对需要审批的调用评估，符合条件才免确认，否则转人工 | 要求开启 |
| `allow_all` | 保留最终工具 deny，但不进行逐调用风险评估/人工审批 | 要求开启 |

Owner 已同意采用一致的 Sandbox 前提作为后续设计方向：
不是让 `smart` 要求隔离，却允许更宽的 `allow_all` 无隔离运行。
这会改变现有 `allow_all` 使用条件，须经过正式契约修订与 Change 审批。
开启 Sandbox 不自动选择 Smart 或 `allow_all`，二者也不解除文件/网络限制。

## 3. 通用工具范围与实际资源边界

Smart 设计在通用审批入口，不硬编码成 Exec 专用。
Owner 已确认：“已有放行”指基础 Tool permission 策略已明确返回 `allow`，
不是 Sandbox 路径策略匹配通过。Smart 只评估基础策略仍要求审批的调用。

| 情况 | 拟议 Smart 行为 |
| --- | --- |
| 非 Exec 工具命中 `tools.allow`，无工具 deny | 不重复评估；执行阶段资源校验仍保留 |
| 其它工具未命中 allow，也无 deny | 进入 Smart，不能仅因目标可读/可写而批准 |
| Exec 命中 `tools.allow` | 当前基础规则的 Exec 必审优先于 allow；拟议 Smart 仍评估，manual 仍必审 |
| Session 选择 `allow_all` | 使用该独立模式，不进入 Smart |

例如，`write_file` 不在 `tools.allow` 中，即使目标处于 Sandbox 的 write
范围，仍需 Smart 判断此次操作后果。工具审批允许与资源访问允许不能混用。
过去的模型/人工批准也不自动变成后续相似调用的预授权。

Sandbox 开关只提供模式启用前提，不能说明每个工具都被隔离：

| 工具类别 | 当前约束 | Smart 不得推断的保证 |
| --- | --- | --- |
| Exec 及子进程 | MXC OS 文件/网络策略与生命周期管理 | 可写数据不会损坏、所有网络操作安全或存在资源配额 |
| 七个 Builtin 文件/搜索工具 | 启用时的软件路径校验 | 等同 OS 隔离、无竞态或允许修改就代表低风险 |
| Web、Memory、Skill、MCP、任意 Extension | 各自已有行为，不因 Sandbox 开关增加隔离 | 全部受 MXC 文件/网络策略保护 |

允许目录里覆盖用户文档、向允许目的地发送数据，仍可能造成损害。
未覆盖工具不能因全局开关开启而获得“已受控”评价；效果/约束不明时转人工。
`allow_all` 不承诺替用户审查这些工具；工具 deny 仍可禁止它们。

## 4. 最小评估输入与结果

输入由 Runtime 构造，绑定 Hook 变换和 Schema 验证后的有效调用：
工具身份、完整有效参数、已知的执行环境、实际资源约束及来源。
模型不能自报“已隔离”“有备份”或修改授权事实；未知事实保持未知。
不为分析主动读取更多敏感文件，也不把本地调用、代码或凭据发送给第三方评估服务。

评估关注可能效果、损害范围、可恢复性与不确定性，不问一句“这个命令安全吗”。
本地轻量模型可提供候选效果和判断；最终放行由可信策略决定。

| 评估情况 | 建议审批结果 |
| --- | --- |
| 效果足够明确，风险在用户接受的范围内 | Smart 放行候选，不是凭单一置信度直接批准 |
| 数据损失、对外发送或其它明显副作用需要确认 | 转人工 |
| 效果不明、输入过长、分析/解析失败、模型不可用或超时 | 转人工；缺少人工审批能力则失败关闭 |
| 工具命中明确 deny | 直接拒绝，不让模型覆盖 |

转人工不表示已判断安全，分析失败也不能伪装成用户拒绝。
不把 `npm test`、`git diff`、只读工具名称或“用户经常批准”当作安全证明。
首批支持哪些工具、可接受风险标准及本地模型仍待确定；不预设概率阈值。
模型二态/三态与可处理后果范围先作为实验假设，不能在能力验证前定死。

## 5. 接入与模式切换建议

复用现有 Runtime 策略、Approval manager 和 Framework，不建立第二套审批 registry。
当前 `decide()` 同步；异步评估应在 Runtime 授权流程中协调，
不能向同步方法塞阻塞推理，也不让 Core 依赖具体模型 SDK。

建议顺序：有效输入校验与最终工具 deny，检查模式/Sandbox 前提及可确认的
资源硬限制；明确不允许时拒绝。基础 Tool permission 已允许的调用不进入
Smart，仍需审批的调用才评估，再走人工审批或 Framework 执行。
资源策略通过只代表已知访问符合约束，不是 Smart 批准。
任意脚本的访问范围无法提前完整确定时，不假装全部匹配通过，也不把未知
冒充确定违规；评估保留不确定性，执行阶段仍落实实际资源校验。

- 自动决定须标明 Smart/策略来源，不伪装成用户逐调用确认。
- 分析绑定 Session/Turn/callId 和参数；模式/有效输入/关键约束改变时，
  旧结果不能继续授权。Abort/Shutdown 后的迟到结果不得启动工具。
- 不符合 Sandbox 前提的模式选择应明确失败并保留原模式，不偷偷开启
  Sandbox 或回退宿主执行。具体 Channel/API 结果在正式 Spec 中定义。
- 进入 Smart 不批量批准已有人工请求；首期建议只影响后续授权的调用。
  `allow_all` 对已有请求的结算须保持明确来源和既有 first-settlement-wins 规则。
- Session 默认仍为 manual，模式仍是进程内状态；不新增持久授权或审批缓存。

这些是待正式接受的接入建议，不表示已修改当前模式/API。

## 6. 先 shadow，后决定实际放行

shadow 是观察方式，不是第四种权限模式。只对拟支持的有限调用作评估，
不改现有审批结果，不替用户点击批准，不运行危险样本验证“是否真的安全”。
是否记录及记录哪些数据需先确认；不保存明文凭据、多余文件内容或训练用用户画像。

先用少量有代表性的调用比较判断：正常读取、可写范围内覆盖、脚本执行、
对外副作用和未知工具。用户批准与真实风险标签分开，不把 Allow 当成安全标签。
报告误放行、可自动处理的覆盖率、弃权、延迟和资源消耗；门槛根据证据确定。
评估有效后，再审批有限自动放行范围，不承诺能判断任意程序的全部后果。

## 7. 下一步与非目标

下一步先审阅[Proposed 评估 Plan](../changes/active/smart-approval-evaluation/plan.md)
及 [Draft Spike Spec](../changes/active/smart-approval-evaluation/spike-specification.md)。
先验证一个现成 Node.js 候选是否能简单接入，不能则结束；
通过获准的有限本地实验比较二态/三态、临时参考案例、效果识别与运行成本，
再根据证据确定产品输出格式、首批放行范围和可接受标准，不先凭猜测选档位。
模型与异步生命周期等未知项需要实验时，先审批有限 Spike；实现前按
[Development Workflow](../governance/development-workflow.md) 接受 Plan/Spec/必要 ADR 修订。

不增加 Sandbox 绕过、PATH/工作目录授权、回滚/配额框架、全工具训练集、
后台审批服务或更多风险评分开关。此草稿不修改现有 `manual / allow_all`。
