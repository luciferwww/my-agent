# Sandbox 基础文件权限设计草稿

> Status: Non-authoritative design draft
> Date: 2026-11-25
> Authorization: 仅整理讨论与证据，不授权实现、额外实验、权限变更或提交
> Scope: Exec Sandbox 的基础文件权限，以及资源权限与工具审批的衔接；不引入新的配置字段
> Authority: 当前行为以 [Sandbox Execution](../specifications/sandbox-execution.md)、[ADR-028](../decisions/adr-028-mxc-windows-exec.md) 和源代码为准

## 1. 问题与目标

用户配置的 `read / write / deny` 不是完整有效权限。执行还依赖系统程序、
my-agent 的可信启动资源和私有临时数据；部分系统访问由后端或 OS 自己提供。
需要明确哪些权限由我们添加、哪些已由后端提供，避免为了兼容性盲目扩大授权。

本文使用“基础文件权限”统称这些来源，其中只读部分叫“只读执行依赖”。
不使用“保留目录”暗示一个目录必然全部可读、绝对不可修改或已经显式拒绝。

目标是有限、可解释的基线，而不是覆盖所有 Shell、语言环境和开发工具的清单。

## 2. 权限与来源必须分开说明

| 标记 | 含义 |
| --- | --- |
| `read` | 内容只读；通常足以读取程序及其依赖，不是独立的执行权限模型 |
| `write` | 读写，包括创建、覆盖和删除，不是只能写 |
| `deny` | 内容访问拒绝，实际覆盖及别名关系遵循原生策略规则 |
| metadata | 目录枚举等元数据访问，不等于授予文件内容读取 |
| backend / OS baseline | 后端挂载或 OS ACL 提供的访问；观测例外不能冒充显式 `deny` |

每项说明还应标记来源：my-agent 显式添加、每次执行动态添加、用户配置，
或后端 / OS 提供。不能把“未加入清单”“自动发现排除”“ACL 无授权”统称为 `deny`。

## 3. 当前实现事实

[MXC adapter](../../src/builtins/tools/environment/process/sandbox/mxc-runner.ts)
组合用户配置、必要读取和每次执行的临时数据；未自动授予 cwd 或整个 Agent Home。

| 位置 | 权限 | 来源 |
| --- | --- | --- |
| 实际 Windows `%SystemRoot%\System32` | `read` | adapter 当前显式添加 |
| 当前 Node 可执行文件所在目录 | `read` | adapter 显式添加 |
| 固定可信 Bootstrap 文件及其最近的必要 package manifest | `read` | adapter 显式添加 |
| 安装布局中的 Linux npm runtime library，存在时 | `read` | adapter 显式添加 |
| 每次 Exec 唯一的私有临时根及内部 HOME / cache / Windows TEMP | `write` | adapter 动态创建、授权与清理 |
| Linux Sandbox 自己的 `/tmp` | 私有临时可写区域 | bubblewrap 后端构造，不是宿主 `/tmp` |
| Windows 相关执行卷的目录枚举 | metadata | adapter 显式配置 `enumeratePaths` |
| `agents.sandbox.read / write / deny` | 对应配置权限 | 用户显式配置 |

目前未显式加入 SysWOW64、整个 Windows / Program Files / ProgramData，
也没有一套内置系统目录 `deny` 清单。
同一路径同时配置 `read` 和 `write` 时只读生效；但只读父目录不阻止
更具体子路径的显式 `write` 授权。
当前 `requirePaths` 会拒绝必要路径被配置的 `deny` 父路径覆盖；更复杂的
write / read / deny、别名及子路径冲突仍需依照实现和原生规则核实。

## 4. Windows：不把已有系统访问重复当作必需授权

Windows ProcessContainer 的系统访问可能来自 `ALL_APPLICATION_PACKAGES` 等 ACL，
不只来自 MXC 请求。微软公开基线是采样观察，不是所有机器的权限保证；
目录父级可读也不保证每个子项同样可读。

### 已做的有限对照

2026-11-25，在当前开发机和 MXC SDK 1.1.0 上，保持 Node、Bootstrap、私有 TEMP
及其它请求内容不变，只在测试 adapter 中移除显式 System32 `read`：

| 检查 | 保留 System32 显式授权 | 移除 System32 显式授权 |
| --- | --- | --- |
| 64 位 cmd / Node 启动 | 成功，exit 0 | 成功，exit 0 |
| 读取 System32 的 `kernel32.dll` | 成功 | 成功 |
| 读取 SysWOW64 的 `kernel32.dll` | 成功 | 成功 |
| 启动 SysWOW64 的 32 位 cmd | 成功，exit 0 | 成功，exit 0 |

测试没有修改生产代码或用户配置，已清理独立测试目录。
这里只证明本机这些操作不需要重复授权，不能证明所有系统文件可读、
定位是哪一条 ACL 生效，或证明其它 Windows build / 架构同样成立。
此记录没有完整的 OS build / ACL 快照，不能作为跨平台认证。

### 建议与尚未决策项

- 不为了“保险”整体添加 Windows、Program Files、Program Files (x86) 或 ProgramData。
- 不因本机成功就立即删除现有 System32 授权；是否删除需独立确认和目标环境验证。
- SysWOW64 对 32 位 x86 程序重要，但它的必要性不等于必须显式加入 `read`。
  先验证后端访问与代表性 32 位执行，不在“默认添加 / 按需添加”之间凭猜测切换。
- 使用实际系统位置，不硬编码 `C:\Windows`；ARM64 等环境不能仅凭目录名称推断兼容性。
- 后端 / OS 不能满足所需访问时明确报错；不自动扩大授权、修改宿主 ACL 或切换宿主执行。

## 5. Linux：复用后端构造，不重新开放宿主系统根

MXC 1.1.0 bubblewrap 后端已经构造基础视图：

| 集合 | 权限 / 视图 | 来源 |
| --- | --- | --- |
| `/bin`、`/sbin`、`/lib*`、`/usr/bin`、`/usr/sbin`、`/usr/lib*`、`/usr/libexec`、`/usr/share` | `read` | 后端系统程序与库基线 |
| `/etc` 及受支持的 resolver 配置 | `read` | 后端系统配置基线 |
| `/proc`、`/dev` | 特殊视图 | 后端构造，不能概括为宿主目录的 `read / write` |
| `/tmp` | 私有临时区域 | 后端构造 |

`*` 是概括后端集合，不是 my-agent 配置支持 glob。
读取 `/etc` 不意味着没有可读敏感数据；宿主 ACL 和运行用户仍影响结果。
不要复制挂载宿主 `/`、`/tmp`、`/proc` 或 `/dev` 来“补齐”运行环境。
`/usr/local`、`/opt`、宿主 HOME、共享缓存不自动升级为通用基础授权。

## 6. 可信程序资源：依赖安装产物，不依赖源码发布形式

建议叫“可信程序资源”，仅指 Sandbox 启动实际需要的代码或资源：

- 当前 JS 发布：Node 目录、固定 Bootstrap 和必要 manifest；不是整个源码树。
- exe 启动器：如果仍依赖外部 Node 或脚本，仍须授权那些实际依赖。
- 自包含 exe：嵌入资源不需要另列外置路径；在 Sandbox 中执行的 helper、
  外置 DLL 或资源仍需按实际布局授权。
- 只在宿主运行、Sandbox 不读取的主程序和 SDK 文件，不因“属于 my-agent”
  就自动加入 Sandbox `read`。宿主侧文件保护是另一个边界。

不要现在建立打包抽象或为假想发布形态增加逻辑。发布布局变化时，在现有 adapter
集中调整必需读取，验证安装包和可信启动，不扫描整个安装目录扩大权限。

目标是不让任务修改可信启动依赖。如果用户 `write` 或更具体规则会使这些资源
变得可写，不能仅凭增加 `read` 宣称已保护；是否增加精确冲突拒绝应单独设计验证。

## 7. `write / deny` 的边界

- 自动 `write` 仅用于已拥有的私有临时数据，不开放整个宿主 TEMP 或管理目录。
- 暂不新增固定系统目录黑名单，继续使用用户 `deny` 和后端原生权限。
- 不把 OS 基线样本的例外复制成实际 `deny`。
- 若以后增加更宽默认授权，再精确评估配置、凭据和会话管理数据的保护；
  不采用“先开放整个 Home，再靠大批 deny 补救”的方式。
- 必需依赖与用户限制冲突时不能忽略限制或伪装执行成功，维持明确失败。
- 宿主文件工具不受此 OS 边界约束；本草稿不声称它们已共享路径校验。

## 8. 资源权限与工具审批的衔接

2026-11-25，owner 确认需要重新设计 Agent Home 内外路径审批：
不再以“路径位于 Home 外”单独增加审批交互。当前只记录设计方向，
没有授权删除现有分支或改变运行行为。

### 当前事实

[Tool Approval Policy](../../src/runtime/policy/tool-approval-policy.ts) 在
`manual` 模式下要求所有 Exec 调用审批，并对文件工具的结构化外部路径
额外要求审批，即使该工具命中 `tools.allow`。`tools.deny` 仍优先，
`allow_all` 则允许非 denied 工具，不受内外路径分支影响。

[路径解析与展示](../../src/builtins/tools/environment/common/path-policy.ts)
以 Agent Home 解析相对路径，并根据内外位置选择显示形式；
该 helper 本身不拒绝 Home 外路径。
文件工具在宿主执行，目前不检查 `agents.sandbox.read / write / deny`，
不能把 Exec 的 MXC 隔离当作它们已具备的访问边界。

### 建议的职责与审批行为

- 工具审批回答“是否允许本次工具调用”；不把 Home 内外当成额外可信等级。
- 资源权限回答“执行可访问哪些资源”；由 Exec 的 MXC 策略或文件工具自身
  的访问校验执行，普通调用审批不自动扩大资源授权。
- Agent Home 保留配置 / 数据存储、相对路径锚点和展示职责，
  但不作为内部文件操作天然更可信的依据。

| 条件 | 建议结果 |
| --- | --- |
| 工具名命中 `tools.deny` | 拒绝 |
| `manual` 下调用 Exec | 保留现有调用审批，不因 cwd 在 Home 内外而改变 |
| `manual` 下其它工具命中 `tools.allow` | 不再仅因结构化目标位于 Home 外追加审批 |
| `manual` 下其它未命中 allow 的工具 | 沿用普通调用审批；缺少审批能力时拒绝 |
| `allow_all` 下非 denied 工具 | 保持现有调用授权，不解除独立资源限制 |
| 访问超出实际生效的资源权限 | 明确拒绝，不通过普通调用审批自动解除限制 |

取消的是外部路径的特殊审批分支，不是所有文件操作审批；
允许访问某个目录也不意味着所有修改操作均无需调用审批。

### 必须明确的实施边界

删除外部路径分支会扩大 `manual` 下命中 allow 的宿主文件工具可访问范围。
实施前必须选择并确认：先接入明确的文件访问策略，还是接受宿主文件工具
继续按宿主权限执行的范围变化。不能以“已有 Sandbox”隐去这个变化。
这里暂不决定具体接入方案，也不另建一套路径审批或自动扩权机制。

若文件工具以后复用 `read / write / deny` 的配置意图，须明确 Sandbox
启用 / 关闭时是否执行校验，以及别名、父子覆盖、自动 grant 和错误语义；
不能仅复用一份配置就声称与 MXC 原生权限完全一致。软件校验也不能宣称
等同 OS 隔离。对 Sandbox 关闭模式的行为不得留下隐式默认。

明确保留：

- 相对路径解析、输入校验和输出路径展示。
- Exec 私有 TEMP 必须在 Agent Home 外、owned root 绑定和清理等约束。
- 必需程序资源与用户限制冲突时明确失败的原则。

正式实施时按模块验收：内外路径不再额外审批、普通 allow / deny / manual /
allow_all 保持预期、资源越界不被普通审批放行、未授权的宿主访问范围变化
没有被隐藏。复用现有测试，删除仅维护旧内外分类行为的过时用例，
保留路径解析及实际资源限制的有效测试；不新增审批框架。

## 9. 已确认方向与后续最小验证

2026-11-25，owner 确认以下三项方向（尚未授权自动修改代码）：

1. **System32 显式授权**：暂保留现行 `%SystemRoot%\System32` 显式 `read`，
   不因单机测试结果移除，也不盲目扩大到整个 Windows 或 `SysWOW64`。
2. **可信程序资源与用户 `write` 冲突**：不新增额外的启动拒绝校验，
   交由 MXC 原生优先级规则处理（同路径 `read` 优先于 `write`）。
3. **审批简化与宿主文件工具边界顺序**：先让宿主文件工具接入明确的资源路径校验，
   再取消 Agent Home 内外特殊审批分支（或同批完成），不先单独放宽宿主访问。

仅在另行授权的实现 / 验证范围内，复用已有测试，不按语言或文件目录堆积用例：

1. 若后续考虑调整系统目录授权，需在明确记录的目标 Windows build / 架构上验证差异；
   检查实际可读系统库、64 位及安装存在时的代表性 32 位执行。
2. 同时验证项目 write、用户 deny、可信入口启动、私有 TEMP 和取消清理未回归；
   “命令 exit 0”不替代权限验证。
3. Linux 升级 / 实现变化时验证后端系统依赖、合并 `/usr` 的别名和私有临时视图，
   不重复添加系统挂载。
4. 只有发布布局确实变化时才验证自包含 helper / 外置资源及必要只读范围。

PATH / JAVA_HOME 等工具发现、默认 Session 产物目录、额外工作目录工具、
Prompt 路径提示、网络模式和 Smart Approval 均不在本次范围。
宿主文件工具只在第 8 节讨论权限衔接，实际迁移不在本次文档工作的授权范围。

## 10. 来源

- [MXC 1.1.0 Windows 文件系统与隐式 ACL](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/process-container/filesystem.md)
- [MXC 1.1.0 BaseContainer 原生路径规则](https://github.com/microsoft/mxc/blob/v1.1.0/docs/schema.md#overlapping-paths-for-windows-basecontainer)
- [MXC 1.1.0 bubblewrap 后端](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/bwrap/bubblewrap-backend.md)
- [Windows WOW64 文件重定向](https://learn.microsoft.com/en-us/windows/win32/winprog64/file-system-redirector)
- [Copilot 自动文件权限与工具发现](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/understanding-local-sandboxing)
- [Codex Windows 系统读取目录](https://github.com/openai/codex/blob/8e757686c1ba2d4dc0864edfb8aa286f7029d90d/codex-rs/mxc-sandbox/src/windows.rs)
- [OpenClaw MXC 基础只读目录](https://github.com/openclaw/openclaw/blob/0164469662159bfe60ca4e55b9d3a018f08f16e3/extensions/mxc/src/sandbox-baseline.ts)

其它 Agent 的目录清单是兼容性参考，不构成我们的默认授权或跨机器保证。
