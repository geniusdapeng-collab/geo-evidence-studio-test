import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createGeoStudioServer } from "../server.mjs";

const route = "/api/superagent";
const stageScope = { channelId: "studio", threadId: "hotel-procurement" };
const scopeQuery = "?" + new URLSearchParams(stageScope);
const publicQuery = "酒店采购前台自助机 合规验收 公开资料";
const request = { ...stageScope, eventId: "operator-request", kind: "request",
  text: "为酒店采购负责人整理一条公开可查的验收原则。", params: { query: publicQuery }, publicResearch: true };
const exampleSource = { sourceId: "source-1", url: "https://example.com/policy", title: "公开资料",
  excerpt: "设备采购需验证业务流程及异常处理。", contentSha256: "1".repeat(64), excerptSha256: "2".repeat(64) };

async function setup(t, adapter, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "geo-superagent-http-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const dbPath = join(rootDir, "studio.sqlite");
  const token = randomUUID();
  const apps = new Set();
  t.after(async () => { for (const app of apps) await app.close(); });
  return {
    dbPath,
    async open(extra) {
      const app = createGeoStudioServer({ rootDir, dbPath, token, adapter, pollMs: 20, ...options, ...extra });
      const { port } = await app.listen({ port: 0 });
      apps.add(app);
      const base = `http://127.0.0.1:${port}`;
      return {
        app, base, port,
        async close() { apps.delete(app); await app.close(); },
        async api(path, body, { anonymous = false, headers = {} } = {}) {
          const response = await fetch(base + path, {
            method: body === undefined ? "GET" : "POST",
            headers: { ...(!anonymous && { authorization: `Bearer ${token}` }),
              ...(body !== undefined && { "content-type": "application/json" }), ...headers },
            ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
          });
          return { status: response.status, data: await response.json() };
        },
      };
    },
  };
}

function fakeAdapter({ holdFirstSearch, log }) {
  return {
    configured: true,
    async searchEvidence({ query, signal, beforeRequest }) {
      await beforeRequest();
      log.push({ operation: "search", query });
      if (log.length === 1 && holdFirstSearch) await Promise.race([holdFirstSearch, delay(1500, null, { signal })]);
      return { provider: "deepseek", sources: [exampleSource], search: { resultCount: 1 }, fetch: { status: 200 } };
    },
    async synthesize({ goal, followups, evidence, beforeRequest }) {
      await beforeRequest();
      log.push({ operation: "report", goal, followups });
      assert.equal(evidence.sources[0].sourceId, exampleSource.sourceId);
      return { report: { title: "可审计验收", summary: "公开证据只支持核对流程。", claims: [{ text: "验收异常处理", sourceIds: [exampleSource.sourceId] }] },
        model: "deepseek-flash", responseId: "fixture-response", usage: { totalTokens: 95 }, requestSha256: "3".repeat(64) };
    },
  };
}

async function until(probe, message) {
  for (let i = 0; i < 160; i += 1) {
    const result = await probe();
    if (result) return result;
    await delay(15);
  }
  assert.fail(message);
}

test("Studio public research is authenticated, scoped, durable across restart, idempotent and revision-aware", async (t) => {
  const log = [];
  let resolveSearch;
  const holdFirstSearch = new Promise((resolve) => { resolveSearch = resolve; });
  const testbed = await setup(t, fakeAdapter({ holdFirstSearch, log }));
  const first = await testbed.open({ startWorker: false });
  assert.equal((await first.api(route + "/config", undefined, { anonymous: true })).status, 401);
  assert.equal((await first.api(route + "/events", request, { headers: { origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await first.api(route + "/events", { ...request, publicResearch: false })).data.code, "public_research_required");
  assert.equal((await first.api(route + "/events", { ...request, tenantId: "foreign" })).status, 400);
  assert.equal((await first.api(route + "/events", { ...request, params: { query: "证".repeat(129) } })).status, 400);
  assert.equal((await first.api(route + "/events", { ...request, text: "contact private@example.com" })).data.code, "private_material");
  assert.equal((await first.api(route + "/events", "broken-json")).status, 400);
  assert.equal((await first.api(route + "/events", request, { headers: { "content-type": "text/plain" } })).status, 415);

  const admitted = await first.api(route + "/events", request);
  assert.equal(admitted.status, 202);
  const { taskId } = admitted.data.task;
  assert.equal(admitted.data.task.status, "queued");
  const detail = route + "/tasks/" + taskId;
  assert.equal((await first.api(route + "/events", request)).status, 200);
  assert.equal((await first.api(route + "/events", { ...request, text: "changed same identity" })).status, 409);
  assert.equal((await first.api(detail + "?threadId=elsewhere")).status, 404);
  assert.equal((await first.api(detail + "/events/operator-request?threadId=elsewhere")).status, 404);
  assert.equal((await first.api("/api/publish", { articleId: "fake", approvedBy: "forged" })).status, 403);
  assert.equal((await first.api("/api/run", { provider: "deepseek", baseUrl: "https://wrong.invalid" })).status, 400);
  assert.equal((await first.api("/api/report", { outDir: "/tmp" })).status, 400);
  await first.close();
  assert.equal(log.length, 0);

  const second = await testbed.open();
  await until(() => log.length, "persisted queued task never began");
  const followup = { ...stageScope, taskId, eventId: "operator-followup", kind: "followup", publicResearch: true,
    text: "公开验收材料。".repeat(1_400) + "附加要求：分清证据和建议。" };
  const attached = await second.api(route + "/events", followup);
  assert.equal(attached.status, 202);
  assert.equal(attached.data.event.storage, "spill");
  assert.equal((await second.api(route + "/events", followup)).status, 200);
  assert.equal((await second.api(route + "/events", { ...followup, eventId: "wrong-thread", threadId: "elsewhere" })).status, 404);
  const readback = await second.api(detail + "/events/operator-followup" + scopeQuery);
  assert.equal(readback.data.event.text, followup.text);
  resolveSearch();
  const completed = await until(async () => {
    const { data } = await second.api(detail + scopeQuery);
    return data.task.status === "completed" && data.task.revision === 2 ? data : null;
  }, "persisted followup did not run the newer revision");
  assert.equal(completed.task.history.length, 2);
  assert.equal(completed.task.completedEventCursor, attached.data.event.cursor);
  assert.equal(completed.task.stages[0].evidence.dataMode, "fixture");
  assert.equal(completed.task.stages[1].evidence.report.claims[0].sourceIds[0], exampleSource.sourceId);
  assert.equal(completed.task.stages[1].input.materials[1].truncated, true);
  assert.equal(log.filter((item) => item.operation === "search").length, 2);
  assert.equal(log.filter((item) => item.operation === "report").length, 2);
  assert.ok(log.every((item) => item.operation !== "search" || item.query === publicQuery));
  assert.equal(log[1].followups.length, 0);
  assert.equal(log[3].followups.length, 1);
  assert.ok(log[3].followups[0].endsWith("附加要求：分清证据和建议。"));
  assert.ok(Buffer.byteLength(log[3].followups[0]) <= 10_000);
  const previous = await second.api(detail + "/revisions/1" + scopeQuery);
  assert.equal(previous.data.stages[1].evidence.responseId, "fixture-response");
});

test("Watchdog separately fences an expired external dispatch and pauses only safe work", async (t) => {
  let now = Date.parse("2026-11-03T18:00:00.000Z");
  const { open } = await setup(t, { configured: false }, { clock: () => now, watchdogMs: 99999, startWorker: false });
  const { app, api, port } = await open();
  const state = app.store.superagent;
  const scope = { ...app.store.installationScope, ...stageScope };
  const pending = (await api(route + "/events", request)).data.task.taskId;
  const clean = (await api(route + "/events", { ...request, eventId: "safe-task" })).data.task.taskId;
  const first = state.claim(scope, pending, { leaseMs: 1_000 });
  state.beginStage(scope, pending, first.leaseToken, { stage: "evidence", external: true });
  state.claim(scope, clean, { leaseMs: 1_000 });
  now += 1_001;
  const watch = await api(route + "/watch", stageScope);
  assert.deepEqual(watch.data, { paused: [clean], blocked: [pending] });
  assert.deepEqual((await api(route + "/watch", stageScope)).data, { paused: [], blocked: [] });
  assert.equal((await api(route + "/tasks/" + pending + "/resume", stageScope)).status, 409);
  assert.equal((await api(route + "/tasks/" + clean + "/resume", stageScope)).status, 202);
  assert.throws(() => state.commitStage(scope, pending, first.leaseToken, { stage: "evidence", evidence: { hash: "wrong" } }),
    { code: "stale_lease" });
  const rejected = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: route + "/config", headers: { host: "rebind.invalid" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(rejected, 403);
});

test("current and historical revision readback retains failed provider receipts only in the task scope", async (t) => {
  const adapter = fakeAdapter({ log: [] });
  const searchEvidence = adapter.searchEvidence;
  const receipt = { operation: "search", requestSha256: "4".repeat(64), responseSha256: "5".repeat(64) };
  let attempts = 0;
  adapter.searchEvidence = async (input) => {
    if (attempts++ === 0) {
      await input.beforeRequest();
      throw Object.assign(new Error("fixture provider returned an unusable result"), {
        code: "no_verified_sources", ambiguous: false, receipt,
      });
    }
    return searchEvidence(input);
  };
  const { open } = await setup(t, adapter);
  const { api } = await open();
  const accepted = await api(route + "/events", request);
  const { taskId } = accepted.data.task;
  const path = route + "/tasks/" + taskId;
  await until(async () => (await api(path + scopeQuery)).data.task.status === "paused", "known failure never paused");
  const current = await api(path + "/revisions/1" + scopeQuery);
  assert.equal(current.status, 200);
  assert.deepEqual(current.data.stages, []);
  assert.equal(current.data.failures.length, 1);
  assert.deepEqual(current.data.failures[0].receipt, { ...receipt, dataMode: "fixture" });
  assert.equal((await api(path + "/resume", stageScope)).status, 202);
  await until(async () => (await api(path + scopeQuery)).data.task.status === "completed", "retry never completed");
  assert.equal((await api(route + "/events", { ...stageScope, kind: "followup", eventId: "new-revision",
    taskId, text: "追加可核验材料。", publicResearch: true })).status, 202);
  const prior = await api(path + "/revisions/1" + scopeQuery);
  assert.equal(prior.data.stages.length, 2);
  assert.deepEqual(prior.data.failures, current.data.failures);
  assert.equal((await api(path + "/revisions/1?threadId=other")).status, 404);
  assert.equal((await api(path + "/revisions/99" + scopeQuery)).status, 404);
});

test("Studio shutdown can be requested twice without closing the SQLite handles twice", async (t) => {
  const { open } = await setup(t, { configured: false });
  const { close, app } = await open();
  await Promise.all([close(), app.close()]);
  await app.close();
  assert.equal(app.server.listening, false);
});

test("Studio close during localhost bind drains startup and leaves no listening server", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "geo-superagent-startup-"));
  const app = createGeoStudioServer({ rootDir, dbPath: join(rootDir, "studio.sqlite"), adapter: { configured: false },
    onError: () => {} });
  t.after(async () => {
    await app.close();
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });
  const opening = app.listen({ port: 0, host: "localhost" });
  const closing = app.close();
  await Promise.allSettled([opening, closing]);
  await closing;
  assert.equal(app.server.listening, false);
  assert.equal(app.store.db.isOpen, false);
  await app.close();
  await assert.rejects(app.listen({ port: 0 }), { code: "server_closed" });
});

test("Studio can retry listening after an initial occupied-port failure", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "geo-superagent-bind-retry-"));
  const busy = http.createServer();
  await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
  const app = createGeoStudioServer({ rootDir, dbPath: join(rootDir, "studio.sqlite"), adapter: { configured: false } });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => busy.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });
  await assert.rejects(app.listen({ port: busy.address().port, host: "127.0.0.1" }), { code: "EADDRINUSE" });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  assert.ok(address.port > 0);
  assert.equal(app.server.listening, true);
  await app.close();
  assert.equal(app.store.db.isOpen, false);
});

test("Studio shutdown during a failed bind keeps retry closed and releases SQLite", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "geo-superagent-failed-startup-"));
  const busy = http.createServer();
  await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
  const app = createGeoStudioServer({ rootDir, dbPath: join(rootDir, "studio.sqlite"), adapter: { configured: false } });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => busy.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });
  const opening = app.listen({ port: busy.address().port, host: "127.0.0.1" });
  const closing = app.close();
  const [opened, closed] = await Promise.allSettled([opening, closing]);
  assert.equal(opened.status, "rejected");
  assert.equal(opened.reason.code, "EADDRINUSE");
  assert.equal(closed.status, "fulfilled");
  assert.equal(app.server.listening, false);
  assert.equal(app.store.db.isOpen, false);
  await assert.rejects(app.listen({ port: 0 }), { code: "server_closed" });
});
