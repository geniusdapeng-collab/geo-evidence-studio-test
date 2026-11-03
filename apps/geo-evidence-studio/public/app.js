const state = {
  summary: null,
  samples: [],
  queries: [],
  articles: [],
  filter: "all",
};

const $ = (selector) => document.querySelector(selector);
const pct = (value) => value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
let apiToken = "";
let identityRevision = 0;

export function studioAuthHeaders() {
  return apiToken ? { authorization: `Bearer ${apiToken}` } : {};
}

export function evidenceUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function updateStudioToken(value) {
  if (apiToken !== value) {
    apiToken = value;
    identityRevision += 1;
    Object.assign(state, { summary: null, samples: [], queries: [], articles: [] });
    for (const selector of ["#stats", "#category-chart", "#runs", "#samples", "#incidents", "#articles", "#queries", "#incident-count", "#query-count"]) $(selector).replaceChildren();
    $("#case-name").textContent = "正在更新连接…";
    $("#run-note").textContent = "正在重新读取看板。";
    clearTimeout(toast.timer);
    $("#toast").classList.remove("show", "error");
  }
  void refresh().catch((error) => toast(error.message, true));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...studioAuthHeaders(), ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? "请在研究任务工作台更新本地服务访问令牌。" : payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function metricCard(label, value, hint, tone = "") {
  return `<div class="stat ${tone}">
    <span class="label">${escapeHtml(label)}</span>
    <strong class="value">${escapeHtml(value)}</strong>
    <span class="hint">${escapeHtml(hint)}</span>
  </div>`;
}

function renderStats(summary) {
  const m = summary.metrics;
  $("#stats").innerHTML = [
    metricCard("品牌提及率", pct(m.mentionRate), `${m.successfulSamples} 个成功样本`, "good"),
    metricCard("首推率", pct(m.firstRecommendationRate), "品牌在前 160 字且无竞品先行", ""),
    metricCard("有引用回答率", pct(m.citationPresenceRate), "回答是否提供可读取来源", ""),
    metricCard("自有信源引用率", pct(m.ownedCitationRate), m.ownedCitationRate === null ? "客户域名未配置" : "官网或已登记域名", ""),
    metricCard("品牌负面提及率", pct(m.brandNegativeMentionRate), `${m.brandNegativeSamples} 个品牌负面样本`, m.brandNegativeSamples ? "bad" : "good"),
    metricCard("负面引用率", pct(m.negativeCitationRate), m.negativeCitationRate === null ? "需品牌被提及样本" : "品牌负面且引用风险源", "warn"),
  ].join("");
}

function renderCategories(summary) {
  const rows = summary.byCategory.map((row) => {
    const value = row.metrics.mentionRate;
    return `<div class="bar-row">
      <span class="bar-label">${escapeHtml(row.key)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${value === null ? 0 : Math.max(2, value * 100)}%"></div></div>
      <span class="bar-value">${pct(value)}</span>
    </div>`;
  });
  $("#category-chart").innerHTML = rows.join("") || `<p class="muted">暂无成功样本</p>`;
}

function renderRuns(summary) {
  $("#runs").innerHTML = summary.latestRuns.length
    ? summary.latestRuns.map((run) => `<div class="stack-card">
        <div class="stack-top">
          <div>
            <h3>${escapeHtml(run.provider)} · ${escapeHtml(run.platform)}</h3>
            <p>${escapeHtml(run.model ?? "未记录模型")} · ${escapeHtml(run.data_mode)}</p>
          </div>
          <span class="pill ${run.status === "completed" ? "" : "warn"}">${escapeHtml(run.status)}</span>
        </div>
        <p>${run.successful_samples}/${run.planned_samples} 成功 · ${new Date(run.started_at).toLocaleString("zh-CN")}</p>
      </div>`).join("")
    : `<p class="muted">尚无采集运行。</p>`;
}

function sampleMatches(sample) {
  if (state.filter === "brand") return Boolean(sample.analysis?.brandMentioned);
  if (state.filter === "negative") return Boolean(sample.analysis?.brandNegative);
  if (state.filter === "cited") return (sample.analysis?.citations?.length ?? 0) > 0;
  return true;
}

function renderSamples() {
  const rows = state.samples.filter(sampleMatches).slice(0, 60);
  $("#samples").innerHTML = rows.length
    ? rows.map((sample) => {
        const a = sample.analysis ?? {};
        const citations = a.citations ?? [];
        const links = citations.slice(0, 3).map((citation) => {
          const url = evidenceUrl(citation.url);
          return url ? `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(citation.domain || url.hostname)}</a>` : "";
        }).join("");
        return `<tr>
          <td>
            <div class="query">${escapeHtml(sample.query_text)}</div>
            <div class="meta">${escapeHtml(sample.category)} · ${escapeHtml(sample.priority)} · ${new Date(sample.captured_at).toLocaleString("zh-CN")}</div>
          </td>
          <td><span class="pill">${escapeHtml(sample.platform)}</span><div class="meta">${escapeHtml(sample.dataMode ?? sample.data_mode)}</div></td>
          <td><span class="status-dot ${a.brandMentioned ? "yes" : "no"}"></span> ${a.brandMentioned ? "已提及" : "未提及"}${a.ambiguousMentions?.length ? `<div class="meta">${a.ambiguousMentions.length} 个歧义别名</div>` : ""}</td>
          <td><span class="status-dot ${a.brandNegative ? "bad" : a.sentiment === "positive" ? "yes" : "no"}"></span> ${escapeHtml(a.sentiment ?? "unknown")}</td>
          <td><div class="citation-list">${links || `<span class="muted">无解析引用</span>`}</div></td>
          <td><span class="pill">${sample.evidence_hash ? "hash" : "missing"}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6"><span class="muted">没有匹配样本。</span></td></tr>`;
}

function renderIncidents(summary) {
  $("#incident-count").textContent = String(summary.incidents.length);
  $("#incidents").innerHTML = summary.incidents.length
    ? summary.incidents.map((incident) => `<div class="stack-card danger">
        <div class="stack-top">
          <div><h3>${escapeHtml(incident.query_text)}</h3><p>${escapeHtml(incident.claim)}</p></div>
          <span class="pill danger">${escapeHtml(incident.severity)}</span>
        </div>
        <p>${escapeHtml(incident.platform)} · ${escapeHtml(incident.kind)} · ${new Date(incident.created_at).toLocaleString("zh-CN")}</p>
      </div>`).join("")
    : `<p class="muted">当前没有品牌负面事件。</p>`;
}

function renderArticles(articles, publications) {
  const publicationByArticle = new Map(publications.map((item) => [item.article_id, item]));
  $("#articles").innerHTML = articles.length
    ? articles.slice(0, 10).map((article) => {
        const publication = publicationByArticle.get(article.id);
        return `<div class="stack-card">
          <div class="stack-top">
            <div><h3>${escapeHtml(article.title)}</h3><p>${escapeHtml(article.data_mode)} · ${article.queryIds.length} 个问题覆盖</p></div>
            <span class="pill ${publication ? "" : "warn"}">${publication ? escapeHtml(publication.status) : "draft"}</span>
          </div>
          <p>${escapeHtml(article.evidence_hash.slice(0, 16))}…</p>
        </div>`;
      }).join("")
    : `<p class="muted">尚未生成文章草案。</p>`;
}

function renderQueries(queries) {
  $("#query-count").textContent = `${queries.length} queries`;
  const groups = new Map();
  for (const query of queries) {
    const list = groups.get(query.category_label) ?? [];
    list.push(query);
    groups.set(query.category_label, list);
  }
  $("#queries").innerHTML = [...groups.entries()].map(([label, items]) => `<div class="query-card">
    <div class="query-meta"><span class="pill">${escapeHtml(label)}</span><span class="pill">${items.length}</span></div>
    <p>${escapeHtml(items.slice(0, 5).map((item) => item.text).join("；"))}</p>
  </div>`).join("");
}

async function refresh() {
  const revision = identityRevision;
  let snapshot;
  try {
    snapshot = await Promise.all([api("/api/summary"), api("/api/samples?limit=500"), api("/api/queries"), api("/api/articles"), api("/api/publications")]);
  } catch (error) {
    if (revision === identityRevision) throw error;
    return;
  }
  if (revision !== identityRevision) return;
  const [summary, samples, queries, articles, publications] = snapshot;
  state.summary = summary;
  state.samples = samples.samples;
  state.queries = queries.queries;
  state.articles = articles.articles;
  $("#case-name").textContent = summary.case.name;
  $("#run-note").textContent = summary.dataModes.length
    ? `当前数据模式：${summary.dataModes.join(" / ")}。真实模式与夹具模式必须分开解读。`
    : "尚无样本。先运行夹具样本验证链路，再配置真实模型凭据。";
  renderStats(summary);
  renderCategories(summary);
  renderRuns(summary);
  renderSamples();
  renderIncidents(summary);
  renderArticles(articles.articles, publications.publications);
  renderQueries(queries.queries);
}

async function runFixture() {
  const button = $("#run-fixture");
  button.disabled = true;
  button.textContent = "运行中…";
  try {
    const result = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ provider: "fixture", limit: 100, concurrency: 4 }),
    });
    toast(`夹具运行完成：${result.successful}/${result.planned}`);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "运行夹具样本";
  }
}

async function generateArticles() {
  const button = $("#generate-articles");
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const result = await api("/api/articles/generate", {
      method: "POST",
      body: JSON.stringify({ dataMode: "draft" }),
    });
    toast(`生成 ${result.created.length} 篇文章草案，发布前必须人工确认客户事实。`);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "生成文章草案";
  }
}

document.addEventListener("click", (event) => {
  const filter = event.target.closest("[data-filter]");
  if (!filter) return;
  state.filter = filter.dataset.filter;
  document.querySelectorAll(".filter").forEach((node) => node.classList.toggle("active", node === filter));
  renderSamples();
});

$("#refresh").addEventListener("click", () => refresh().catch((error) => toast(error.message, true)));
$("#run-fixture").addEventListener("click", runFixture);
$("#generate-articles").addEventListener("click", generateArticles);

refresh().catch((error) => toast(error.message, true));
