const alertsNode = document.querySelector("#alerts");
const evidenceNode = document.querySelector("#evidence");
const casesNode = document.querySelector("#cases");
const reportsNode = document.querySelector("#reports");
const reportDetailNode = document.querySelector("#report-detail");

async function get(path) {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderAlerts(items) {
  alertsNode.replaceChildren();
  for (const item of items) {
    const button = document.createElement("button");
    button.className = "alert";
    button.textContent = `${item.alert_id} · ${item.severity} · ${item.title}`;
    button.onclick = () => loadDetail(item.alert_id);
    alertsNode.append(button);
  }
}

function line(label, value) {
  const row = document.createElement("div");
  row.className = "report-line";
  const name = document.createElement("strong");
  name.textContent = `${label}：`;
  const text = document.createElement("span");
  text.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
  row.append(name, text);
  return row;
}

function listBlock(title, items) {
  const block = document.createElement("section");
  block.className = "report-block";
  const heading = document.createElement("h3");
  heading.textContent = title;
  block.append(heading);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(items || [], null, 2);
  block.append(pre);
  return block;
}

function renderReport(report) {
  reportDetailNode.replaceChildren();
  if (!report) { reportDetailNode.textContent = "请选择一份报告"; return; }
  const data = report.report;
  reportDetailNode.append(line("运行 ID", report.run_id), line("告警", data?.alert_id), line("结论", data?.classification), line("置信度", data?.confidence), line("人工复核", data?.human_review_required ? "是" : "否"), line("建议处置", data?.proposed_disposition), line("接收状态", report.accepted ? "已通过独立校验" : "已拒绝"));
  if (data?.explanation) reportDetailNode.append(line("解释", data.explanation));
  reportDetailNode.append(listBlock("证据链", data?.evidence_chain), listBlock("缺失证据", data?.missing_evidence), listBlock("下一步动作", data?.next_actions), listBlock("规则命中", data?.rule_hits), listBlock("相似案例", report.similar_cases), listBlock("调用审计", report.call_audit));
}

async function loadReport(runId) {
  try { renderReport(await get(`/reports/${encodeURIComponent(runId)}`)); }
  catch (error) { reportDetailNode.textContent = error.message; }
}

function renderReports(items) {
  reportsNode.replaceChildren();
  if (!items.length) { reportsNode.textContent = "暂无独立接收报告。先运行一键接收脚本，再刷新页面。"; return; }
  for (const item of items) {
    const button = document.createElement("button");
    button.className = "report";
    button.textContent = `${item.alert_id || "未知告警"} · ${item.classification || item.reason || "未通过"} · ${item.accepted ? "accepted" : "rejected"}`;
    button.onclick = () => loadReport(item.run_id);
    reportsNode.append(button);
  }
}

async function loadDetail(alertId) {
  try {
    const [ev, cases] = await Promise.all([get(`/evidence?alert_id=${encodeURIComponent(alertId)}`), get(`/cases?alert_id=${encodeURIComponent(alertId)}`)]);
    evidenceNode.textContent = JSON.stringify(ev.evidence, null, 2);
    casesNode.textContent = JSON.stringify(cases.cases, null, 2);
  } catch (error) {
    evidenceNode.textContent = error.message;
    casesNode.textContent = error.message;
  }
}

get("/alerts?page_size=20").then((body) => renderAlerts(body.alerts)).catch((error) => { alertsNode.textContent = error.message; });
get("/reports").then((body) => renderReports(body.reports || [])).catch((error) => { reportsNode.textContent = `报告接口不可用：${error.message}`; });

