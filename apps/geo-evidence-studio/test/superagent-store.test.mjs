import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { sha256 } from "../lib/core.mjs";
import { GeoEvidenceService } from "../lib/service.mjs";
import { GeoStore } from "../lib/store.mjs";

const installationScope = { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "future-frontdesk" };
const scope = { ...installationScope, channelId: "inbox", threadId: "research-a" };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "geo-superagent-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "studio.sqlite");
  let now = Date.parse("2026-11-04T01:00:00.000Z");
  const stores = [];
  function open(options = {}) {
    const store = new GeoStore(path, { clock: () => now, ...options });
    stores.push(store);
    return store;
  }
  t.after(() => {
    for (const store of stores) store.close();
  });
  return { dir, path, open, advance: (ms) => { now += ms; } };
}

function request(store, eventId = "event-1", target = scope) {
  return store.admit(target, { eventId, kind: "request", text: "研究公开资料", params: { a: 1, b: 2 } });
}

function followup(store, taskId, eventId, text, target = scope) {
  return store.admit(target, { eventId, kind: "followup", taskId, text });
}

test("admission deduplicates exact scope and content and exposes only scoped inline/spilled events", async (t) => {
  const env = await fixture(t);
  const store = env.open({ installationScope }).superagent;
  const { task, event, replay } = request(store);
  assert.equal(replay, false);
  assert.equal(task.status, "queued");
  assert.equal(task.latestEventCursor, event.cursor);
  assert.equal(event.storage, "inline");
  assert.deepEqual(store.admit(scope, {
    eventId: "event-1", kind: "request", text: "研究公开资料", params: { b: 2, a: 1 },
  }), { event, task, replay: true });
  assert.throws(() => store.admit(scope, {
    eventId: "event-1", kind: "request", text: "更改内容", params: { a: 1, b: 2 },
  }), { code: "event_conflict", statusCode: 409 });

  const longText = "研🧭".repeat(500) + "独立尾标";
  const follow = followup(store, task.taskId, "event-2", longText);
  assert.equal(follow.event.storage, "spill");
  assert.equal(follow.event.preview.includes("独立尾标"), false);
  assert.equal(Object.hasOwn(store.listEvents(scope, task.taskId)[1], "text"), false);
  assert.equal(store.readEvent(scope, task.taskId, "event-2").text, longText);
  assert.deepEqual(store.readEvent(scope, task.taskId, "event-1").params, { a: 1, b: 2 });
  const changedQuery = store.admit(scope, {
    eventId: "query-edit", kind: "followup", taskId: task.taskId, text: longText, params: { query: "新搜索词" },
  });
  assert.equal(changedQuery.event.hasQuery, true);
  assert.equal(store.listEvents(scope, task.taskId).find((item) => item.eventId === "query-edit").hasQuery, true);
  assert.equal(Object.hasOwn(changedQuery.event, "params"), false);

  for (const field of Object.keys(scope)) {
    const other = { ...scope, [field]: "scope-other" };
    assert.equal(store.getTask(other, task.taskId), null);
    assert.throws(() => store.readEvent(other, task.taskId, "event-2"), { code: "not_found", statusCode: 404 });
    assert.throws(() => followup(store, task.taskId, "cross-scope", "必须拒绝", other), { code: "not_found" });
  }
  const otherThread = { ...scope, threadId: "research-b" };
  const otherTask = request(store, "event-1", otherThread).task;
  assert.notEqual(task.taskId, otherTask.taskId);
  assert.deepEqual(store.listActiveScopes(installationScope), [scope, otherThread]);
  assert.deepEqual(store.listActiveScopes({ ...installationScope, projectId: "unrelated" }), []);
  assert.throws(() => followup(store, otherTask.taskId, "event-2", "必须拒绝"), { code: "event_conflict" });
});

test("claim freezes a revision and followups queue the same task after the frozen revision completes", async (t) => {
  const env = await fixture(t);
  const store = env.open().superagent;
  const id = request(store).task.taskId;
  const first = store.claim(scope, id);
  const cursor = first.task.runEventCursor;
  assert.throws(() => store.claim(scope, id), { code: "task_unavailable" });
  assert.equal(store.listTasks(scope, { status: "queued" }).length, 0);
  store.beginStage(scope, id, first.leaseToken, { stage: "plan", input: { cursor } });
  const extra = followup(store, id, "supplement", "补充证据");
  assert.equal(extra.task.revision, 1);
  assert.ok(extra.event.cursor > cursor);
  assert.equal(store.listEvents(scope, id, { throughCursor: cursor }).length, 1);
  const next = store.commitStage(scope, id, first.leaseToken, {
    stage: "plan", evidence: { result: "第一轮" }, complete: true,
  });
  assert.equal(next.status, "queued");
  assert.equal(next.revision, 2);
  assert.equal(next.completedEventCursor, cursor);
  assert.equal(next.checkpoint, null);
  assert.equal(next.history[0].revision, 1);
  assert.equal(store.getTaskRevision(scope, id, 1)[0].evidence.result, "第一轮");
  assert.throws(() => store.renew(scope, id, first.leaseToken), { code: "stale_lease" });

  const second = store.claim(scope, id);
  assert.equal(second.task.runEventCursor, extra.event.cursor);
  store.beginStage(scope, id, second.leaseToken, { stage: "plan", input: { cursor: extra.event.cursor } });
  const complete = store.commitStage(scope, id, second.leaseToken, {
    stage: "plan", evidence: { result: "第二轮" }, complete: true,
  });
  assert.equal(complete.status, "completed");
  assert.equal(complete.checkpoint.revision, 2);
  assert.equal(complete.checkpoint.evidence.result, "第二轮");
  assert.equal(complete.completedEventCursor, extra.event.cursor);
  const late = followup(store, id, "supplement-later", "继续核对");
  assert.equal(late.task.revision, 3);
  assert.equal(late.task.status, "queued");
  assert.equal(late.task.taskId, id);
  assert.equal(followup(store, id, "supplement-later", "继续核对").replay, true);
});

test("separate connections recover scoped expired leases and fence late commits and ambiguous requests", async (t) => {
  const env = await fixture(t);
  const worker = env.open().superagent;
  const watch = env.open().superagent;
  const local = request(worker, "local").task.taskId;
  const external = request(worker, "external").task.taskId;
  const active = request(worker, "active").task.taskId;
  const other = { ...scope, threadId: "other" };
  const otherId = request(worker, "elsewhere", other).task.taskId;
  const localLease = worker.claim(scope, local, { leaseMs: 10 }).leaseToken;
  const externalLease = worker.claim(scope, external, { leaseMs: 10 }).leaseToken;
  const activeLease = worker.claim(scope, active, { leaseMs: 10 }).leaseToken;
  worker.claim(other, otherId, { leaseMs: 10 });
  worker.renew(scope, active, activeLease, { leaseMs: 20 });
  assert.equal(worker.beginStage(scope, local, localLease, { stage: "prepare", input: { version: 1 } }).attempt, 1);
  worker.beginStage(scope, external, externalLease, { stage: "search", external: true, input: { query: "公开查询" } });
  assert.throws(() => worker.beginStage(scope, external, externalLease, { stage: "search", external: true }), {
    code: "stage_conflict",
  });
  env.advance(10);

  assert.throws(() => worker.commitStage(scope, external, externalLease, { stage: "search", evidence: { result: "迟到" } }), {
    code: "stale_lease",
  });
  assert.deepEqual(watch.recoverExpired(scope), { paused: [local], blocked: [external] });
  assert.deepEqual(watch.recoverExpired(scope), { paused: [], blocked: [] });
  assert.equal(watch.getTask(scope, active).status, "running");
  assert.equal(watch.getTask(other, otherId).status, "running");
  assert.equal(watch.getTask(scope, external).reason, "external_dispatch_ambiguous");
  assert.equal(watch.getTask(scope, external).failures[0].ambiguous, true);
  assert.equal(watch.getTask(scope, external).pendingStage.stage, "search");
  assert.throws(() => watch.resume(scope, external), { code: "task_unavailable" });
  assert.throws(() => watch.claim(scope, external), { code: "task_unavailable" });

  assert.equal(watch.resume(scope, local).status, "queued");
  const resumed = watch.claim(scope, local, { leaseMs: 10 }).leaseToken;
  assert.notEqual(resumed, localLease);
  assert.throws(() => worker.beginStage(scope, local, localLease, { stage: "prepare" }), { code: "stale_lease" });
  assert.throws(() => watch.beginStage(scope, local, resumed, { stage: "prepare", input: { version: 2 } }), {
    code: "stage_conflict",
  });
  assert.equal(watch.beginStage(scope, local, resumed, { stage: "prepare", input: { version: 1 } }).attempt, 2);
  const done = watch.commitStage(scope, local, resumed, { stage: "prepare", evidence: { saved: true }, complete: true });
  assert.equal(done.status, "completed");
  assert.match(done.checkpoint.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(env.open().superagent.getTask(scope, local), done);
});

test("known external failure preserves both immutable usage receipts and stops after two attempts", async (t) => {
  const store = (await fixture(t)).open().superagent;
  const id = request(store).task.taskId;
  const begin = { stage: "review", external: true, input: { query: "公开问题" } };
  const first = store.claim(scope, id).leaseToken;
  store.beginStage(scope, id, first, begin);
  const paused = store.fail(scope, id, first, { reason: "invalid_response", receipt: { tokens: 23, id: "upstream-1" } });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pendingStage, null);
  assert.equal(paused.failures[0].receipt.tokens, 23);
  assert.equal(paused.failures[0].ambiguous, false);
  store.resume(scope, id);
  const second = store.claim(scope, id).leaseToken;
  assert.equal(store.beginStage(scope, id, second, begin).attempt, 2);
  const blocked = store.fail(scope, id, second, { reason: "invalid_response", receipt: { tokens: 24, id: "upstream-2" } });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "stage_attempt_limit");
  assert.deepEqual(blocked.failures.map((item) => item.receipt.id), ["upstream-1", "upstream-2"]);
  assert.throws(() => store.resume(scope, id), { code: "task_unavailable" });
});

test("event size, identifier, and followup bounds fail without changing stored events", async (t) => {
  const store = (await fixture(t)).open().superagent;
  const id = request(store).task.taskId;
  assert.throws(() => followup(store, id, "large", "字".repeat(24_001)), { code: "payload_too_large", statusCode: 413 });
  assert.throws(() => followup(store, id, "bad/id", "文字"), { code: "invalid_input" });
  assert.throws(() => followup(store, id, "bad-text", "字\u0000"), { code: "invalid_input" });
  for (let index = 0; index < 32; index += 1) {
    followup(store, id, `follow-${index}`, index === 0 ? "字".repeat(24_000) : `补充 ${index}`);
  }
  assert.throws(() => followup(store, id, "overflow", "额外事件"), { code: "event_limit" });
  assert.equal(store.listEvents(scope, id).length, 33);
  assert.equal(followup(store, id, "follow-31", "补充 31").replay, true);
});

test("a legacy database retains its articles and binds installation scope on trusted startup", async (t) => {
  const env = await fixture(t);
  const legacy = new DatabaseSync(env.path);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE articles (
      id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      markdown TEXT NOT NULL, query_ids_json TEXT NOT NULL, status TEXT NOT NULL,
      data_mode TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const content = "已存在的本地草案";
  legacy.prepare("INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("article-legacy", "selection-guide", "标题", "legacy", content, "[]", "draft", "draft", sha256(content), "2026-11-03");
  legacy.close();
  const first = env.open({ installationScope });
  assert.equal(first.getMeta("schema_version"), "2");
  assert.equal(first.getArticle("article-legacy").markdown, content);
  assert.deepEqual(env.open().installationScope, installationScope);
  assert.throws(() => env.open({ installationScope: { ...installationScope, workspaceId: "foreign" } }), {
    code: "scope_forbidden", statusCode: 403,
  });
  assert.equal(first.archiveArticle("article-legacy", installationScope).contentSha256, sha256(content));
});

test("legacy queue and archive enforce installation scope and cannot claim external publication", async (t) => {
  const env = await fixture(t);
  const store = env.open({ installationScope });
  const service = new GeoEvidenceService(store, { rootDir: env.dir, env: {} });
  const bridgeScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId };
  const article = (await service.handleTool("geo.rewrite", { topicIds: ["selection-guide"], dataMode: "real" }, bridgeScope)).result.created[0];
  assert.equal(article.data_mode, "draft");
  await assert.rejects(service.handleTool("geo_queue.emit", { articleId: article.id }, {
    ...bridgeScope, workspaceId: "foreign",
  }), { code: "scope_forbidden", statusCode: 403 });
  await assert.rejects(service.handleTool("archive.write_back", { articleId: article.id }, {
    ...bridgeScope, projectId: "foreign",
  }), { code: "scope_forbidden", statusCode: 403 });
  await assert.rejects(service.handleTool("archive.write_back", { fixtureOnly: true }, bridgeScope), { code: "invalid_input" });
  await assert.rejects(service.handleTool("geo_queue.emit", { articleId: article.id, channel: "webhook" }, bridgeScope), {
    code: "publish_forbidden",
  });
  assert.equal(store.listPublications().length, 0);
  const queued = await service.handleTool("geo_queue.emit", { articleId: article.id }, bridgeScope);
  assert.equal(queued.result.status, "queued");
  assert.match(queued.receipt.snapshot_uri, /^geo-evidence:\/\/queue\/publication-/);
  assert.equal(store.listPublications()[0].status, "queued");

  let webhookHits = 0;
  const webhook = createServer((_, response) => {
    webhookHits += 1;
    response.end();
  });
  await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => webhook.close(resolve)));
  const webhookUrl = `http://127.0.0.1:${webhook.address().port}/publish`;
  const refused = await service.handleTool("rpa.source_publish", {
    articleId: article.id, channel: "webhook", approvedBy: "claimed", webhookUrl,
  }, bridgeScope);
  assert.equal(refused.result.state, "review-required");
  assert.equal(refused.receipt.synced, false);
  await assert.rejects(service.publishArticle({
    articleId: article.id, channel: "webhook", approvedBy: "operator", webhookUrl,
  }), { code: "publish_forbidden" });
  assert.equal(webhookHits, 0);
  assert.equal(store.listPublications().length, 1);
  await assert.rejects(service.publishArticle({ articleId: article.id, approvedBy: " " }), { code: "approval_required" });
  const exported = await service.publishArticle({ articleId: article.id, approvedBy: "operator" });
  assert.equal(sha256(await readFile(new URL(exported.url), "utf8")), article.evidence_hash);

  const archived = await service.handleTool("archive.write_back", { articleId: article.id }, bridgeScope);
  assert.equal(archived.receipt.synced, true);
  assert.match(archived.receipt.snapshot_uri, /^geo-evidence:\/\/archive\/archive-/);
  assert.deepEqual(await service.handleTool("archive.write_back", { articleId: article.id }, bridgeScope), archived);
  const records = store.db.prepare("SELECT * FROM local_article_archives").all();
  assert.equal(records.length, 1);
  assert.equal(records[0].content_sha256, article.evidence_hash);
  assert.equal(JSON.parse(records[0].snapshot_json).markdown, article.markdown);
});

test("legacy answer import cannot become provider evidence and citation readback reflects only vendor metadata", async (t) => {
  const store = (await fixture(t)).open({ installationScope });
  const expectedUrl = "https://www.example.com/guidance";
  const receivedUrls = [];
  const timestamp = "2026-11-04T01:00:00.000Z";
  const rootDir = join(store.path, "..");
  const citationAdapter = {
    async fetchPublicEvidence({ url }) {
      receivedUrls.push(url);
      return {
        provider: "deepseek",
        source: { url, title: "公开指引", contentSha256: "a".repeat(64) },
        fetch: { status: 200, bytes: 1234, fetchedAt: timestamp, responseId: "vendor-1" },
      };
    },
  };
  const service = new GeoEvidenceService(store, { rootDir, env: {}, citationAdapter });
  await assert.rejects(service.handleTool("answer.structure", {
    queryId: "ffd-brand-001", answer: "手工数据", dataMode: "real",
  }, installationScope), { code: "invalid_input" });
  assert.equal(store.listRuns().length, 0);
  const imported = await service.handleTool("answer.structure", {
    queryId: "ffd-brand-001", answer: "手工数据",
  }, installationScope);
  assert.equal(imported.result.dataMode, "imported");
  assert.equal(imported.receipt.dataMode, "imported");
  assert.equal(store.listRuns()[0].data_mode, "imported");

  const cross = { ...installationScope, projectId: "foreign" };
  await assert.rejects(service.handleTool("citation.fetch", { url: expectedUrl }, cross), { code: "scope_forbidden" });
  assert.deepEqual(receivedUrls, []);
  const fetched = await service.handleTool("citation.fetch", { url: expectedUrl }, installationScope);
  assert.deepEqual(receivedUrls, [expectedUrl]);
  assert.equal(fetched.result.citation.fetchReceipt.responseId, "vendor-1");
  assert.equal(fetched.result.citation.fetchReceipt.status, 200);
  assert.equal(fetched.result.citation.status, null);
  assert.equal(fetched.result.citation.finalUrl, null);
  assert.equal(fetched.receipt.verified_at, timestamp);
  const unconfigured = new GeoEvidenceService(store, { rootDir, env: {} });
  await assert.rejects(unconfigured.fetchCitation(expectedUrl), { code: "DEEPSEEK_NOT_CONFIGURED" });
});
