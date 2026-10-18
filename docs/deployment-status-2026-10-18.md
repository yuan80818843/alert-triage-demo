# 云端部署状态（非正式验收报告）

检查日期：2026-10-18。服务器 121.40.118.37，ecs-user，SSH 22。

## 最新同步（本轮）

- 本轮通过临时 SSH 部署密钥完成受限同步；归档排除了 `.env`、provider 数据、运行目录、日志、报告、`node_modules` 和自动接收 unit。
- 首次重导入发现 Windows 归档丢失 Linux 可执行位，且入口 shebang 为错误形式；已修正为 `/usr/bin/env node`，显式 `chmod +x` 后重新导入。
- 本轮 OctoBus 导入后的 service package SHA256：`01f7d1c9dbe418cee037d7e53332e9ec3c0ff7f9e72f9ac3e2a9271a541e47cb`；此前 `cae75f...` 为历史导入记录。
- 现有 `alert-platform-demo` instance 保持同一 upstream、timeout 和 page size，并增加 `evaluationTime=2026-10-18T04:00:00Z`；config SHA256：`2568e338b62fb859ce4f4926612ee95c7e68560ae9b83409acc43b523c05f2a0`。该字段只用于 synthetic replay 稳定性。
- 三类 Connect smoke 全部通过：ALT-001 `REAL_ATTACK`、ALT-002 `SUSPECTED_FALSE_POSITIVE`、ALT-003 `INSUFFICIENT_EVIDENCE`，以及 read-capset 写拒绝 HTTP 404。
- 已同步 Node 12 兼容的只读 console、简化前端和一键手动接收脚本；console health、首页和 `/api/reports` 均已验证。最近 scheduler 失败原因为 provider HTTP 402 `Insufficient Balance`，不是 service 回归。
- 最新 sandbox 能力 smoke：4 / 4；隔离与凭据检查：12 / 12；scheduler inspect 仍显示 `enabled=true`、`trigger_count=2`，未触发新任务。
- 本轮服务器归档和本机临时私钥副本已清理；服务器原有考官公钥保留。

## 已验证

- 官方 agent-compose daemon / guest 同一 commit sha-70bfd0b；镜像 digest 见 README。
- 新数据目录 agent-compose-data-70bfd0b，旧数据目录和 OctoBus volume 保留。
- 项目 ID 8014c6ac07b7，scheduler ID 06ccf445494b；用户确认每分钟演示后，scheduler.enabled=true、interval=1m。
- 当前官方 sandbox 的网络只有 alert-triage-demo-00-sandbox，internal=true。
- systemd mock / console 均 active、enabled，端口不开放公网。
- 考官公钥记录数 1；SSH 目录 700、authorized_keys 600。

## 实际执行记录

### 本地回归

- node --test tests/*.test.mjs：39 / 39 通过（含结构化规则边界、输入校验、跨页分组、只读报告投影、重复处置幂等、跨进程证据锁和报告接收测试）。
- python -m unittest discover -s tests -p test_configure_model.py：3 / 3 通过。
- 以上 Python 凭据仅为明确的假值，不调用外部模型。

### 云端 OctoBus Connect

2026-10-18T13:09 UTC 重新完整导入业务 package、固定回放时间并重启 mock 后运行 tests/cloud-smoke.mjs：

| 用例 | 实际结果 |
| --- | --- |
| ALT-001 | REAL_ATTACK，6 条证据，PASS |
| ALT-002 | SUSPECTED_FALSE_POSITIVE，7 条证据，PASS |
| ALT-003 | INSUFFICIENT_EVIDENCE，2 条证据，PASS |
| read-capset-denies-write | HTTP 404，PASS |

service package SHA256：cae75f870c74c2a100d0a1c718c690c32bd3f8dfdb25399a6c5bb1faef58ba07。
审计中存在相应 QueryEvidence HTTP 200 与 CreateDisposition HTTP 404，未创建成功处置。

### 官方 sandbox 隔离

诊断 sandbox 8fdb2e1e1d97，run 0a77c16f571f，12 项检查全部通过：

- capability proxy 7411 可达。
- 直连 octobus:9000、172.17.0.1:8081、1.1.1.1:443 均失败。
- 直连 100.100.100.200:80 和 169.254.169.254:80 均失败。
- daemon 管理 RPC 无凭据返回 HTTP 401。
- CAP_TOKEN / CAP_GRPC_TARGET 存在（未记录值）。
- AGENT_COMPOSE_AUTH_TOKEN / OCTOBUS_ADMIN_TOKEN 不存在于 guest。
- workspace 根存在 output-schema.json。

检查仅覆盖选定目标，不构成全网络/恶意 root 容器逃逸安全证明。

### 官方 sandbox 能力链路

agent/capability-smoke.py 经真实 gRPC metadata、server reflection 和 capproxy 调用：

- ALT-001 / ALT-002 / ALT-003 的只读能力调用成功，gRPC OK；脚本不向模型提供预期分类。
- 选择未授权 triage-human-write 调用 CreateDisposition 返回 PermissionDenied。
- 共 4 / 4 通过；未使用 LLM，未绕过 OctoBus，未成功写入。

### 真实 DeepSeek 研判与独立接收

用户已在服务器本地配置 Key，无需再次提供。provider triage-deepseek 使用 https://api.deepseek.com、原生 responses 协议。Chat Completions 在工具调用后出现 reasoning_content 缺失，已通过公开 UpdateProvider 改协议，保留原 Key。

用户配置的 model ID 为 deepseek-v4-flash；官方兼容旧 ID 实际路由至 V4.1 Flash-1017，不将其称为旧模型本体。官方协议与模型说明链接见 README。

以下报告均由真实 Agent 工具调用产生，经 scripts/collect-agent-report.mjs 独立接收，accepted=true：

| 告警 | 内层 Agent Run ID | 分类 | 置信度 |
| --- | --- | --- | --- |
| ALT-001 | ca2a70e190fef0093f266b3c7b7a3b43b220f30f0ffbecfd5204c3f86df58af9 | REAL_ATTACK | 0.94 |
| ALT-002 | 3522463e757949567bd675341c2246de1d64903431116e33ed468b733a805289 | SUSPECTED_FALSE_POSITIVE | 0.91 |
| ALT-003 | b19e0ee7026f063a41ca4776639f7fd56b88b27eac8830821e8f0c7a35a1450f | INSUFFICIENT_EVIDENCE | 0.59 |

报告接收使用完整 Ajv 2020 Schema 和独立 OctoBus 读取，检查实际 run_id、证据 ID/source/method/time/fact、案例 ID、分类、规则、缺失项、人审、置信度上限和安全动作。报告存于服务器项目 reports/<run-id>.json，目录 700、文件 600，不含原始 transcript。置信度是规则约束的 Demo 分值，不是经过统计校准的概率。

该流程是显式后处理，不是 scheduler 自动接受回调。独立快照为运行后读取，在本 Demo 不可变合成数据下适用；审计按运行时间窗口匹配，只证明窗口内有对应真实 gRPC 调用，不等同严格逐调用 run ID 归属。

### Scheduler 手动触发

两种手动触发均通过；当时持续自动调度尚未启用：

| 手动触发 | 外层 Scheduler Run ID | 内层 Agent Run ID | 接收结果 |
| --- | --- | --- | --- |
| alert-event，payload alert_id=ALT-003 | adbbac4e60b85a62e01ca062f50a41b6f7b3df86cb3fc774155fe76a716bacf4 | dbeb3b4d565fd3b976cf004f3bea82af1252aa8ef6b2453857995eef7d1bf968 | INSUFFICIENT_EVIDENCE，accepted=true |
| alert-poll | 46dfccb242ed8e350507598bcd9233d71003967e73ae3ac3343c59f0f336bfaa | 01aadfd9b05382430323c2bc9ae8f71329554c17d48ae72ae8c634a8045fd3a8 | REAL_ATTACK，accepted=true |

这验证了官方 scheduler 的手动 trigger 执行和内层 Agent，不等同后台 interval 自动执行或 event bus 自动投递。手动验证阶段通过 scheduler inspect 核实 enabled=false、trigger_count=2；之后用户授权启用，见下节。未执行任何成功写操作。

### 每分钟真实自动触发

用户明确选择「每 1 分钟，便于面试演示」后，只修改公开 YAML 的 scheduler.enabled=true，interval 保持 1m，使用官方 up 应用。远端原配置备份为 agent-compose.yml.before-enable-20261018；未重建 daemon 或删除数据。随后 inspect 显示 scheduler 与 alert-poll trigger 均 enabled=true。

- 首次自动外层 Run：eddca22e8d0dfbe576d5478dff0cc4d97d13fe375c12be31aaa2db75ac7b1b61。
- 平台 trigger_source=interval:60000，2026-10-18T12:09:30.086Z 开始，12:10:04.268Z 成功结束。
- 内层 Agent Run：80ac2cfc73619c325b03a0240c4140166165a74801d3a0426419301648431b98。
- 显式执行接收脚本：ALT-001 / REAL_ATTACK / confidence=0.94，accepted=true、errors=[]。
- 下一次自动任务在 12:10:30.084Z 开始，证明不是仅运行了一次手动 trigger。

自动运行仍只持有 triage-read，不允许处置写入。运行结果由平台持久化，但独立 accepted 报告仍需显式执行 collector，尚非全自动接受闭环。轮询当前取一条告警，合成数据不变时可能反复处理 ALT-001；本地 collector 已对相同告警/证据集合做跨 run 幂等拒绝，并以跨进程证据锁保护“检查后写入”窗口。启用期间会持续产生模型费用，演示结束按 README 将 enabled 设为 false 并重新 up。

### 联调期间拒绝与修复

- Agent 测试运行曾打印自己的临时 CAP_TOKEN；对应 sandbox 已通过官方命令移除并撤销授权。原始记录不导出，后续提示词禁止打印凭据，接收器发现相应输出会拒绝报告；不将提示词视为绝对防泄漏保证。
- 误报报告曾建议 SUPPRESS_PENDING_REVIEW，被接收门禁拒绝；改为 HOLD_FOR_REVIEW，不能先抑制后审批。
- 模型曾填错 run_id，被独立校验拒绝；只读 helper 现在返回上游注入的 AGENT_COMPOSE_RUN_ID，由模型原样复制。上游依据：D:/面试2/agent-compose/pkg/runs/prompt_attach.go:101。

## 尚未验证 / 缺口

### 本轮同步补充（2026-10-18）

- 已将最新 `alert-platform` service package 重新导入云端；OctoBus 自动重启 `alert-platform-demo` instance，5 个方法均重新编译提交。云端 cloud-smoke 4 / 4 通过：ALT-001、ALT-002、ALT-003 及 read-capset 写拒绝。
- 已同步只读 console 的报告列表/详情投影、简化前端和 `collect-latest-agent-report.mjs`。宿主 Node 12 不支持可选链语法，已在 console、报告存储和接收入口增加兼容实现；console health、前端首页和 `/api/reports` 已验证。
- 混合接收仍为“自动 scheduler + 面试时手动一键接收”，没有安装或启用高权限自动接收 systemd。手动脚本在没有成功任务时返回 `no_succeeded_run`，不创建任务、不调用 `CreateDisposition`。
- 当前 scheduler 仍为 `enabled=true`、每分钟触发；余额补充后已出现连续成功 run（例如 `d04605...`、`9c547c...`）。此前的 HTTP 402 `Insufficient Balance` 已恢复，不是 service 或 capset 回归。
- 手动接收最新成功 run 返回 `DUPLICATE_EVIDENCE_RUN`，因为合成告警和证据集合与既有 accepted 报告完全一致；这是跨 scheduler run 幂等门禁的预期结果，不是模型失败。
- 本轮 SSH 上传归档已从云端删除；临时部署密钥仅用于本轮操作，未写入项目或 README。

2026-10-18 本地已实现宿主自动接收进程、独立门禁复用、外层/内层平台关联、脱敏拒绝记录及原子幂等存储。此前自动接收 unit 的云端部署命令被安全审核阻止；用户随后明确选择「暂不授权，保留手动接收」。该 unit 仍未安装或启用，不调整宿主权限；不把本地测试通过写成云端自动接收上线。本轮 service、console 和手动接收脚本已另行同步，见上方补充。

- 定时自动执行及首份报告已验证；event bus 自动投递、运行超时、重叠并发 skip 和故障注入尚未实测。
- 完整 Schema/证据门禁已接入显式报告接收；自动观察/接收代码已完成，但按用户选择暂缓云端部署及相关验证，当前保留手动接收。
- 知识的时间窗、过期、结构化白名单、维护窗口和来源冲突阈值已落入本地 service 代码，并由当前 Node 回归覆盖；云端重导入后的同等边界仍需在考官验收时复核。
- 跨 run 的顺序/并发去重和跨上游分页分组已在本地实现并测试；本轮已重新导入云端并通过 cloud-smoke。service SDK lockfile 仍待完善；SDK 版本已精确固定为 0.6.2，lockfile 因当前环境无法访问 npm registry 未伪造。
- 当前页面已提供只读报告列表和证据链详情，但不提供完整审批 UI；审批字符串也不是可信审批系统。
- Node 12 与 Compose 1.29 云端兜底仍有 EOL/兼容性风险。
- 考官需自行用其私钥完成实际登录验证。

后续以 to_do_list.md 的未勾选项继续开发，不把本记录视为正式验收通过。
