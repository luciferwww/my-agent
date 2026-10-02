# Thinking Generation Controls Plan

> Status: Accepted — full Delivery authorized
> Date: 2026-10-03
> Owner: Project owner
> Classification: Architecture Slice
> Authorization: 所有者于2026-10-03接受Specification，确认TGC-P1，并批准继续至实施完毕
> Current phase: TGC-P3 Built-in协议闭环

## 1. 目标与来源

模型声明可兑现的Thinking开关与effort，用户为消息选择策略；默认请求保持不变，
实际可读Thinking沿用已有采集、展示和历史机制。

- [Specification（Draft）](specification.md)：本Change的交付契约候选。
- [验收矩阵与Gate记录](validation.md)：承接38项验收，目前均未验证。
- [研究草稿](../../../research/thinking-generation-and-display-controls-design-draft.md)：讨论与来源，不再作为交付契约owner。
- [Development Workflow](../../../governance/development-workflow.md)：流程唯一权威。
- [既有采集与展示交付](../../archive/thinking-capture-and-display/plan.md)：实现基线，不重做或改写归档结论。

当前授权覆盖剩余Plan Item，但每步仍须满足自己的退出条件并提交后再进入下一步。
Plan接受不表示对应Gate已经通过。

## 2. 范围与非目标

范围：

- 公共模型reasoning能力、消息级策略、组合校验、不可变Turn绑定。
- Built-in逐模型可选能力、私有summary及Anthropic模式/预算适配。
- 原始消息策略持久化、History投影、Steering兼容判断。
- Responses/Chat effort映射、Anthropic原生Thinking/signature/redacted回放。
- Relay双协议Client/Router与discovery能力投影。
- Web能力驱动选择、模型切换兼容保留和历史策略摘要；CLI默认行为不变。

不做全局reasoning默认、Session策略继承、Display隐藏开关、通用请求模板、
新snapshot handle/策略存储/replay平台、跨协议opaque转换或隐式预算。
不改变store、服务端conversation或重试策略，不顺带实现其他Research需求。

## 3. 实施任务与依赖

| Plan Item | 状态 | 工作与owner边界 | 退出条件 |
|---|---|---|---|
| TGC-P0 契约准备 | Completed | 建立Plan/Spec/验收；核实私有adapter配置及协议证据边界 | 文档校验通过；所有者已接受Spec并批准TGC-P1 |
| TGC-P1 类型与能力校验 | Completed | Core类型及Extension导出；Provider Facts/Catalog/Runtime DTO；Built-in配置、深冻与静态一致性校验 | 聚焦、Unit、Integration、lint及build通过；所有者已确认完成 |
| TGC-P2 消息与Turn链路 | Completed | Channel/WebSocket入口、Runtime队列与解析、Runner正常调用与Steering；Session元数据及History | 原始选择与resolved策略分离；intake、不可变Turn、Steering、Compaction及恢复测试通过 |
| TGC-P3 Built-in协议闭环 | In Progress | Responses/Chat映射与私有summary；Anthropic生成、事件与replay codec | TGC-06–17、20、22、31相关fixture/恢复测试通过，默认请求不变 |
| TGC-P4 Relay双协议 | Not Started | discovery、私有模型绑定、独立Chat Client/Router、包发布清单及测试 | TGC-23–26、32、35相关测试通过；不导入Built-in私有模块 |
| TGC-P5 Web与收口 | Not Started | 控件与摘要、切模型校验、实时/历史回归；同步当前契约与架构 | TGC-27–28、30、33–34、38通过，完整验收与最终Gate有证据 |

依赖顺序：P0 → P1 → P2 → P3 → P4 → P5。每步先运行最小相关测试再继续；
契约测试的部分通过不代表整行验收或整体Change通过。
P1不把尚未完成codec的能力发布为可用；P3开始前固化Anthropic私有配置与fixture。
未知的模型接受性仅阻塞受影响映射，不阻塞已确定的公共类型或其他协议。

## 4. Gate

### G0：进入Delivery

- Spec经所有者接受，生产修改范围与首个Plan Item获批准。
- 字段owner、默认兼容、校验阶段及38项验收归属清楚。
- 首步只实现类型/配置/能力校验，不临时强制high或修改用户配置。
- 协议实现前准备有效请求、非法配置、默认不变、事件及工具续轮fixture。
- fixture的协议来源/版本可追溯；无法由官方依据及离线测试消除的接受性未知，
  按流程提出有界Spike，仅验证受影响路径。竞品源码不能代替真实协议保证。
- 不强制探测全部模型，不把后续协议专项扩大为首个类型步骤的全局门槛。

### G1：交付与接受

- [验收矩阵](validation.md)全部有结果与证据；未覆盖/限制显式列出并由所有者确认。
- 每步聚焦测试通过；跨边界Integration/Fitness及最终lint/build/Relay验证通过，
  如有既有失败，记录基线和影响，不冒充通过。
- Web通过自动契约测试及浏览器交互验收；包清单包含新增Extension运行文件。
- 所有公开路径无opaque/signature泄露，默认wire及CLI行为保持兼容。
- 独立评审、当前架构/稳定规格/Extension出口同步完成，再由所有者接受并归档。
- 本地真实模型调用仅在连接、合成输入和费用范围获确认后执行；文档创建不授权调用。

## 5. 风险与停止条件

- 新证据要求改变公共语义、来源owner或恢复边界时，暂停受影响步骤并重新确认。
- 没有已验证映射的能力不能仅凭配置或模型名称发布；不得静默降级。
- staging失败沿用现有rollback，保持旧generation；不新增恢复平台。
- Anthropic签名或预算假设被推翻时记录具体路径，不以删除必要块或猜数字掩盖。
- 若实施需要新的覆盖层、任意模板或通用适配框架，先回到范围边界，不直接扩建。

## 6. 当前状态

Specification已接受，TGC-P1和TGC-P2已实现并通过各自Gate；剩余Delivery已获授权，
当前执行TGC-P3。
