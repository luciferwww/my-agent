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

### 已确认方向与后续调整条件

- 不为了“保险”整体添加 Windows、Program Files、Program Files (x86) 或 ProgramData。
- 暂保留现有 System32 显式 `read`。后续若考虑删除，需另行确认和目标环境验证。
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

默认为可信启动依赖提供只读基线，不宣称整个子树不可修改。已确认不因用户
`write` 与该基线重叠而新增启动拒绝：同路径冲突由 MXC 原生规则选取只读，
更具体的用户 `write` 可能形成可写例外，应尊重并如实说明该选择。
现有 `requirePaths` 对必要路径被配置的 `deny` 父路径覆盖的失败行为保持不变；
此次决定不取消这类检查，也不把它扩展为所有 read/write 重叠的拒绝机制。

## 7. `write / deny` 的边界

- 自动 `write` 仅用于已拥有的私有临时数据，不开放整个宿主 TEMP 或管理目录。
- 暂不新增固定系统目录黑名单，继续使用用户 `deny` 和后端原生权限。
- 不把 OS 基线样本的例外复制成实际 `deny`。
- 若以后增加更宽默认授权，再精确评估配置、凭据和会话管理数据的保护；
  不采用“先开放整个 Home，再靠大批 deny 补救”的方式。
- 必要路径被配置的 `deny` 父路径覆盖时维持现有明确失败；
  用户 `write` 与只读基线的重叠遵循第 6 节，不新增主动拒绝。
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

已确认先让宿主文件工具接入明确的文件访问策略，再取消外部路径特殊审批，
或同批完成。不得先独立删除审批分支并把资源校验留到以后。
取消特殊审批的方向适用于启用和关闭两种模式，其影响须分别说明：

| `agents.sandbox.enabled` | 宿主文件工具的资源访问 | 工具审批 |
| --- | --- | --- |
| `true` | 拟以显式依赖 read 基线与启动配置的 `read / write / deny` 执行软件路径校验；未授权资源默认拒绝，不隐式授予 Home/cwd | 普通 allow/deny/调用审批，不再额外按 Home 内外分类 |
| `false` 或省略 | 不执行这层软件路径策略，仍按宿主账户和 OS 权限访问；保存的路径列表不生效 | 同样使用普通工具审批，不保留 Home 外特殊审批 |

关闭模式保留的是文件工具的宿主执行方式，不是完全不变的授权行为：
移除特殊审批后，命中 `tools.allow` 的外部文件操作不再要求额外确认，
缺少审批能力时也不再仅因路径在 Home 外而拒绝。这个范围变化必须写入
正式 Change 的迁移与验收说明，不能声称已由 MXC 或软件路径策略保护。

软件策略拟仅覆盖 `list_dir`、`read_file`、`file_search`、`grep_search`、
`write_file`、`edit_file`、`apply_patch`；不改变宿主 Web、Memory、Skill、
MCP 或任意 Extension 的资源权限。
执行阶段资源拒绝报告工具失败，不提供审批后绕过；普通审批仍可能先发生，
不能把“不按 Home 内外追加审批”描述成所有越界调用都不会弹窗。

### 软件路径校验的对象与限制

拟复用用户配置意图：`read` 允许读取，`write` 包含读取与修改，`deny`
拒绝访问；同一规范化路径按 `deny > read > write`，父子规则取更具体匹配。
这只是软件匹配语义，不承诺复现全部 MXC/OS 权限。私有 Exec TEMP、
Windows 隐式 ACL 和 Linux 后端系统视图不自动成为宿主文件工具授权。
扩展后的 [归档 Change](../changes/archive/sandbox-filesystem-policy/specification.md)
已交付共享显式依赖 read：System32、当前 Node、Bootstrap、必要 manifest
和已选择的 Linux npm library；两类工具使用一致的显式只读基线，
不复制整套 OS 权限，也不自动发现所有任务运行时。Owner 于 2026-11-25
批准设计、确认 Windows 人工验证并授权归档；本文其它讨论阶段的实现观察
保留为历史背景，当前契约以稳定 Specification 和源码为准。

| 操作 | 应覆盖的受检对象 |
| --- | --- |
| 直接读取 | 实际文件目标；路径解析和必要 metadata 查询不等于授权内容读取 |
| 列目录 | 枚举根及返回子项的权限；列出名称与读取内容分开说明，不用根目录授权推导全部子项可见 |
| 递归搜索 | 每个实际进入的目录、返回的路径及读取内容的文件；拒绝子项不能出现在内容或文件名结果中 |
| 创建/覆盖/修改 | 实际目标，包括不存在的目标；若创建父目录，还须覆盖实际创建的目录，不能只检查最终文件 |
| 删除 | 实际删除对象及涉及的目录项；链接本身与链接目标需区分，不能用目标读取规则代替删除语义 |
| 移动/多文件 patch | 源、目的及实际读取、写入、删除、创建对象；任一预检失败时，不开始此前 hunks 的修改 |

目录授权覆盖子项，包括尚未创建的目录和文件。写入授权范围内的新子项
继承可写权限，除非更具体的 `read / deny` 收紧它们；范围外默认拒绝。
`deny` 主要用于从较宽的 read/write 授权中排除敏感子项，不是维护所有
未授权路径的黑名单。不新增父目录审批、逐文件授权或创建权限框架。

目标路径和配置规则都需要考虑符号链接/junction 及已存在祖先的真实路径，
而不只是字符串前缀。不存在的尾部、悬空链接、解析错误不能被当作已授权
成功返回。不得只检查搜索输入根，或只在目标存在时检查其 `realpath`。
遍历过程中遇到资源拒绝应按明确的过滤规则处理；其它 I/O/解析失败如何
传播应与工具当前错误契约一并确定，不能用“跳过”掩盖校验失败。

`realpath` 是检查时的路径事实，不消除检查与 I/O 之间的竞态；硬链接、
挂载别名和并发替换也不能宣称已得到 OS 级保护。多文件预检不等于磁盘事务：
预检之后的 I/O 或内容匹配失败仍可能留下部分修改，不新增自动回滚承诺。

已讨论确认的操作规则：

- 从上层列举/搜索时跳过拒绝目录，不为寻找允许例外而枚举它；
  已授权的子路径仍可直接作为访问目标或搜索根。
- 在 write 目录范围内创建子目录/文件按普通继承处理；实际新建的目录
  也须落在可写范围内，不因最终文件可写就自动扩大到未授权的父目录。
- 读取、覆盖、编辑链接时检查真实目标；删除/替换链接本身检查其真实
  父目录下的目录项，不跟随链接删除目标。移动按工具实际执行的读取、
  写入和删除分别校验，不把现有内容复制式移动当成纯 rename。

这些规则用于整理正式 Change，不构成实施授权。
不另建审批框架、自动授权或对原生权限的成功形回退。

明确保留：

- 相对路径解析、输入校验和输出路径展示。
- Exec 私有 TEMP 必须在 Agent Home 外、owned root 绑定和清理等约束。
- 必要路径被配置的 `deny` 父路径覆盖时的现有失败行为；
  不因用户 read/write 重叠新增可信资源拒绝。

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

已讨论的文件工具生效条件见第 8 节：仅 Sandbox 启用时执行软件路径策略，
关闭时沿用宿主资源权限；两种模式均拟移除 Home 内外特殊审批。
实现前须将第 8 节的操作范围、局限、已确认规则和关闭模式的授权变化
落实到 Proposed Plan / Draft Specification，并经 owner 正式审批。
讨论方向确认、独立评审或本草稿提交不代替 Change 的实施审批。

仅在另行授权的实现 / 验证范围内，复用已有测试，不按语言或文件目录堆积用例：

1. 若后续考虑调整系统目录授权，需在明确记录的目标 Windows build / 架构上验证差异；
   检查实际可读系统库、64 位及安装存在时的代表性 32 位执行。
2. 同时验证项目 write、用户 deny、可信入口启动、私有 TEMP 和取消清理未回归；
   “命令 exit 0”不替代权限验证。
3. Linux 升级 / 实现变化时验证后端系统依赖、合并 `/usr` 的别名和私有临时视图，
   不重复添加系统挂载。
4. 只有发布布局确实变化时才验证自包含 helper / 外置资源及必要只读范围。
5. 文件工具迁移需验证启用/关闭、未授权资源、同路径/父子规则、别名、
   遍历过滤和多文件预检；审批验收覆盖外部 allow 不再追加确认、普通
   未允许调用仍需审批、工具 deny 最终生效，以及审批不解除资源拒绝。

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
