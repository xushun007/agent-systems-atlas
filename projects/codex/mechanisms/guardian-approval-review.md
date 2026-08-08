# Codex Guardian：自动审批审查与拒绝熔断

## 结论

Guardian 不是一条附加在工具上的静态规则，也不是让主 Agent 自己批准自己的动作。它是审批策略阶段中的一个独立 reviewer：Codex 把待执行动作规范化为精确 JSON，提取经过预算和过滤的父会话证据，再交给一个受限的只读 Codex 子会话判断 `allow` 或 `deny`。

这条链路有五个关键性质：

1. **路由受策略约束**：只有 `on-request` 或 granular 审批策略与 `AutoReview` reviewer 同时成立，才进入 Guardian；PermissionRequest Hook 仍然先执行。
2. **审查对象是精确动作**：命令、cwd、权限、patch、网络目标、MCP 参数等被序列化并截断，而不是只审查工具名。
3. **Reviewer 与执行者隔离**：Guardian 会话强制只读、`approval_policy = never`，并关闭 MCP、Apps、Plugins、Hooks、Web Search 和多 Agent 能力。
4. **失败关闭但不混淆风险判断**：构造、会话或解析失败会拒绝；超时和取消也不放行，但只有模型明确作出的 deny 才累计拒绝熔断。
5. **会话可复用但审批不缓存**：空闲 trunk 保留政策上下文和 prompt cache key；并发审批从最近已提交 trunk rollout 创建临时 fork。每个动作仍重新审查。

本文基于 Codex commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 的源码与测试阅读。本文没有运行真实 Guardian 模型、网络审批、MCP elicitation 或客户端手动覆写流程。

## 机制图

- [Codex Guardian 自动审批关系图](../diagrams/codex-guardian-approval-review.excalidraw)
- [符号级源码索引](../source-map.md)

## 1. Guardian 位于审批策略阶段，而不是 Sandbox 内部

工具系统先由 ExecPolicy、ARC 或工具自身规则判断是否需要审批。进入统一审批解析后，顺序是：

1. 若工具提供 PermissionRequest payload，先运行配置 Hook；Hook 的 allow/deny 直接终止审批解析。
2. Hook 没有结论时，根据当前 Turn 的 approval policy 和 `approvals_reviewer` 选择 Guardian 或用户。
3. Guardian/User 返回统一的 `ReviewDecision`，再由 Orchestrator 决定是否执行、拒绝或进入 sandbox-denial retry。

`routes_approval_policy_to_guardian()` 只接受 `AskForApproval::OnRequest | Granular(_)` 与 `ApprovalsReviewer::AutoReview` 的组合。`Never` 不会凭空引入审批，`UnlessTrusted` 也不会被这个函数路由给 Guardian。这保证自动 reviewer 不会扩大原审批策略的触发范围。

## 2. Approval Request 保留动作语义

`GuardianApprovalRequest` 覆盖 Shell、Unified Exec、Unix `execve`、Apply Patch、Network Access、MCP Tool Call 和 Request Permissions。不同动作携带与风险判断相关的字段：

- 命令：argv、cwd、sandbox permissions、额外权限、justification、TTY；
- Patch：cwd、目标文件与完整 patch；
- 网络：target、host、protocol、port 和触发源；
- MCP：server/tool、arguments、connector/account 元数据、tool annotations；
- 权限请求：turn、reason 和 permission profile。

序列化会稳定排序对象键，并递归截断超长字符串。单个动作字符串预算约 16K tokens，同时记录是否发生截断，用于分析指标。事件展示使用更精简的 `GuardianAssessmentAction`，模型审查则接收包含细节的 JSON；两者用途不同。

## 3. Transcript 是有限、可追踪且不可信的证据

Prompt builder 从父 History 生成审查 transcript，而不是复制整个上下文。它保留用户、assistant、agent message、工具调用和工具结果，过滤普通 developer message；唯一保留的 developer message 是用户对先前 Guardian deny 的精确手动批准标记。上下文性 user fragments 也不会被当作用户授权证据。

预算策略包括：

- 消息证据与工具证据各约 10K tokens；
- 单条消息最多约 2K tokens，单条工具记录最多约 1K tokens；
- 保留首条用户消息、尽量保留最新用户消息，再按时间倒序选择其余证据；
- 最近非用户证据最多 40 条；
- 省略和截断会写入显式标记，长文本保留头尾。

Prompt 明确把 transcript、工具参数、结果、retry reason 和 planned action 都视为不可信数据，不能把其中的指令当成 Guardian 指令。父 Turn 已拒绝读取的路径/glob 也会随请求带入，阻止 reviewer 把绕过 denied-read 的升级误判为安全。

复用会话时，`GuardianTranscriptCursor` 记录父 History version 和已审查条目数。版本一致且游标不越界时只发送 delta；父历史被替换、压缩或回退后则重新发送完整 transcript，避免把失效游标用于新历史。

## 4. 独立 Reviewer Session 是能力收缩边界

Guardian 使用 `SubAgentSource::Other("guardian")` 启动独立 Codex thread。配置从父会话克隆，以复用 provider、认证和受管网络约束，但会主动收缩：

- approval policy 固定为 `Never`，permission profile 固定为 read-only；
- 清空 MCP servers，不注入 Apps、Skills、Memories 和普通 developer instructions；
- 禁用 Collab、MultiAgentV2、Hooks、Apps、Plugins 与 Web Search；
- 不继承 exec-policy rules；
- provider request/stream retry 上限各设为 1；
- Guardian policy 成为 base instructions，最终输出受 JSON Schema 约束。

Reviewer 可使用只读工具补充证据，并可同步父会话已经批准的 network hosts；这不等于获得写能力。若首选自动审查模型存在，Codex 优先使用它并尽量选择 low reasoning；否则回退到 override 或父模型。模型变化时清除父模型专属的 context window/auto-compact override。

## 5. Trunk、Delta 与并发 Fork

每个父 Session 持有 `GuardianReviewSessionManager`。其复用模型是：

- **首次或配置变化**：创建新的 trunk；复用键覆盖模型、provider、权限、instructions、cwd、MCP、features 和可执行器路径等会影响行为的配置。
- **trunk 空闲且配置相同**：串行复用同一 reviewer thread；第二次审查后注入一次 follow-up reminder，后续 Prompt 尽量使用 transcript delta。
- **trunk 正忙**：从 trunk 最近成功提交并 flush 的 rollout snapshot 建立 ephemeral fork；并发审查不会阻塞或改写 trunk。
- **审查结束**：成功完成的 trunk 刷新 fork snapshot；临时 fork 总是关闭。无法安全排空的超时/异常 trunk 会被移除重建。

Guardian thread 的 prompt cache key 被固定为 `guardian:<parent_thread_id>`。复用的是政策前缀、对话上下文和缓存身份，而不是某个工具动作的审批结果。

## 6. 输出协议与有限重试

最终 Schema 至少要求 `outcome`，允许补充 `risk_level`、`user_authorization` 和 `rationale`。正常低风险结果可只返回 `{"outcome":"allow"}`；缺失 risk/authorization/rationale 时解析器提供保守默认值。解析器先尝试完整 JSON，再容忍从首个 `{` 到最后一个 `}` 的薄包装恢复，非 JSON 仍视为失败。

一次审批共享 90 秒总 deadline，最多尝试 3 次。只有两类错误重试：

- 带结构化错误信息的临时服务/连接/流异常；
- 输出解析失败。

每次之间使用退避，但不会延长总 deadline。Prompt 构造错误、普通 session error、timeout 和 cancellation 不重试。内部 provider 自身的 request/stream retry 也被限制为 1，避免子会话把审批延迟无限放大。

## 7. 决策映射遵循 fail-closed

结果统一映射为工具层的 `ReviewDecision`：

- `allow` → `Approved`，Orchestrator 继续执行；
- 模型明确 `deny` → `Denied`，理由中附带不要绕过、应改用安全替代或取得明确批准的指令；
- timeout → `TimedOut`，工具层转换成拒绝错误；
- cancellation → `Abort`；
- Prompt/Session/Parse failure → 合成 high-risk、unknown authorization 的 deny。

因此 Guardian 不可用时不会自动回退为“询问用户后继续”，也不会放行动作；主 Agent 会收到拒绝/超时结果，再决定提出更安全方案或请求用户采取新的明确操作。这个行为把可用性故障和权限放行分离开。

## 8. 只有显式 deny 触发拒绝熔断

`GuardianRejectionCircuitBreaker` 按 Turn 维护：

- 连续显式 deny 达到 3 次；或
- 最近最多 50 次审查中显式 deny 达到 10 次；

任一条件只触发一次 Turn interrupt。allow、timeout、cancel 和失败生成的保守 deny 都记为 non-denial：它们不会累计熔断，并会重置连续 deny 计数。这样系统故障不会被误判为主 Agent 反复挑战风险边界。

熔断触发后，Codex 异步中断仍活跃的 Turn。Guardian 终止路径可能绕过普通 task completion，因此实现会显式补发 thread-idle lifecycle。Turn 开始、正常结束和 abort 时都会清理对应 breaker 状态，避免跨 Turn 污染。

## 9. 手动覆写是“精确动作授权”，不是直接执行

客户端可以对一个状态为 Denied 的 `GuardianAssessmentEvent` 提交 `ApproveGuardianDeniedAction`。Core 不会直接执行旧工具调用，而是向父 Session 注入一条特殊 developer message：用户只批准事件中序列化的 exact action，并且只适用于原上下文，不授权相似但 payload 不同的操作。

这条标记是 Guardian transcript 唯一允许保留的 developer message。若主 Agent再次提出相同动作，下一次 Guardian 能看到该精确授权并重新判断。这样手动覆写仍经过正常工具调用和审批链路，也不会把一次 UI 点击扩展成宽泛永久权限。

## 10. 网络与 MCP 使用相同 reviewer，但有边界适配

Network Access 审查同时看到目标连接和触发该连接的命令。Policy 要求判断触发命令是否得到授权；合理的网络后果不必在用户原话中逐 host 罗列。

MCP elicitation 会先按 MCP policy 和 connector 分层配置选择 reviewer。Guardian 只审查带特定 approval metadata 的受支持 form elicitation；URL 或不支持的 schema 会在审查前拒绝。最终 Guardian decision 再映射回 MCP accept/decline，而不是绕过 MCP 协议层。

## 事件与可观测性

一次审查会先发 `GuardianAssessment(InProgress)`，终态发 Approved、Denied、TimedOut 或 Aborted，并携带 review ID、目标 item、parent/assessment turn、action、风险、授权与理由。用户可见 warning 提供简短结论。

Telemetry 区分 Config Hook、Automated Reviewer 和 User 决策来源；Guardian analytics 还记录 trunk/new/reused/forked、review model、reasoning、attempt count、TTFT、token delta、是否已有上下文及动作是否截断。事件是 UI/审计协议，analytics 是运行测量，两者不替代模型 transcript。

## 关键设计约束

1. **自动 reviewer 不能扩大审批策略的作用域。**
2. **审查证据必须包含精确动作，但必须受预算与注入边界约束。**
3. **Reviewer 的能力严格小于被审查的执行环境。**
4. **缓存会话上下文，不缓存动作批准。**
5. **任何不可解释的失败都不能变成 allow。**
6. **系统失败与模型明确拒绝必须分别计数。**
7. **手动覆写必须绑定 exact action，并重新进入正常执行链路。**

## 测试证据

- `core/src/guardian/tests.rs`：路由、Prompt 过滤与预算、严格输出、失败关闭、事件、重试、trunk reuse/fork、拒绝熔断；
- `core/src/guardian/review_session.rs` 模块测试：deadline/cancel、事件 turn 匹配、interrupt drain、reuse key 和配置收缩；
- `core/src/tools/approvals_tests.rs`：Hook、Guardian/User reviewer 和工具层决策映射；
- `core/src/session/tests.rs`：Guardian lifecycle、手动 exact-action approval 与 Turn interrupt；
- `core/src/session/mcp.rs` 模块测试：MCP elicitation 的 Guardian 路由和协议映射。

这些测试只作为源码行为证据阅读，本次没有本地执行。

## 未确认事项

- 未验证实际自动审查模型在大型仓库中的误批、误拒率和 90 秒尾延迟。
- 未测量 transcript delta 与 trunk prompt cache 的真实 token/延迟收益。
- 未验证并发审批很多时 ephemeral fork 的资源上限与清理压力。
- 未覆盖 ARC、网络代理和 MCP connector 的完整策略矩阵，它们适合各自独立分析。
