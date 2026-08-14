# Codex 权限控制面：配置约束、Profile 投影与运行时收敛

## 结论

Codex 的权限不是一个 `sandbox_mode` 开关，而是一条分阶段收敛的控制链：普通配置层先决定用户请求的值，企业 requirements 再限定允许空间或强制回退，权限 Profile 编译为文件系统与网络策略，Session/Turn 固化快照，最后 Sandbox Manager 和审批系统消费这份有效权限。

这套设计的核心是不让“更高优先级配置”绕过“管理约束”：

1. **Config 与 Requirements 双轨处理**：前者按优先级覆盖，后者单独组合、保留来源，最后施加到有效配置。
2. **约束跟随值进入运行期**：`Constrained<T>` 不只在启动时校验；Session 内切换审批策略或权限 Profile 时仍调用同一 validator。
3. **PermissionProfile 是 canonical 表示**：文件系统、网络和 sandbox enforcement 组合在一个 Profile 中，旧 `SandboxPolicy` 只是兼容投影。
4. **限制具有黏性**：managed `deny_read` 跨 requirements 层取并集，并在 Profile 回退、Session 切换、legacy bridge 和附加权限中保留。
5. **平台执行只消费最终投影**：workspace roots 物化、网络 proxy constraints、additional permissions 和平台 sandbox 都在执行前从有效 Profile 推导。

本文基于 Codex commit `7750465934d97dd3cbcb3b1655d2f622744010d3` 的源码与测试阅读。本文没有运行不同操作系统的 sandbox、企业 MDM/cloud bundle、网络代理或动态权限切换实验。

## 机制图

- [Codex 权限配置与运行时收敛关系图](../diagrams/codex-permission-configuration.excalidraw)
- [符号级源码索引](../source-map.md)

## 1. 普通配置层与管理要求是两个平面

`ConfigLayerStack` 按低到高优先级保存普通配置：MDM、System、Enterprise Managed、User、User Profile、Project、Session Flags，以及兼容的 legacy managed 层。`effective_config()` 只把启用层依次 TOML merge；同一字段后层覆盖前层，嵌套 table 递归合并。

Requirements 不混入这次覆盖。它们从 system requirements、MDM、enterprise bundle 等来源单独加载，组合成 `ConfigRequirements` 和原始 `ConfigRequirementsToml`，再与 layer stack 一起保留。这样系统可以同时回答：

- 用户最终配置了什么；
- 管理方允许什么、强制什么；
- 冲突来自哪个 requirement source。

普通 exact requirement 会在 `requirements::apply_to_config()` 中覆盖对应配置并产生 source-aware startup warning。允许集合则被编译成 `Constrained<T>`，在后续构造和动态更新中继续生效。

## 2. Requirements 组合不是所有字段都“高层覆盖”

大多数字段沿用 TOML 低到高 merge；几个安全字段有独立语义：

- exec prefix rules 和 managed hooks 按高优先级在前追加；
- hook 目录冲突 fail closed；
- `permissions.filesystem.deny_read` 从高到低扫描并去重取并集；
- source 不同的 deny-read 会形成 composite provenance；
- network/filesystem、MCP、plugins、features 和 residency 保留各自约束结构，而不是压平成普通 config。

因此低优先级企业层声明的私密路径不能被高优先级项目层“覆盖为空”。Deny-read 的加法语义是整个权限体系最重要的不变量之一。

## 3. Constrained 将值与 validator 绑定

`Constrained<T>` 同时持有当前值、validator 和可选 normalizer。它支持：

- `allow_any`：不限制候选值；
- `allow_only`：固定为单值；
- `new`：用 allowed set/source-aware validator 初始化；
- `normalized`：设置前先把值收敛到合法形态；
- `add_validator`：在已有约束上叠加新的安全条件；
- `set`：normalize 后重新校验，通过才替换当前值。

`ConstrainedWithSource<T>` 再记录 requirement 来源，使错误能指出候选值、允许集合和管理来源。审批策略、reviewer、permission profile、web search、Windows sandbox、residency 等都使用这套容器。

这比“启动时验证一次”更强：Session settings update 调用 `approval_policy.set()` 或安装新的 Profile snapshot 时，约束仍在对象里，不能通过运行时 API 绕过。

## 4. Profile Catalog 先解决身份，再编译能力

Codex 提供内建 Profile：`:read-only`、`:workspace`、`:danger-full-access`，也允许 `[permissions.<name>]` 定义 named profile，并通过 `extends` 继承只读/工作区基线。Profile 可以声明：

- filesystem entries：特殊路径、绝对路径、glob 及 read/write/deny；
- profile workspace roots；
- network enabled 与 proxy/domain/socket 配置；
- description 和 parent identity。

`permission_profile_catalog()` 合并用户与 managed profile 定义，并为每项计算 `allowed`。判断同时考虑 profile ID allowlist、sandbox mode constraint 和 managed deny-read：存在 deny-read 时，danger-full-access/external sandbox 不允许被选择，因为它们无法保证读取限制。

`resolve_default_permissions()` 处理 CLI override、配置默认值和 requirements 默认值。若用户选择不在 allowed list 中，不会静默保留宽权限，而是警告并回退到管理方默认 Profile；非法 catalog/default 组合会直接拒绝启动。

## 5. Profile 编译为文件与网络两个运行时平面

Named profile 先解析继承，再由 `compile_permission_profile_selection()` 编译：

- filesystem entries 转为 `FileSystemSandboxPolicy`；
- `:workspace_roots` 等特殊项延迟到已知 workspace roots 后物化；
- glob 能力按平台检查，非 macOS 对部分 read/write glob 和无界 deny glob 给出警告；
- network 部分编译为 `NetworkSandboxPolicy`，proxy 的域名/端口/Unix socket 规则留在 `NetworkProxyConfig`；
- profile workspace roots 相对 policy cwd 解析为绝对路径，但与 Turn 选择的 runtime roots 分开保存。

最终 `PermissionProfile` 保存 sandbox enforcement、文件策略和网络开关。`PermissionProfileState` 还把 concrete profile、active profile ID/extends 和 profile roots 原子绑定，避免“显示选中了 A，实际权限却来自 B”。

## 6. Managed 限制在最终 Config 构造时收敛

`Config::load_config_with_layer_stack()` 的权限主路径是：

1. 合并普通 config，解析 CLI/harness overrides；
2. 选择 legacy sandbox 语法、直接 Profile 或 named `default_permissions`，互斥输入同时出现直接报错；
3. 编译初始 PermissionProfile；
4. 用 requirements 对 approval policy、reviewer 和 Profile 调用 `apply_requirement_constrained_value()`；
5. 若 managed deny-read 存在，给 Profile constraint 追加 validator；
6. Profile 被迫回退时清除 active profile identity 和 profile roots；
7. 把原 Profile 的 deny-read、managed filesystem constraints 和 Codex helper readable roots加入有效文件策略；
8. 构造受 managed network constraints 限制的 `NetworkProxySpec`；
9. 把最终 Profile 安装进 `Permissions`。

一个关键 fail-fast 场景是：用户选择 danger-full-access + `approval_policy=never`，requirements 又把 Profile 回退为 read-only。Codex 不接受“只读但永不审批”这个不可工作的组合，而是要求用户改审批策略或选择允许的 sandbox mode。

## 7. Workspace roots 在运行时物化，不写死进 Profile

Canonical Profile 可以包含 `:workspace_roots` 符号项。`Permissions::effective_permission_profile()` 和 SessionConfiguration 在已知当前环境 roots 后调用 materialize，把符号写权限映射为具体绝对路径。

Profile 自带的 roots 与 Thread/Turn 选择的 roots 分开保存：前者是 profile 定义的一部分，后者来自 cwd、CLI、环境选择或额外 writable roots。这样环境切换可以重绑 `:workspace_roots`，又不会篡改 named profile 身份。

Codex 自己运行所需的 helper 路径会作为 additional readable roots 加入，但不会出现在 user-visible workspace roots 中；这是运行依赖，不是授权用户写入的新根。

## 8. Session 动态切换仍走约束与投影

`SessionConfiguration::apply()` 在每个新 Turn 前应用 `ThreadSettingsOverrides`：

- approval policy 使用保存的 `Constrained` validator；
- concrete permission profile 与 active profile metadata 一起安装；
- 切换 named profile 时重算 network proxy spec；
- legacy sandbox update 先桥接回 PermissionProfile；
- cwd-only 更新只有在现有策略确实是 cwd-bound legacy projection 时才重算；rich split policy 不被降级；
- 新 Profile、legacy bridge 和 cwd rebind 都保留现有 deny-read。

更新成功后生成新的 `TurnContext` 快照。旧 Turn 持有旧 Arc/值，不会被中途修改；新设置通过 `ThreadSettingsApplied`、TurnContext Rollout 和 World State 进入后续运行与恢复。

## 9. TurnContext 同时服务执行、模型和持久化

TurnContext 固定当前 approval policy、PermissionProfile、network proxy 和环境。它提供三种投影：

- `file_system_sandbox_policy()` / `network_sandbox_policy()`：运行时 split policy；
- `sandbox_policy()`：给仍使用 legacy API 的兼容投影；
- `to_turn_context_item()`：写入 Rollout，必要时额外保存无法由 legacy policy 等价表达的 filesystem policy。

World State 的 permissions/environment sections 把审批规则、workspace roots、文件限制和 managed network allow/deny 以 developer context 告诉模型。模型看到的权限说明是当前有效能力的描述，不是约束本身；真正 enforcement 仍在工具与 sandbox 边界。

## 10. NetworkProxySpec 叠加配置、要求和动态审批

`NetworkProxySpec` 保存 base config、managed requirements、有效 config 和 proxy constraints。Requirements 可以固定 enabled/ports/upstream proxy/local binding，并约束 domain 与 Unix socket 列表。

Managed sandbox active 时，用户 allow/deny list 可在许可范围内扩展；`managed_allowed_domains_only` 则把未命中 allowlist 的请求硬拒绝，不能通过 approval flow 扩展。非硬拒绝场景可配置 policy decider，把 blocked request 交给网络审批/Guardian；exec policy 的网络规则也可在 constraints 校验后叠加。

Profile 切换会用 base config 和同一 requirements 重新计算 spec，并热更新已启动 proxy state。这避免切换文件权限时意外保留旧网络能力。

## 11. Additional Permissions 只能临时扩展，不能抹掉限制

启用相应 Feature 后，工具可以请求 `AdditionalPermissionProfile`。输入先规范化：路径尽量 canonicalize，重复项去除，非 deny 的 glob grant 被拒绝，空 Profile 被丢弃。它必须与 `sandbox_permissions=with_additional_permissions` 配套并经过审批。

Sandbox 前将已批准附加权限与 base Profile 合并：restricted filesystem 增加具体 entries，network 可从 restricted 临时变为 enabled；unrestricted/external filesystem 不需要再扩展。合并和交集逻辑保留 base/granted 两侧的约束性 deny entries，不能用一次审批读出 managed 私密路径。

最终 `SandboxManager::transform()` 根据 effective Profile 选择 Seatbelt、Linux sandbox、Windows restricted token 或 external/no sandbox，并把 network policy 与 managed proxy参数一起交给平台执行层。

## 关键设计约束

1. **配置优先级不能等价于安全优先级**：requirements 独立于普通 override。
2. **约束必须随值传播**：运行时更新不能绕过启动校验。
3. **Profile 身份、能力和 roots 必须原子一致**。
4. **deny-read 只能保留或增加，不能在投影中丢失**。
5. **legacy SandboxPolicy 是兼容输出，不是 canonical 权限来源**。
6. **模型权限说明与平台 enforcement 必须来自同一 Turn 快照**。
7. **临时附加权限必须显式、可审批且不能削弱管理限制**。
8. **网络策略切换必须重新经过 managed proxy constraints**。

## 测试证据

- `config/src/state_tests.rs`、`merge_tests.rs`：配置层顺序、递归 merge、origin；
- `config/src/requirements_layers/stack_tests.rs`：requirements precedence、rules/hooks 与 deny-read union；
- `config/src/config_requirements.rs`、`constraint.rs` 模块测试：allowed sets、source-aware error 与 runtime set；
- `core/src/config/config_tests.rs`、`permissions_tests.rs`、`network_proxy_spec_tests.rs`：Profile 选择/回退、managed filesystem/network 和 legacy bridge；
- `core/src/session/tests.rs`：Thread settings、cwd rebind、deny-read 保留、TurnContext persistence；
- `sandboxing/src/policy_transforms_tests.rs`、`manager_tests.rs`：additional permissions 与平台 sandbox transform。

这些测试只作为源码行为证据阅读，本次没有本地执行。

## 未确认事项

- 未验证 macOS Seatbelt、Linux Landlock/seccomp 和 Windows restricted token 对同一 Profile 的实际等价性。
- 未运行 MDM、enterprise cloud bundle 与多 requirements layer 的真实加载流程。
- 未验证 managed proxy 的动态 approval、MITM 和 Unix socket 策略。
- 未测试复杂 glob、symlink、missing-path behavior 与跨环境 workspace roots 的边界组合。
