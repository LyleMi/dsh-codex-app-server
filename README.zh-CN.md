# dsh-codex-app-server

[English](README.md)

这是一个实验性的 DeepSeek Harness 插件包。它通过 `codex app-server --stdio` 启动官方 Codex CLI，并将其作为 DSH 的 `AgentFactory` 使用。

本插件不会读取 Codex 凭据、把 ChatGPT 订阅换成 API Key，也不会调用 ChatGPT 私有接口。身份验证、模型权限、配额、Codex 原生工具、MCP 与 Codex 沙箱均由用户安装的官方 CLI 管理；DSH 工具仍在 DSH host 内通过其自身策略链执行。

> 当前版本为 `0.1.0-beta.0`。请先在独立的 DSH profile 中试用，并阅读下方限制。本项目不受 DeepSeek 或 OpenAI 官方认可或背书。

## 兼容性

| 组件                | 已验证基线                   | 兼容策略                              |
| ------------------- | ---------------------------- | ------------------------------------- |
| Node.js             | `22.22.3`                    | `>=22.19.0`                           |
| DeepSeek Harness 包 | `0.1.0-rc.6`                 | peer range `^0.1.0-rc.6`              |
| Cordis              | `4.0.1`                      | peer range `^4.0.1`                   |
| Codex CLI           | `0.147.0`                    | 握手和协议 fixture 已基于此版本验证   |
| Reforge             | `0.2.0`                      | CI 会校验固定源码 revision 的实际版本 |
| 平台                | Ubuntu、Windows 协议/argv CI | Ubuntu 已完成真实本地 smoke test      |

App Server 协议仍在演进。未知的 server request 会按失败关闭处理，因此 Codex 升级后可能会中止 turn，而不是默默接受语义变化。

## 无需下载源码即可安装运行

先安装官方 Codex CLI 并完成登录，确认同一运行环境中 `codex` 可用；Windows 对应命令是 `codex.cmd`。

DSH CLI 的完整 npm 包名是 `@deepseek-ai/dsh`。npm 上不带 scope 的 `dsh` 是另一个无关项目，请勿安装。

使用 `npx` 一次性运行：

```sh
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- dsh plugin --profile web add dsh-codex-app-server
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

或者通过 npm 全局安装：

```sh
npm install --global @deepseek-ai/dsh@0.1.0-rc.6
dsh plugin --profile web add dsh-codex-app-server
dsh web
```

profile 会保存在常规 DSH home 目录中，后续启动无需重复安装插件。检查最终配置：

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --profile web --dump-config
```

配置中应显示 `agent-loop` 已禁用，并且存在一项已启用的 `dsh-codex-app-server`。patch 会保留 profile 原有的 session 持久化、UI、ACP/JSON-RPC、文件系统、子进程、权限及沙箱 provider。

## 配置

通过常规 Cordis profile overlay 配置插入的 `dsh-codex-app-server` 项。

| 字段                        | 默认值                             | 含义                                                       |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `command`                   | `codex` / `codex.cmd`              | 官方 Codex 可执行文件；Windows 自动使用 npm 的 `.cmd` shim |
| `args`                      | `[]`                               | 仅允许 `--strict-config`、`--enable=…` 和 `--disable=…`    |
| `model`                     | Codex 账户默认值                   | DSH 尚未选择 Codex 模型时的后备值                          |
| `reasoningEffort`           | 所选模型默认值                     | 可选、向前兼容的 effort 后备值                             |
| `sandboxMode`               | `workspace-write`                  | `read-only`、`workspace-write` 或 `danger-full-access`     |
| `approvalPolicy`            | `on-request`                       | `untrusted`、`on-request` 或 `never`                       |
| `networkAccess`             | `false`                            | 每个 turn 的沙箱网络访问权限                               |
| `startupTimeoutMs`          | `15000`                            | 初始化握手超时                                             |
| `requestIdleTimeoutMs`      | `120000`                           | JSON-RPC 请求超时                                          |
| `turnIdleTimeoutMs`         | `120000`                           | turn 空闲多久后执行中断与进程恢复                          |
| `interruptGraceMs`          | `3000`                             | 中断后等待进程恢复的宽限时间                               |
| `disposeGraceMs`            | `5000`                             | 强制终止进程树前的宽限时间                                 |
| `stderrMaxBytes`            | `65536`                            | 经过脱敏且有大小上限的诊断缓冲区                           |
| `protocolMaxBytes`          | `8388608`                          | JSONL 单帧最大大小                                         |
| `unknownNotificationPolicy` | `ignore`                           | `ignore`，或用 `fail-turn` 使当前 turn 失败                |
| `bindingRoot`               | `~/.dsh/codex-app-server-bindings` | 插件持久化线程映射的目录                                   |

安装该 bundle 会把目标 DSH profile 变成 Codex 专用 profile。组合补丁会禁用基础 Agent loop、普通 DeepSeek/pi-ai LLM adapter 和依赖 LLM 的标题生成器，但不会删除用户设置；这些 provider 在未安装本 bundle 的其他 profile 中仍然可用。profile 中保留的 `codex-app-server` provider 只提供目录，DSH Web 模型选择器的数据来自官方 App Server 针对当前登录账户返回的分页 `model/list`，并包含各模型支持的 reasoning effort。首次发现目录时，如果 DSH 默认值仍是遗留的非 Codex provider，会改为 Codex 声明的默认模型。已有 session 若仍保留 foreign provider 选择，会明确拒绝，而不会静默按 Codex 执行。在 DSH 中选定的 Codex 模型与 effort 会在每个 step 快照，并传给 `thread/start`、`thread/resume` 和 `turn/start`；目录 adapter 本身不承载对话流量。

Assistant 文本与 reasoning delta 会在到达时立即追加到 DSH Session。Codex 执行 item 会投影为标准的、带命名空间的 tool-call/result 轨迹，并保留完整 started/completed payload 与已审核的中间更新。Plan 快照会驱动 DSH todo 状态，plan explanation 与 turn diff 则保留为可回放的 Codex provenance reasoning。

连接前及每个原生 turn 前，provider 会组装当前 agent scope 的 DSH prompt、运行时 context 与工具 schema。Prompt section 通过 App Server `developerInstructions` 注入，不覆盖 Codex base instructions；工具统一注册到 `dsh` 动态工具 namespace。收到 `item/tool/call` 后，桥会用未改写的 Codex `callId`、agent scope、arguments 和 turn 取消信号调用 `ctx.tools.execute`，因此 DSH 参数校验、guard、审批策略、skill/subagent、Cordis 工具和结果渲染仍是权威实现。Prompt 或工具快照变化时，会在下一 turn 前有界重启进程并精确 `thread/resume`。

所有权刻意分层：Codex 拥有内建工具、MCP/apps、原生 collaboration/delegation、Codex skills、rollout 与原生历史压缩；DSH 拥有 `dsh.*` 执行、DSH skills、subagents/workflows、Cordis 动态包及其审批审计。Bundle 会用 `thread/compact/start` 替换 DSH `/compact`，因为只压缩投影出来的 DSH Session 并不会改变模型实际读取的 Codex rollout。

用户 prompt 不会进入进程 argv。默认沙箱不允许联网。缺少 DSH 审批或提问 provider 时会保守拒绝或返回空答案。由于 DSH rc.6 尚无匹配的安全交互接口，secret 与明确标记为非阻塞的 Codex 问题也不会被回答。

## 生命周期与持久化

每个活跃 DSH Agent 拥有一个 Codex 进程和一个非临时 Codex thread。只有 setup、连接和持久化 binding 全部完成后才会发布实例；失败时会逆序回滚 registry、session 与进程所有权。恢复 session 需要 DSH session 持久化，以及完全匹配的 `{session, thread, cwd fingerprint}` binding；缺失或不匹配时不会创建一个丢失上下文的新 thread。Codex 要到首个 model step 才会落盘 rollout，因此仅当 App Server 明确报告 rollout 不存在，且持久化 DSH session 没有 lineage 或 seed、从未记录 `step/start` 时，插件才会新建 thread 并替换 binding。这包括在 Codex 收到请求前就失败的 turn；任何已进入 model step 的 session 仍然 fail closed。

活跃 turn 必须持续产生相关 App Server 活动。超过 `turnIdleTimeoutMs` 后，driver 会请求中断；若在 `interruptGraceMs` 内仍未结束，它会关闭 transport、终止进程树，并在下一 turn 精确恢复原 thread。显式中断使用同一套有界恢复流程。

DSH fork 总会创建新 Codex thread。首个 turn 最多接收 64 KiB 从 fork seed 投影出的文本和 reasoning；后续 turn 依赖新的原生 thread，不会重复 seed。

## 本地开发与测试

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Reforge 0.2.0 与覆盖率是必需 gate。Codex 基线变化后运行 `pnpm protocol:check`。真实 smoke test 为可选项，不读取凭据文件：

```sh
RUN_REAL_CODEX=1 pnpm test:e2e
```

## 已知限制

- 安装 DSH attachment store 后支持用户图片；文本、reasoning 和图片可以作为输入，tool-call 与 tool-result block 会被拒绝，避免错误翻译语义。
- Codex 0.147.0 中 App Server dynamic tools 仍属 experimental；升级协议后必须重新执行协议检查、桥接测试与真实 smoke。
- Cordis 动态包如果在一个 Codex turn 运行期间新增 prompt section 或工具，要到下一个原生 turn 才会可见；App Server 当前没有 turn 内替换 dynamic tools 的操作。
- DSH 工具返回的 `additionalContexts` 会放入该 dynamic-tool response；`concludesTurn` 会告知 Codex，但无法强制原生 turn 立即停止。
- DSH question service 当前仍不会追加持久的提问审计事件对。
- MCP elicitation 暂不支持。
- 每个 Agent 同时只允许一个活跃 Codex turn，原生 steering 会串行进入该 turn。
- DSH 与 Codex 必须在同一主机执行环境中，且该环境能访问用户的 Codex 安装和登录状态。
- Ubuntu 已完成真实 Codex smoke test；Windows 已覆盖 argv、协议、生命周期与 package 行为，但稳定版发布前仍需凭据隔离的真实 smoke test。

更多信息见[设计说明](docs/design.md)、[安全模型](docs/security.md)、[贡献指南](CONTRIBUTING.md)和[安全问题报告](SECURITY.md)。

## 许可证

Apache-2.0。用户仍需自行遵守适用于其 Codex/OpenAI 和 DeepSeek Harness 使用场景的条款。
