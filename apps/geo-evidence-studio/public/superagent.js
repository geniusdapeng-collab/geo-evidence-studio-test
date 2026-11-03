import { evidenceUrl, studioAuthHeaders, updateStudioToken } from "./app.js";

const $ = (id) => document.getElementById(id);
const channelId = "studio";
const taskLabels = {
  queued: "排队中", running: "研究中", completed: "已完成", paused: "已暂停", blocked: "已阻断", failed: "未完成",
};
const stageLabels = { evidence: "公开证据", report: "研究报告" };
const activeStatuses = new Set(["queued", "running"]);
const followupStatuses = new Set(["queued", "running", "paused", "completed"]);
const state = {
  threadId: $("sa-thread").value, scope: new AbortController(), config: null,
  tasks: [], taskId: "", selectedTask: null, detailVersion: 0, detailFingerprint: "", sending: false, loading: false, poll: null,
  requestKeys: new Map(),
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function publicLink(source) {
  const url = evidenceUrl(source.url);
  if (!url) return null;
  const link = node("a", source.title || url.hostname);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function timeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN");
}

function message(text, error = false) {
  const target = $(error ? "sa-error" : "sa-notice");
  target.textContent = text;
  target.hidden = !text;
}

function showError(error) {
  if (error.status === 401 || error.status === 403) $("sa-auth").open = true;
  message(error.message, true);
}

async function request(path, body, scope = state.scope) {
  const headers = studioAuthHeaders();
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(`/api/superagent${path}`, {
      method: body === undefined ? "GET" : "POST", headers, signal: scope.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (scope.signal.aborted) throw error;
    throw new Error("本地服务未响应，请检查连接后重试。");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const codes = {
      private_material: "内容疑似含凭据或个人联系方式，请仅保留可公开的研究材料。",
      public_research_required: "请确认只提交可公开研究的材料。", query_required: "新任务需要明确填写公开搜索词。",
      event_conflict: "该事件编号已有不同内容，请刷新后重新提交。", payload_too_large: "研究正文或搜索词超过允许大小。",
    };
    const descriptions = {
      400: "提交内容或线程编号不符合要求，请核对后重试。", 401: "请更新本地服务访问令牌。", 403: "当前连接无权访问此任务。",
      404: "当前线程没有找到这项任务，或研究服务尚未启用。", 409: "任务或事件状态已变化，请刷新后再操作。",
      429: "本地服务正在限制请求，请稍后重试。", 503: "研究服务未配置或暂不可用。",
    };
    const known = Object.hasOwn(codes, payload?.code) ? codes[payload.code] : undefined;
    throw Object.assign(new Error(known ?? descriptions[response.status] ?? `本地服务请求失败（${response.status}）。`), { status: response.status });
  }
  try { return await response.json(); }
  catch { throw new Error("本地服务返回的回执不完整，请刷新后重试。"); }
}

function scopeQuery() {
  return new URLSearchParams({ channelId, threadId: state.threadId }).toString();
}

function updateControls() {
  const writable = Boolean(state.config?.configured) && !state.sending;
  for (const id of ["sa-request", "sa-query", "sa-public-request", "sa-send-request"]) $(id).disabled = !writable;
  const status = state.selectedTask?.status;
  $("sa-followup-form").hidden = !followupStatuses.has(status);
  for (const id of ["sa-followup", "sa-followup-query", "sa-public-followup", "sa-send-followup"]) $(id).disabled = !writable;
  $("sa-resume").hidden = status !== "paused";
  $("sa-resume").disabled = !writable;
  $("sa-watch").disabled = !state.config || state.sending;
  $("sa-refresh").disabled = state.loading;
}

function statusPill(status) {
  const tone = ["blocked", "failed"].includes(status) ? " danger" : status === "paused" ? " warn" : "";
  return node("span", taskLabels[status] ?? "状态待确认", `pill${tone}`);
}

function taskLabel(task) {
  return task.title || task.text || task.displayTitle || `研究任务 · ${String(task.taskId).slice(-8)}`;
}

function renderTaskList() {
  const list = $("sa-task-list");
  const fragment = document.createDocumentFragment();
  for (const task of state.tasks) {
    const button = node("button", undefined, "button ghost");
    button.type = "button";
    button.dataset.taskId = task.taskId;
    button.setAttribute("aria-pressed", String(state.taskId === task.taskId));
    button.append(node("strong", String(taskLabel(task)).slice(0, 75)), statusPill(task.status));
    fragment.append(button);
  }
  list.replaceChildren(fragment);
  $("sa-list-status").textContent = state.tasks.length ? `${state.tasks.length} 项任务` : "这个线程还没有研究任务。";
}

function detailBlock(title) {
  const section = node("section", undefined, "sa-detail-block");
  section.append(node("h3", title));
  return section;
}

function renderTimeline(taskId, events) {
  const section = detailBlock("线程时间线");
  if (!events.length) {
    section.append(node("p", "暂无接单或补充事件。", "muted"));
    return section;
  }
  const list = node("ol", undefined, "sa-timeline");
  for (const event of events) {
    const entry = node("li");
    const label = event.kind === "followup" ? "补充线索" : "研究请求";
    const time = timeLabel(event.acceptedAt);
    entry.append(node("strong", time ? `${label} · ${time}` : label));
    if (event.preview) entry.append(node("p", event.preview, event.hasSpill ? "sa-content sa-event-preview" : "sa-content"));
    if (event.hasSpill) {
      const button = node("button", "读取事件原文", "button ghost");
      button.type = "button";
      button.addEventListener("click", async () => {
        const scope = state.scope;
        button.disabled = true;
        button.textContent = "正在读取原文…";
        try {
          const { event: full } = await request(`/tasks/${encodeURIComponent(taskId)}/events/${encodeURIComponent(event.eventId)}?${scopeQuery()}`, undefined, scope);
          if (!scope.signal.aborted && entry.isConnected) button.replaceWith(node("p", full.text, "sa-content"));
        } catch (error) {
          if (!scope.signal.aborted && entry.isConnected) {
            showError(error);
            button.disabled = false;
            button.textContent = "重试读取原文";
          }
        }
      });
      entry.append(button);
    }
    list.append(entry);
  }
  section.append(list);
  return section;
}

function renderSources(sources) {
  const section = detailBlock("可回查引用");
  const list = node("ul", undefined, "sa-citations");
  for (const source of sources) {
    const link = publicLink(source);
    if (!link) continue;
    const entry = node("li");
    if (source.sourceId) entry.append(node("span", `${source.sourceId} · `, "muted"));
    entry.append(link);
    if (source.excerpt) {
      const details = node("details");
      details.append(node("summary", "查看证据摘录"), node("p", source.excerpt, "sa-content"));
      entry.append(details);
    }
    list.append(entry);
  }
  section.append(list.childElementCount ? list : node("p", "暂无可回查的公开网页。", "muted"));
  return section;
}

function renderReport(reportStage, currentRevision) {
  const previous = reportStage.revision !== currentRevision;
  const section = detailBlock(previous ? `上一轮已提交报告 · 第 ${reportStage.revision} 轮` : "研究报告");
  const { report } = reportStage.evidence;
  if (report.title) section.append(node("strong", report.title));
  if (report.summary) section.append(node("p", report.summary, "sa-content"));
  for (const claim of report.claims ?? []) {
    const sourceIds = Array.isArray(claim.sourceIds) ? claim.sourceIds.join("、") : "";
    section.append(node("p", sourceIds ? `${claim.text}［${sourceIds}］` : claim.text));
  }
  return section;
}

function renderReceipts(task, stages, evidenceStage, reportStage) {
  const section = detailBlock("执行回执");
  const evidence = evidenceStage?.evidence;
  const report = reportStage?.evidence;
  const details = node("details");
  details.append(node("summary", "查看任务编号、来源摘要与模型回执"));
  const usage = report?.usage;
  const rows = [
    ["任务编号", task.taskId], ["本轮编号", task.revision], ["事件游标", task.latestEventCursor],
    ["数据模式", (report?.dataMode ?? evidence?.dataMode) === "fixture" ? "本机夹具" : (report?.dataMode ?? evidence?.dataMode) === "real" ? "真实模型" : undefined],
    ["已处理游标", task.completedEventCursor], ["证据阶段摘要", evidenceStage?.evidenceSha256],
    ["报告阶段摘要", reportStage?.evidenceSha256], ["模型", report?.model], ["模型响应 ID", report?.responseId],
    ["模型请求摘要", report?.requestSha256], ["模型响应摘要", report?.responseSha256],
    ["输入词元", usage?.promptTokens], ["输出词元", usage?.completionTokens], ["总词元", usage?.totalTokens],
    ["搜索请求摘要", evidence?.search?.requestSha256], ["搜索响应摘要", evidence?.search?.responseSha256],
    ["抓取请求摘要", evidence?.fetch?.requestSha256], ["抓取响应摘要", evidence?.fetch?.responseSha256],
    ...stages.map((stage) => [`第 ${stage.revision} 轮 · ${stageLabels[stage.stage] ?? "阶段"}`, timeLabel(stage.committedAt)]),
    ...(evidence?.sources ?? []).map((source) => [`来源 ${source.sourceId} 摘要`, source.contentSha256]),
  ];
  details.append(node("pre", rows.filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `${label}  ${value}`).join("\n"), "sa-receipt"));
  section.append(details);
  return section;
}

function renderStages(task, stages) {
  const reportStage = stages.filter((stage) => stage.stage === "report" && stage.evidence?.report).at(-1);
  const evidenceStage = stages.filter((stage) => stage.stage === "evidence" && Array.isArray(stage.evidence?.sources)).at(-1);
  return [
    ...(reportStage ? [renderReport(reportStage, task.revision)] : []),
    renderSources(evidenceStage?.evidence.sources ?? []), renderReceipts(task, stages, evidenceStage, reportStage),
  ];
}

function renderTaskDetail(task, events) {
  const heading = node("div", undefined, "sa-heading");
  heading.append(node("h3", String(taskLabel(task)).slice(0, 100)), statusPill(task.status));
  const pending = task.pendingStage?.stage;
  const children = [heading, node("p", `第 ${task.revision ?? 1} 轮${pending ? ` · 正在处理${stageLabels[pending] ?? "下一阶段"}` : ""}`, "muted")];
  if (task.status === "blocked") children.push(node("p", "本任务已阻断，请核对已有回执。此状态不可直接恢复。", "sa-error"));
  if (task.status === "paused") children.push(node("p", "本任务已暂停。可以核对记录后恢复。", "muted"));
  const stages = Array.isArray(task.stages) ? task.stages : [];
  const stageView = node("div");
  stageView.append(...renderStages(task, stages));
  const priorRevisions = [...new Set((task.history ?? []).map((stage) => stage.revision))].sort((a, b) => b - a);
  if (priorRevisions.length) {
    const bar = detailBlock("研究轮次");
    const select = node("select");
    select.setAttribute("aria-label", "查看研究轮次");
    for (const revision of [task.revision, ...priorRevisions]) {
      const option = node("option", revision === task.revision ? `第 ${revision} 轮（当前）` : `第 ${revision} 轮`);
      option.value = String(revision);
      select.append(option);
    }
    select.addEventListener("change", async () => {
      const revision = Number(select.value);
      if (revision === task.revision) return stageView.replaceChildren(...renderStages(task, stages));
      const scope = state.scope;
      stageView.replaceChildren(node("p", "正在读取历史回执…", "muted"));
      try {
        const { stages: old } = await request(`/tasks/${encodeURIComponent(task.taskId)}/revisions/${revision}?${scopeQuery()}`, undefined, scope);
        if (!scope.signal.aborted && select.isConnected && Number(select.value) === revision) stageView.replaceChildren(...renderStages(task, old));
      } catch (error) {
        if (!scope.signal.aborted && select.isConnected && Number(select.value) === revision) {
          showError(error);
          select.value = String(task.revision);
          stageView.replaceChildren(...renderStages(task, stages));
        }
      }
    });
    bar.append(select);
    children.push(bar);
  }
  children.push(stageView, renderTimeline(task.taskId, events));
  $("sa-detail").replaceChildren(...children);
}

async function loadDetail(taskId, scope = state.scope, version = state.detailVersion) {
  const current = () => !scope.signal.aborted && version === state.detailVersion;
  try {
    const { task, events } = await request(`/tasks/${encodeURIComponent(taskId)}?${scopeQuery()}`, undefined, scope);
    if (!current()) return;
    task.displayTitle = (events ?? []).find((event) => event.kind === "request")?.preview;
    state.selectedTask = task;
    const index = state.tasks.findIndex((entry) => entry.taskId === taskId);
    const fingerprint = JSON.stringify([task.status, task.revision, task.latestEventCursor, task.completedEventCursor, task.pendingStage, task.stages?.length]);
    if (fingerprint !== state.detailFingerprint) {
      state.detailFingerprint = fingerprint;
      if (index < 0) state.tasks.unshift(task);
      else state.tasks[index] = task;
      renderTaskList();
      renderTaskDetail(task, events ?? []);
    }
    if (activeStatuses.has(task.status)) state.poll = setTimeout(() => void loadDetail(taskId, scope, version), 1500);
  } catch (error) {
    if (!current()) return;
    state.selectedTask = null;
    $("sa-detail").replaceChildren(node("p", "暂时无法读取任务详情。请刷新重试。", "muted"));
    showError(error);
  } finally { if (current()) updateControls(); }
}

function selectTask(taskId) {
  clearTimeout(state.poll);
  state.detailVersion += 1;
  state.detailFingerprint = "";
  state.taskId = taskId;
  state.selectedTask = null;
  renderTaskList();
  $("sa-detail").replaceChildren(node("p", "正在读取任务详情…", "muted"));
  updateControls();
  void loadDetail(taskId);
}

async function loadTasks() {
  if (state.loading) return;
  const scope = state.scope;
  state.loading = true;
  $("sa-list-status").textContent = "正在读取任务…";
  updateControls();
  try {
    const { tasks } = await request(`/tasks?${scopeQuery()}`, undefined, scope);
    if (scope.signal.aborted) return;
    state.tasks = tasks;
    renderTaskList();
    const selected = tasks.find((task) => task.taskId === state.taskId) ?? tasks[0];
    if (selected) selectTask(selected.taskId);
  } catch (error) {
    if (scope.signal.aborted) return;
    $("sa-list-status").textContent = "暂时无法读取任务。";
    showError(error);
  } finally {
    if (!scope.signal.aborted) { state.loading = false; updateControls(); }
  }
}

async function connect() {
  state.scope.abort();
  clearTimeout(state.poll);
  state.scope = new AbortController();
  const scope = state.scope;
  Object.assign(state, { config: null, tasks: [], taskId: "", selectedTask: null, sending: false, loading: false });
  message(""); message("", true);
  $("sa-connection").textContent = "连接中…";
  $("sa-scope").textContent = "正在读取工作范围…";
  $("sa-list-status").textContent = "正在读取任务…";
  $("sa-task-list").replaceChildren();
  $("sa-detail").replaceChildren(node("p", "选择一项任务后，可以查看进度、引用和执行回执。", "muted"));
  updateControls();
  try {
    const config = await request("/config", undefined, scope);
    if (scope.signal.aborted) return;
    state.config = config;
    const max = config.limits?.textMax ?? 24000;
    $("sa-request").maxLength = max;
    $("sa-followup").maxLength = max;
    $("sa-scope").textContent = `项目 ${config.scope.projectId} · 工作区 ${config.scope.workspaceId} · 渠道 ${channelId} · 线程 ${state.threadId}`;
    $("sa-connection").textContent = config.configured ? (config.dataMode === "fixture" ? "研究服务就绪 · 夹具" : "研究服务就绪 · 真实模型") : "等待服务配置";
    if (config.authorizationRequired) message("真实研究需要先为本地服务设置独立的访问令牌，重启服务后再连接。", true);
    else if (config.configured) $("sa-auth").open = false;
    else message("当前可查看已有回执。配置真实模型和本地访问令牌后，才可提交研究任务。");
    await loadTasks();
  } catch (error) {
    if (scope.signal.aborted) return;
    $("sa-connection").textContent = "连接待确认";
    $("sa-scope").textContent = "尚未连接到本地研究服务。";
    $("sa-list-status").textContent = "连接后可读取任务。";
    showError(error);
  } finally { if (!scope.signal.aborted) updateControls(); }
}

async function mutate(work) {
  if (state.sending) return;
  const scope = state.scope;
  state.sending = true;
  message(""); message("", true);
  updateControls();
  try { await work(scope); }
  catch (error) { if (!scope.signal.aborted) { message(""); showError(error); } }
  finally { if (!scope.signal.aborted) { state.sending = false; updateControls(); } }
}

function submitEvent(kind, textField, queryField, confirmField) {
  if (!state.config?.configured || state.sending) return;
  const text = $(textField).value.trim(), query = $(queryField).value.trim();
  if (!text || (kind === "request" && !query)) return message("请填写研究文本与必要的公开搜索词。", true);
  if (!$(confirmField).checked) return message("请先确认只提交可公开研究的材料。", true);
  if ([...query].length > 128 || new TextEncoder().encode(query).length > 512) return message("公开搜索词最多 128 个字符且不得超过 512 字节。", true);
  const taskId = state.taskId;
  if (kind === "followup" && !followupStatuses.has(state.selectedTask?.status)) return;
  const body = { channelId, threadId: state.threadId, kind, text, publicResearch: true,
    ...(kind === "followup" ? { taskId } : {}), ...(query ? { params: { query } } : {}) };
  const fingerprint = JSON.stringify(body);
  const retry = state.requestKeys.get(kind);
  const eventId = retry?.fingerprint === fingerprint ? retry.eventId : crypto.randomUUID();
  state.requestKeys.set(kind, { fingerprint, eventId });
  void mutate(async (scope) => {
    message(kind === "request" ? "正在提交研究任务…" : "正在提交补充…");
    const { task, replay } = await request("/events", { ...body, eventId }, scope);
    if (scope.signal.aborted) return;
    state.requestKeys.delete(kind);
    if ($(textField).value.trim() === text) $(textField).value = "";
    if ($(queryField).value.trim() === query) $(queryField).value = "";
    $(confirmField).checked = false;
    message(replay ? "已找回先前提交的回执。" : kind === "request" ? "研究请求已接收。" : "补充已记录到任务线程。");
    selectTask(task.taskId);
  });
}

$("sa-thread-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const threadId = $("sa-thread").value.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:@-]{0,127}$/u.test(threadId)) return message("线程编号最多 128 个字符，以字母、汉字或数字开始，可包含 . _ : @ -。", true);
  if (threadId !== state.threadId) {
    state.threadId = threadId;
    state.requestKeys.clear();
    for (const id of ["sa-request", "sa-query", "sa-followup", "sa-followup-query"]) $(id).value = "";
    $("sa-public-request").checked = false;
    $("sa-public-followup").checked = false;
  }
  void connect();
});
$("sa-token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  updateStudioToken($("sa-token").value.trim());
  $("sa-token").value = "";
  state.requestKeys.clear();
  for (const id of ["sa-request", "sa-query", "sa-followup", "sa-followup-query"]) $(id).value = "";
  $("sa-public-request").checked = false;
  $("sa-public-followup").checked = false;
  void connect();
});
$("sa-request-form").addEventListener("submit", (event) => {
  event.preventDefault(); submitEvent("request", "sa-request", "sa-query", "sa-public-request");
});
$("sa-followup-form").addEventListener("submit", (event) => {
  event.preventDefault(); submitEvent("followup", "sa-followup", "sa-followup-query", "sa-public-followup");
});
$("sa-task-list").addEventListener("click", (event) => {
  const taskId = event.target.closest("[data-task-id]")?.dataset.taskId;
  if (!taskId || taskId === state.taskId) return;
  $("sa-followup").value = "";
  $("sa-followup-query").value = "";
  $("sa-public-followup").checked = false;
  selectTask(taskId);
});
$("sa-refresh").addEventListener("click", () => {
  message("", true);
  if (state.config) void loadTasks();
  else void connect();
});
$("sa-resume").addEventListener("click", () => void mutate(async (scope) => {
  const taskId = state.taskId;
  if (state.selectedTask?.status !== "paused") return;
  await request(`/tasks/${encodeURIComponent(taskId)}/resume`, { channelId, threadId: state.threadId }, scope);
  if (scope.signal.aborted) return;
  message("已请求恢复，正在读取任务进展。");
  if (state.taskId === taskId) selectTask(taskId);
}));
$("sa-watch").addEventListener("click", () => void mutate(async (scope) => {
  const result = await request("/watch", { channelId, threadId: state.threadId }, scope);
  if (scope.signal.aborted) return;
  const recovered = result.recovered ?? result;
  const paused = recovered.paused?.length, blocked = recovered.blocked?.length;
  message(paused !== undefined && blocked !== undefined ? `已扫描过期执行，暂停 ${paused} 项，阻断 ${blocked} 项。` : "已扫描本线程的过期执行。");
  await loadTasks();
}));

void connect();
