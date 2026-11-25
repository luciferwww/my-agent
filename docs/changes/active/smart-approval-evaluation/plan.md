# Smart Approval 模型评估 Plan

> - **Status:** Proposed
> - **Date:** 2026-11-25
> - **Owner:** Project owner
> - **Authorization:** 仅准备待审批文档；Plan 和 Spike Specification 接受前不得下载模型、安装依赖或执行实验
> - **Scope:** Node.js-only、必须 CPU 推理的单候选可行性与有限离线评测；复杂接入则停止，不实施产品 Smart 模式
> - **Process authority:** [Development Workflow](../../../governance/development-workflow.md)

## 1. 目标与依据

先用证据决定模型输出格式、可评估的工具/效果范围和进一步试验价值，
不先让 owner 凭猜测确定二态/三态或产品放行档位。

[设计草稿](../../../research/smart-approval-design-draft.md)记录 Smart 与
allow_all 的区别，以及拟议的 Sandbox 前提；这些不是现行实现。
本 Change 只承接[Draft Spike Specification](spike-specification.md)，
不授权改 SessionPermissionMode、Tool permission、Sandbox 或真实审批。

## 2. Plan Items

| ID | 工作 | 状态 | 前提与完成证据 |
| --- | --- | --- | --- |
| SAE-0 | 审阅并接受有限实验范围 | Not Started | Owner 接受 Plan 与 Spike Spec |
| SAE-1 | 核实本地推理与固定版本加载 | Not Started | SAE-0；记录模型/运行库版本、实际安装产物、加载/输出失败 |
| SAE-2 | 冻结人工参考案例并比较二态/三态 | Not Started | SAE-1；最多 24 个基础案例，参考与候选模型输出分开 |
| SAE-3 | 汇总质量、覆盖率、性能和停止行为 | Not Started | SAE-2；可复现原始计数、反事实差异、错误案例和局限 |
| SAE-4 | Owner 确认结果并决定后续设计 | Not Started | SAE-3；可选择继续评测、换方案或停止，不自动进入产品实现 |

SAE-1 失败时可以直接报告 Blocked/Failed，不必为完成 SAE-2 强行适配。
目前没有任何实验项获准执行。

## 3. 有限范围

- CPU 推理是硬要求；首个验证环境为 Windows/Node 24，不以 GPU、
  WebGPU 或云推理结果代替。只测一个现成 Node.js 候选，一个保守的“全部转人工”
  决策基线。不以厂商 benchmark/毫秒声明替代本机测量。
- 暂定 Qwen3-0.6B 的现成 Transformers.js/ONNX 产物；先确认可直接加载，
  并通过实际 CPU 推理后再评测；不支持 CPU 就停止该候选。
  GLiClass 不作为本轮执行候选，不为它自制分词/张量/分类适配器。
  具体来源、revision、依赖边界和调用上限见 Spike Spec。
- 不引入 Python、venv、PyTorch、模型转换或训练，也不构建第二套推理栈。
  Smart 是减少确认的用户友好特性；接入/维护成本过高可以直接决定不采用。
- 二态与三态在相同案例/事实下比较，不预先确定产品采用哪个格式。
- 参考风险标准仅用于实验标注；真实可接受风险、上线范围和阈值由结果
  支持后另行决策，不从少量案例推导普遍安全保证。
- 只使用合成调用/上下文，不接入真实会话，不执行样本里的命令，不上传
  本地代码、凭据、截图或对话到第三方评估服务。

## 4. Gate 与交付

遵循 Draft -> Accepted -> Executing -> 结果评审的 Spike 流程。
仅用现有 Node 24；必要 JavaScript 依赖只在获准的临时 Node 项目准备，
不升级 my-agent 当前模型库、不修改项目清单、全局运行时或 OS 权限。
若现有运行时不足、新工具/远程模型或范围扩展才可继续，先报告并申请修订，
不能静默新增安装或绕过边界。若需要大量手工适配、额外进程服务或
模型转换才能运行，报告不值得采用，不扩大本轮规模。

执行获准后产生 `spike-results.md`，记录失败也算有效结论。
先评估证据，再修订 Smart 设计草稿；产品代码需另有 Accepted Plan/Spec/ADR。
不创建未执行的 Results，不自动提交、推送或归档。
