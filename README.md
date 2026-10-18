# alert-triage-demo

独立的安全运营面试 Demo：告警研判与降噪。基础服务、真实能力调用、沙箱隔离与三类 DeepSeek 真实研判已通过部署联调。云端已按用户授权开启每分钟轮询；正式验收仍需单独核对，参见 [待办清单](to_do_list.md)。

## 架构与边界

    scheduler / event
      -> official agent-compose guest sandbox
      -> capproxy (sandbox-scoped token)
      -> OctoBus triage-read
      -> alert-platform service
      -> synthetic mock upstream

LLM 只组织解释、引用证据、召回相似案例；代码提供字段校验、结构化事实校验、去重、时间窗口/新鲜度/完整性判断及置信度上限。人工写入单独放在 triage-human-write，Agent 没有此 capset。最终报告需经过宿主机 Ajv Schema、独立 OctoBus 证据快照和代码门禁核验；平台 run succeeded 不等于报告 accepted。这里的规则是可执行的 synthetic-demo policy，不是生产级全自动研判。

不复制或重新实现上游 daemon、scheduler、sandbox、capproxy。

目录职责：

- agent/：提示词、单告警输出 schema、Ajv 校验器、只读能力调用 helper 和隔离诊断脚本。
- app/：宿主报告接收的集中配置、平台只读适配、业务校验与报告存储；不替代上游 scheduler。
- knowledge/：合成 SOC 规则、历史案例、探针登记、维护窗口和字段字典。
- octobus-services/demo__alert-platform/：自有 Node.js service package 与 proto。
- mock-upstream/：合成告警、资产事实、行为日志、历史案例和处置记录。
- frontend/：只读告警、证据及相似案例页面；没有完整报告审批 UI。
- scripts/：导入、capset、模型配置、云端 systemd 和只读页面服务。
- tests/：现有本地回归及真实云端 Connect smoke。

## 官方运行依赖

- [agent-compose](https://github.com/chaitin/agent-compose)：daemon 和 guest 同用官方 commit 快照 sha-70bfd0b，不是稳定发布版。
- [OctoBus](https://github.com/chaitin/OctoBus)：官方镜像固定 digest。
- 本地开发测试使用 Node.js 22+、Python 3、Docker Compose V2、PowerShell 7。

| 镜像 | 已核对的 digest |
| --- | --- |
| chaitin/agent-compose:sha-70bfd0b，index | sha256:f25e8f35c5add0b3c221d47a7f28d88c96130922a66561483b9aee5bd46da8c9 |
| daemon，linux/amd64 | sha256:9c137d01c4419348225aa0fa84798fef0ca96351a79298970df005b741f2f0e4 |
| chaitin/agent-compose-guest:sha-70bfd0b，index | sha256:6bb48090e702e3f2717b644874aa43166aa064632d7585dd87479785a77df96e |
| guest，linux/amd64 | sha256:389e82a58146331a64175187a0598c7d5aa9bbb4ac2b97d6435fa42d3112382d |
| ghcr.io/chaitin/octobus | sha256:377409360a3d54f8e058340a7fb4874a994f18d11d35ba8f7cae0bec23a724a6 |

为何不用 GHCR agent-compose latest：实测得到 v2607.10.0，不接受所需配置。官方稳定版 v2610.1.0 也不接受网络 policy。故选择经过真实配置校验的官方固定 commit，而不是移除安全策略。

## 本地启动

在项目目录执行。init-env 遇到已有 .env 会拒绝覆盖，且不会打印随机凭据。仓库配置已是面试演示模式（每分钟自动运行）；在新环境首次配置模型前，先将 agent-compose.yml 的 scheduler.enabled 设为 false，完成单次验证并确认费用后再启用。

~~~powershell
npm ci --ignore-scripts
node scripts/init-env.mjs
docker compose pull octobus agent-compose
docker compose --profile images pull guest-image
docker compose up -d mock-upstream octobus frontend agent-compose
.\scripts\bootstrap-octobus.ps1
.\scripts\configure-capsets.ps1
node scripts/configure-gateway.mjs
docker compose exec agent-compose /app/agent-compose -f /data/work/agent-compose.yml up
~~~

页面 [http://127.0.0.1:8080](http://127.0.0.1:8080)。所有发布端口仅监听回环，无需放行 Windows 的 Node.js 公网入站端口。新环境模型配置前应保持 scheduler.enabled=false；这不同于已完成联调的云端演示状态。

### npm 与官方镜像的来源

当前开发机不能访问 `https://registry.npmjs.org/` 的外连 TCP 443，因此不能在线生成 service SDK 的 lockfile；这不等于 npm 包不存在，也不影响已经存在的根目录 Ajv 依赖和 lockfile。业务 service 只把 `@chaitin-ai/octobus-sdk` 固定为运行时依赖，不伪造 lockfile、不放 npm token。需要生成该 lockfile 时，应在有网络的机器或公司 npm 镜像执行 `npm install --package-lock-only --ignore-scripts`，再把结果作为人工审核的构建输入。

本 Demo 的运行环境不是通过 npm 下载的：agent-compose daemon/guest 与 OctoBus 是官方 OCI/Docker 镜像，云端先在可连通环境按 digest 校验并导出 OCI tar，再离线 `docker load`；业务 service package 在 OctoBus 导入时由平台安装其运行依赖。Node 控制台和 mock 使用云主机已有 Node 运行时，不需要 npm registry 才能启动。这样既没有复制平台内部 Go 源码，也把“镜像可用”和“npm registry 可用”分成了两个独立问题。

首次导入若 Linux 可执行位丢失，检查 bin/alert-platform.js 执行权限后重导入；不要无依据修改平台 runtime。

脚本默认用于首次配置。已有 instance/capset 不要重复 create；service 可使用 bootstrap-octobus.ps1 -Reimport。脚本不是生产配置迁移工具。

## OctoBus 公开命令

以下为 Linux 首次配置示例；云端已完成，勿重复 create：

~~~bash
sudo docker exec alert-triage-octobus octobus service import alert-platform /opt/alert-triage/services/demo__alert-platform
sudo docker exec alert-triage-octobus octobus instance create alert-platform-demo --service alert-platform --config-json '{"upstreamBaseUrl":"http://host.docker.internal:8081","timeoutMs":3000,"maxPageSize":100}'
sudo docker exec alert-triage-octobus octobus capset create triage-read --name "Alert Triage Read"
sudo docker exec alert-triage-octobus octobus capset add-instance triage-read alert-platform-demo --no-all-methods
for method in ListAlerts GetAlertDetail QueryEvidence SearchSimilarCases; do
  sudo docker exec alert-triage-octobus octobus capset select-method triage-read alert-platform-demo "/alert_triage.v1.AlertPlatformService/$method"
done
sudo docker exec alert-triage-octobus octobus capset create triage-human-write --name "Alert Triage Human Write"
sudo docker exec alert-triage-octobus octobus capset add-instance triage-human-write alert-platform-demo --no-all-methods
sudo docker exec alert-triage-octobus octobus capset select-method triage-human-write alert-platform-demo /alert_triage.v1.AlertPlatformService/CreateDisposition
sudo docker exec alert-triage-octobus octobus catalog triage-read --all --json
~~~

ListAlerts、GetAlertDetail、QueryEvidence、SearchSimilarCases 为只读；CreateDisposition 为写入。写入还要求人工审批字段、幂等键、真实证据 ID、分类匹配和置信度上限。审批字段本身不是可信身份认证；目前只有隔离的人工高权限 capset，没有生产审批系统。

云端 capset 必须配置独立的 `triage-read` scoped token；不能把 `OCTOBUS_ADMIN_TOKEN` 或 `AGENT_COMPOSE_AUTH_TOKEN` 当作业务 token。当前仓库的 `scripts/configure-gateway.mjs` 从未提交的 `.env` 读取 `OCTOBUS_TRIAGE_READ_TOKEN`，并将其写入 Capability Gateway 的运行时配置；不会打印 token，也不会把它注入 guest。`.env.example` 只保留占位符。

由于 `capset list-tokens` 只显示掩码，已有 token 的原文不能恢复。若服务器上没有保存原值，应先按当前 CLI 的 `octobus capset add-token --help` 创建一个新的只读 token，再将其写入服务器 `.env`（权限 `600`），然后执行：

~~~bash
# 在服务器上执行；token secret 只写入临时文件和 .env，不打印到终端。
token_id="triage-read-agent-$(date +%Y%m%d%H%M%S)"
token_file="$(mktemp)"
chmod 600 "$token_file"
trap 'rm -f "$token_file"' EXIT
openssl rand -hex 32 > "$token_file"
sudo docker exec -i alert-triage-octobus octobus capset add-token \
  triage-read "$token_id" --name "alert-triage agent read" --token-stdin < "$token_file"

token_value="$(cat "$token_file")"
if grep -q '^OCTOBUS_TRIAGE_READ_TOKEN=' .env; then
  sed -i "s|^OCTOBUS_TRIAGE_READ_TOKEN=.*$|OCTOBUS_TRIAGE_READ_TOKEN=$token_value|" .env
else
  printf '\nOCTOBUS_TRIAGE_READ_TOKEN=%s\n' "$token_value" >> .env
fi
unset token_value
chmod 600 .env

node scripts/configure-gateway.mjs
~~~

配置完成后，重新运行 capability/security smoke：读方法应成功，`triage-human-write` 和后端直连应拒绝，并在 OctoBus audit 中看到 `triage-read` 调用。不要把 token 值粘贴到聊天、日志或截图中。

## DeepSeek 安全配置

用户选择 deepseek-v4-flash。官方 API 地址 https://api.deepseek.com，实测采用原生 Responses 协议。Chat Completions 桥接曾在工具调用后因缺失 reasoning_content 失败，不能作为本项目已验证的配置。Key 只存到 daemon 管理的 provider 存储，不写入项目 .env、不进入 guest。

2026-10-18 查阅的 [DeepSeek 官方模型说明](https://api-docs.deepseek.com/quick_start/pricing) 表明：该旧 ID 仍被接受，但实际由 DeepSeek-V4.1-Flash-1017 服务；不能声称实际调用到已退役的旧版本。

在云服务器交互终端输入：

~~~bash
cd /home/ecs-user/alert-triage-demo
python3 scripts/configure-model.py
~~~

看到提示后粘贴 API Key 并回车，不回显。不要在聊天、命令行参数或截图中提供 Key。若使用第三方网关，显式传 --base-url https://你的网关地址；脚本拒绝 HTTP 和 URL 内嵌凭据。默认协议为 responses；其他协议必须重新验证工具调用完整性。

助手只配置 provider/default model，不等于模型请求已成功，也不会更改 scheduler 的启停状态。daemon 原生存储没有额外应用层加密，数据目录必须限权，备份也按密钥资料保护。

## Agent 启动、触发与日志

以下命令在云端运行。模型及单次报告验证已通过，用户明确选择每 1 分钟演示，现已启用 scheduler.enabled=true / interval=1m。重叠任务按 skip 跳过，因此不是保证每分钟必有一次成功报告；开启期间会持续消耗模型额度。

演示结束需暂停时，编辑 /home/ecs-user/alert-triage-demo/agent-compose.yml，将 scheduler.enabled 改为 false，再执行下面的 up 命令。不需停止 daemon 或删除运行记录；暂停只阻止后续自动任务，已开始的任务可能仍会运行至结束。

~~~bash
sudo docker exec alert-triage-agent-compose /app/agent-compose -f /data/work/agent-compose.yml up
sudo docker exec alert-triage-agent-compose /app/agent-compose scheduler inspect triage --json
sudo docker exec alert-triage-agent-compose /app/agent-compose scheduler trigger triage alert-poll --detach
sudo docker exec alert-triage-agent-compose /app/agent-compose scheduler runs triage --limit 10
sudo docker exec alert-triage-agent-compose /app/agent-compose scheduler logs --scheduler triage --tail 50
sudo docker exec alert-triage-agent-compose /app/agent-compose logs --agent triage --tail 100
~~~

scheduler logs 是外层结构化事件，不是完整内层模型 transcript；内层使用 logs --run <run-id>。daemon 状态/运行记录保存在挂载的数据目录，需按隐私要求保留、轮转或导出，不得直接发布全部日志。

当前配置包含 interval、security.alert.created event、new sandbox、skip 并发、10 分钟运行超时、Agent 并发上限 1、每次单告警 JSON。三类真实模型报告、带载荷的 alert-event 手动触发及 alert-poll 手动触发均已验证。启用后也已观察到真实 interval:60000 自动运行，首份自动报告经独立接收 accepted=true；event bus 自动投递、超时与重叠 skip 尚未专门实测。完整运行 ID 与接收结果见 [部署记录](docs/deployment-status-2026-10-18.md)。

## 三个真实能力测试案例

| 告警 | 代码门禁预期 | 人工复核 | 置信度上限 |
| --- | --- | --- | --- |
| ALT-001：外部来源+数据库异常 | REAL_ATTACK | 是 | 0.94 |
| ALT-002：内部探针合成事实 | SUSPECTED_FALSE_POSITIVE | 否 | 0.91 |
| ALT-003：资产/行为/关联证据缺失 | INSUFFICIENT_EVIDENCE | 是 | 0.59 |

以上三类 fixture 已由真实 DeepSeek Agent 调用 OctoBus 并生成报告，经过宿主机独立校验。ALT-002 仅 HOLD_FOR_REVIEW，不自动关闭；ALT-003 为 REQUEST_MORE_EVIDENCE，不允许关闭或抑制。confidence 为 Demo 规则上限约束的研判分值，不代表经统计校准的攻击概率。

### 独立接收最终报告

取得内层 Agent Run ID 后，在云端项目目录执行：

~~~bash
set -a
. ./.env
set +a
node scripts/collect-agent-report.mjs <完整的Agent-run-id>
~~~

只解析平台 result_json.finalText，不从整段 transcript 中猜测 JSON。要求完整 Schema、真实 run_id、证据 ID/source/method/time/fact、相似案例 ID、分类/规则/缺失项/置信度/人审门禁一致。报告中的事实必须原样引用，解释放在 explanation。

通过的结果保存到 reports/<run-id>.json，含 accepted、validation、report、只读独立快照和运行时间窗口内的真实 gRPC 调用审计。校验拒绝的新报告仅保存 accepted=false 与固定原因码，不保存未通过的模型正文或包含模型自报值的错误串；原始 transcript 不导出。输出变为安全摘要 run_id / accepted / reason。文件一旦接收即不覆盖，拒绝结果不能通过静默修补变为通过，应重新运行。

面试演示不需要记住完整 Agent run ID，可在服务器项目目录执行一次性入口：

~~~bash
set -a
. ./.env
set +a
node scripts/collect-latest-agent-report.mjs
~~~

它只选择最近时间窗口内最新的成功 scheduler run，复用独立证据门禁并输出脱敏 JSON；已接收的运行返回 `report_already_recorded`，没有成功运行返回 `no_succeeded_run`。它不会创建 Agent 任务、调用 `CreateDisposition` 或常驻运行，因此保留了手动接收的权限边界。

控制台现在提供只读研判报告列表和详情：结论、置信度、证据链、缺失证据、规则命中、下一步动作、相似案例和调用审计。浏览器不读取 cap token，也不代理任何写接口；完整人工审批仍需受控后端和可信身份认证。

### 自动接收进程（仅本地代码，用户已选择暂缓部署）

scripts/watch-agent-reports.mjs 每 15 秒只读观察官方 scheduler runs，不创建任务、不执行处置。默认查看最近 30 条任务中，完成于最近 10 分钟的终态记录。不是 webhook，也不重写调度器。超过数量/时间窗口的历史记录不保证补齐；断线超过该窗口或审计已过保留范围时，需要人工检查，不得声称全量可靠队列。

模型自报 run_id 仅用作候选索引：接收器再次通过官方 inspect，核对平台 ID、Agent 名、scheduler 结果中的 sandboxId、内外层时间范围和两层 finalText 完全相同，然后才进行 Schema/证据门禁。不是直接相信模型 ID。审计依然是时间窗口匹配，不构成逐调用 run ID 归属证明。

每个外层任务的脱敏接收结果位于 reports/scheduler/<scheduler-run-id>.json。重复轮询或重启时不重复生成已提交结果；临时 CLI/OctoBus 不可用不写成 accepted，也不写死为永久拒绝，在观察窗口内重试。外层 failed/canceled/skipped 与报告 rejected 都不会被算为 accepted。磁盘写入使用排他临时文件与原子无覆盖提交。

拟用 unit 为 scripts/alert-triage-reports.service，以 ecs-user 运行，进程专属 SupplementaryGroups=docker，**Docker 访问权等同宿主高权限**；NoNewPrivileges 等加固不能消除该权限风险。首次部署申请被安全审核拦截后，用户于 2026-10-18 明确选择「暂不授权，保留手动接收」。因此不上传/安装/启用该服务，不调整宿主权限；本地代码仅保留作参考，不属于当前云端运行链路。现有每分钟 Agent 调度保持不变，独立报告仍按上节命令手动接收。

以下仅为将来重新明确授权后的核验参考，不是当前操作指令；当前不得执行服务部署或启用，也不得宣传自动接收已上线：

~~~bash
systemctl is-active alert-triage-reports.service
sudo journalctl -u alert-triage-reports.service -n 30 --no-pager
~~~

预期脱敏事件为 receiver_started、report_processed 或 receiver_unavailable；平台错误原文、provider 配置与 raw transcript 都不输出到这些事件。凭据特征过滤是额外检测而非完备 DLP 保证。

独立快照来自运行后的 OctoBus 读取；本 Demo 数据不可变。生产动态证据必须增加 snapshot/version 与按 run ID 的审计关联，不能将时间窗口匹配等同严格逐调用因果归属。

~~~bash
node tests/cloud-smoke.mjs
~~~

预期四条 PASS：上述三条及 read-capset-denies-write（HTTP 404，方法未发布）。该测试直接通过真实 OctoBus Connect RPC，不访问后端。

从官方沙箱验证 capproxy 路径和网络隔离，不需要 LLM：

~~~bash
sudo docker exec alert-triage-agent-compose /app/agent-compose -f /data/work/agent-compose.yml run triage --command 'python3 capability-smoke.py'
sudo docker exec alert-triage-agent-compose /app/agent-compose -f /data/work/agent-compose.yml run triage --command 'python3 security-smoke.py'
~~~

capability-smoke 预期三条读取成功、人工写 capset 返回 PermissionDenied。security-smoke 检查选定直连目标不可达、管理 API 401、runtime token 存在与管理凭据不存在；不是对所有网络攻击面的穷举证明。

本地回归：

~~~bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p test_configure_model.py
~~~

目前分别 40 / 40 和 3 / 3；新增测试覆盖凭据边界、证据新鲜度、时间窗口、结构化冲突、探针签名、跨页分组、只读报告投影、去重阈值、输入边界、重复处置幂等，以及接收器关联、拒绝、跨运行去重、跨进程锁、配置和故障重试。正式验收按根目录测试开关和确认流程另行执行，不能将这里的 smoke 等同完整验收。

## 云服务器与考官核验

~~~text
公网 IP：121.40.118.37
私网 IP：172.20.44.39
用户名：ecs-user
SSH 端口：22
项目目录：/home/ecs-user/alert-triage-demo
~~~

登录：

~~~bash
ssh -p 22 ecs-user@121.40.118.37
~~~

考官公钥已经去重追加至 /home/ecs-user/.ssh/authorized_keys，目录权限 700、文件权限 600；已核验服务端配置，考官仍须用自己的私钥实际登录。公钥/私钥内容均不入项目。

云端因 Docker Hub 直连失败，官方镜像经 registry 下载、逐层 SHA256 校验后导入，不包含任何复制的 Go 源码。mock 和只读页面由宿主机 systemd 管理，OctoBus 和 agent-compose 为官方容器：

~~~bash
sudo docker ps
sudo systemctl status alert-triage-mock.service alert-triage-console.service --no-pager
sudo docker exec alert-triage-octobus octobus instance list
sudo docker exec alert-triage-agent-compose /app/agent-compose scheduler inspect triage --json
~~~

使用本地 SSH 隧道看页面，不开放新公网端口：

~~~bash
ssh -p 22 -L 8080:127.0.0.1:8080 ecs-user@121.40.118.37
~~~

然后访问 http://127.0.0.1:8080。若本机 8080 被占用，可用 -L 18080:127.0.0.1:8080，再访问 18080。

云端 mock 监听 Docker bridge 地址 172.17.0.1:8081，只读页面监听 127.0.0.1:8080，控制面仅发布 127.0.0.1:7410 / 9000。不要使用 docker-compose.cloud.yml 启动另一套容器版 mock 覆盖 systemd 配置。

## 审计检查

~~~bash
sudo docker exec alert-triage-octobus octobus logs --capset triage-read --tail 20
sudo docker exec alert-triage-octobus octobus logs --capset triage-human-write --tail 20
sudo journalctl -u alert-triage-mock.service -u alert-triage-console.service -n 50 --no-pager
sudo docker logs --tail 100 alert-triage-agent-compose
~~~

mock 的成功写入审计位于项目 logs/audit.log，仅在有成功处置后产生；没有此文件不等于日志故障。真实 OctoBus 调用审计已看到 QueryEvidence 成功和写方法被拒绝。不要打印 .env、容器完整 env、provider 数据库或私钥。

## 实施问题与处理

- GHCR latest / 稳定版配置不匹配：固定官方开发 commit，保留安全声明，真实 config / up 验证。
- Windows 打包会丢失 Linux 可执行位且入口 shebang 必须是 `/usr/bin/env node`：云端重导入前显式设置 `bin/alert-platform.js` 可执行位，并在 OctoBus instance 启动后检查状态。
- Docker Hub 网络失败：在可连通位置获取官方 OCI layer、校验 digest、离线导入；不重写平台。
- Docker 29 + Compose 1.29.2 重建兼容问题：云端精确重建目标 daemon，不递归重建依赖，不删除数据卷。建议后续升级 Compose V2。
- OCI load 后 tag 不可解析：核对 manifest digest 后显式规范 docker.io 标签。
- SDK 丢失 snake_case 字段：RPC 适配边界转 camelCase，保留 Struct 原始数据，重新导入 service package。
- handler 错误变成 INTERNAL：映射为 SDK GrpcError。
- 默认 sandbox 网络选择：上游按字母排序选 daemon 的第一个 named network，因此专用网络命名为 alert-triage-demo-00-sandbox，且验证了 guest 实际连接。
- 仅 HTTP_PROXY 不是强隔离：增加 Docker internal 网络，并实测忽略代理后的后端/公网/元数据直连失败。
- 单对象 schema 与批量 prompt 冲突：每次处理一条，workspace 根路径统一。
- Chat Completions 缺少 reasoning_content：保留 Key，改用官方原生 Responses。
- Agent 曾打印自己的临时 CAP_TOKEN：该测试 sandbox 已移除并撤销授权，后续提示词禁止 env/printenv/凭据打印；宿主报告门禁拒绝发现此类输出的运行。不能把提示词当作防止所有泄露的强保证。
- Agent 填错 run_id：只读 helper 返回上游注入的 AGENT_COMPOSE_RUN_ID，模型仅复制，宿主再次比对。
- 误报报告建议 SUPPRESS_PENDING_REVIEW：由 Schema/代码拒绝，统一改为 HOLD_FOR_REVIEW，不能先抑制后审批。
- 云端宿主 Node 12 已 EOL：目前只是合成 mock/静态展示兜底，应升级到受支持 Node，不能作为生产部署标准。

## 仍待完成的事项

剩余事项是超时/并发等异常链路的专门云端验收、完整人工审批 UI，以及 service SDK 的完整 lockfile（当前 SDK 版本已精确固定为 0.6.2；当前开发环境无法访问 npm registry）。本轮已把跨上游分页分组的 service 重新导入云端，并同步 Node 12 兼容的只读 console、报告投影和一键手动接收脚本；自动接收 systemd 仍按用户决定暂缓部署。轮询当前每次取一条告警，数据不变时可能反复处理 ALT-001，但重复报告不会被本地接收器重复接受。根目录 Ajv 依赖已提交精确版本与 lockfile。规则实现使用可信结构化事实，不是生产级检测引擎。所有样本均为 synthetic-demo，不用于真实业务自动关闭。最新云端 instance 显式设置 `evaluationTime=2026-10-18T04:00:00Z`，用于稳定回放，不代表实时模式。若模型 provider 返回 402/余额不足，scheduler 会失败且手动接收安全地返回 `no_succeeded_run`，不会伪造报告。

安全原则：证据不足不关闭、不猜测；报告必须引用当前工具返回的真实证据与案例 ID；未经授权不写入；失败时保留待复核。临时部署 SSH Key 不提交，部署收尾后由用户决定何时撤销。

## 上游证据与许可证

以下为本机只读上游证据索引；部署镜像的 RPC 字段还核对了固定 commit 的公开文件。行号指此次扫描快照，升级后需重新核验。

- D:/面试2/agent-compose/.env.example:165：LLM 配置；:57：daemon auth token。
- D:/面试2/agent-compose/docs/pages/agent-compose-yaml-manual.md:617：模型 provider；:1168：network；:1228：scheduler 策略。
- D:/面试2/agent-compose/docs/pages/octobus-quickstart.md:174：能力注入；:191：gRPC metadata。
- D:/面试2/agent-compose/pkg/driver/docker_runtime.go:1062：named network 选择。
- D:/面试2/agent-compose/proto/agentcompose/v2/agentcomposev2connect/agentcompose.connect.go:270：CreateProvider；:287：SetDefaultModel。
- D:/面试2/OctoBus/sdk/src/proto-loader.ts:259：service definition/序列化边界。
- D:/面试2/OctoBus/sdk/src/index.ts:3：GrpcError 公开导出。
- D:/面试2/OctoBus/internal/cli/cli.go:1089：调用日志 CLI。

上游 agent-compose 为 AGPLv3，OctoBus daemon 为 GPLv3，SDK 为 LGPL-3.0-only；运行和分发须遵循各自 LICENSE，本项目不将平台内部源码据为业务实现。SDK 作为运行时 npm 依赖使用。

报告校验使用 Ajv 8.17.1 / ajv-formats 3.0.1（MIT），通过 npm 运行依赖使用，不抽取或改写其内部实现。

