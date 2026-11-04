import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

// A small DOM fixture exercises the shipped modules without adding a browser dependency.
// Real Chrome layout and pointer interaction are checked separately in the audit evidence.
class Element {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.value = ""; this.hidden = false;
    this.checked = false; this.dataset = {}; this.attributes = {}; this.events = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set textContent(value) { this.text = String(value ?? ""); this.replaceChildren(); }
  get textContent() { return (this.text ?? "") + this.children.map((child) => child.textContent).join("\n"); }
  set innerHTML(value) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = []; this.append(...children);
  }
  replaceWith(child) {
    const index = this.parent.children.indexOf(this);
    this.parent.children[index] = child; child.parent = this.parent; this.parent = null;
  }
  get childElementCount() { return this.children.length; }
  get isConnected() { return Boolean(this.root || this.parent?.isConnected); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, work) { this.events[name] = work; }
  async fire(name) { return this.events[name]?.({ preventDefault() {} }); }
}

const tick = async () => { for (let n = 0; n < 12; n += 1) await Promise.resolve(); };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const config = { configured: true, scope: { projectId: "test", workspaceId: "isolated" }, limits: {} };
const completed = { taskId: "task-one", status: "completed", revision: 2, latestEventCursor: 3, stages: [], history: [], failures: [] };
const failed = { revision: 1, stage: "report", attempt: 1, reason: "invalid_report", ambiguous: false,
  failedAt: "2026-11-04T10:00:00Z", receipt: { model: "fixture-model", responseId: "failed-response",
    dataMode: "fixture", usage: { promptTokens: 14, completionTokens: 8, totalTokens: 22 } } };

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

async function harness(module = "superagent", fetcher) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) { const element = new Element(); element.root = true; elements.set(id, element); }
    return elements.get(id);
  };
  get("sa-thread").value = "geo-research";
  const document = { getElementById: get, querySelector: (selector) => get(selector.slice(1)),
    querySelectorAll: () => [], createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element("fragment"), addEventListener() {} };
  const requests = []; let uuid = 0; let changed = false;
  const context = { document, URL, URLSearchParams, AbortController, TextEncoder, console,
    crypto: { randomUUID: () => `event-${++uuid}` }, setTimeout: () => 1, clearTimeout() {},
    studioAuthHeaders: () => ({}), evidenceUrl: () => null,
    updateStudioToken: () => changed,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (fetcher) { const result = await fetcher(url, options); if (result) return result; }
      return response(url.endsWith("/config") ? config : { tasks: [] });
    } };
  let source = await readFile(new URL(`../public/${module}.js`, import.meta.url), "utf8");
  source = source.replace(/^import .*\n/, "").replaceAll("export function ", "function ");
  source += module === "superagent"
    ? "\nglobalThis.ui = { state, renderTaskDetail, renderStages, loadDetail, loadTasks, selectTask, submitEvent };"
    : "\nglobalThis.ui = { state, runFixture, generateArticles, updateStudioToken, refresh };";
  runInNewContext(source, context, { filename: `${module}.js` });
  await tick();
  return { ...context.ui, get, requests, setChanged: (value) => { changed = value; } };
}

test("failed response ID, usage and ambiguity are visible with a failure-only historical revision", async () => {
  const ui = await harness();
  const task = { ...completed, failures: [failed] };
  ui.renderTaskDetail(task, []);
  const select = descendants(ui.get("sa-detail")).find((element) => element.tagName === "select");
  assert.ok(select, "a revision with only failures must remain selectable");
  assert.ok(select.children.some((option) => option.value === "1"));
  const blocks = ui.renderStages(task, [], 1, [failed, { ...failed, attempt: 2, ambiguous: true, receipt: null }]);
  const text = blocks.map((element) => element.textContent).join("\n");
  for (const expected of ["failed-response", "22", "invalid_report", "结果不明", "本机夹具"]) assert.ok(text.includes(expected), expected);
});

test("poll refreshes changed failure receipts even with identical task status and stage counts", async () => {
  let task = { ...completed, failures: [] };
  const ui = await harness("superagent", (url) => url.includes("/tasks/task-one?") && response({ task, events: [] }));
  ui.state.taskId = task.taskId;
  await ui.loadDetail(task.taskId);
  task = { ...task, failures: [{ ...failed, revision: 2 }] };
  await ui.loadDetail(task.taskId);
  assert.match(ui.get("sa-detail").textContent, /failed-response/);
});

test("an empty task refresh removes stale selection and write controls", async () => {
  const ui = await harness();
  ui.state.taskId = completed.taskId; ui.state.selectedTask = completed;
  ui.renderTaskDetail(completed, []);
  await ui.loadTasks();
  assert.equal(ui.state.taskId, "");
  assert.equal(ui.state.selectedTask, null);
  assert.equal(ui.get("sa-followup-form").hidden, true);
  assert.doesNotMatch(ui.get("sa-detail").textContent, /task-one/);
});

test("historical selection survives a refreshed task and reads full failure receipts from the scoped revision", async () => {
  const ui = await harness("superagent", (url) => url.includes("/revisions/1?")
    && response({ stages: [], failures: [failed] }));
  const task = { ...completed, failures: [{ ...failed, receipt: null }] };
  ui.state.taskId = task.taskId;
  ui.state.shownRevision = 1;
  ui.renderTaskDetail(task, []); await tick();
  assert.match(ui.get("sa-detail").textContent, /failed-response/);
  ui.renderTaskDetail({ ...task, latestEventCursor: 4 }, []); await tick();
  assert.equal(ui.state.shownRevision, 1);
  assert.match(ui.get("sa-detail").textContent, /failed-response/);
  assert.ok(ui.requests.filter((request) => request.url.includes("/revisions/1?")).every((request) => request.url.includes("threadId=geo-research")));
});

test("historical revision remains readable when an older server only returns stages", async () => {
  const ui = await harness("superagent", (url) => url.includes("/revisions/1?") && response({ stages: [] }));
  ui.state.shownRevision = 1;
  ui.renderTaskDetail({ ...completed, failures: [failed] }, []); await tick();
  assert.match(ui.get("sa-detail").textContent, /failed-response/);
});

test("same identity reconnect preserves an unknown-outcome submission's retry ID and draft", async () => {
  const ui = await harness("superagent", (url) => url.endsWith("/events") && Promise.reject(new Error("lost response")));
  ui.get("sa-request").value = "公开研究目标"; ui.get("sa-query").value = "公开资料";
  ui.get("sa-public-request").checked = true;
  ui.submitEvent("request", "sa-request", "sa-query", "sa-public-request"); await tick();
  await ui.get("sa-token-form").fire("submit"); await tick();
  assert.equal(ui.get("sa-request").value, "公开研究目标");
  ui.get("sa-public-request").checked = true;
  ui.submitEvent("request", "sa-request", "sa-query", "sa-public-request"); await tick();
  const posts = ui.requests.filter((entry) => entry.url.endsWith("/events"));
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].body).eventId, JSON.parse(posts[1].body).eventId);
});

test("late fixture result cannot show an old identity's success receipt", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const summary = { case: { name: "Synthetic" }, dataModes: [], metrics: {}, byCategory: [], latestRuns: [], incidents: [] };
  const ui = await harness("app", (url) => {
    if (url === "/api/run") return pending;
    return response(url === "/api/summary" ? summary : { samples: [], queries: [], articles: [], publications: [] });
  });
  const running = ui.runFixture();
  ui.updateStudioToken("next-test-identity"); await tick();
  release(response({ successful: 1, planned: 1 })); await running;
  assert.doesNotMatch(ui.get("toast").textContent, /夹具运行完成/);
  assert.equal(ui.get("run-fixture").disabled, false);
});

test("changed identity clears retry drafts, while a late detail response cannot restore the previous thread", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const ui = await harness("superagent", (url) => url.includes("/tasks/task-one?") && pending);
  ui.get("sa-request").value = "prior identity draft";
  ui.state.requestKeys.set("prior-identity", "event-one");
  ui.state.taskId = completed.taskId;
  const loading = ui.loadDetail(completed.taskId);
  ui.setChanged(true);
  await ui.get("sa-token-form").fire("submit"); await tick();
  release(response({ task: completed, events: [] })); await loading;
  assert.equal(ui.get("sa-request").value, "");
  assert.equal(ui.state.requestKeys.size, 0);
  assert.equal(ui.state.selectedTask, null);
  assert.doesNotMatch(ui.get("sa-detail").textContent, /task-one/);
});
