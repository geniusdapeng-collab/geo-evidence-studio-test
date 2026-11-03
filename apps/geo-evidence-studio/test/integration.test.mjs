import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GeoStore } from "../lib/store.mjs";
import { GeoEvidenceService } from "../lib/service.mjs";
import { createGeoStudioServer } from "../server.mjs";

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "geo-evidence-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("100-query fixture run reaches evidence, negative incident and publication", async (t) => {
  const root = await fixtureRoot(t);
  const dbPath = join(root, "studio.sqlite");
  const store = new GeoStore(dbPath);
  t.after(() => {
    try { store.close(); } catch {}
  });
  const service = new GeoEvidenceService(store, { rootDir: root });

  const run = await service.runObservations({
    provider: "fixture",
    limit: 100,
    concurrency: 4,
  });
  assert.equal(run.status, "completed");
  assert.equal(run.planned, 100);
  assert.equal(run.successful, 100);
  assert.equal(run.failed, 0);
  assert.ok(run.metrics.evidenceCoverageRate > 0);
  assert.ok(run.metrics.brandNegativeSamples > 0);

  const reanalyzed = service.reanalyzeRun(run.runId);
  assert.equal(reanalyzed.updated, 100);
  assert.equal(reanalyzed.brandNegativeSamples, run.metrics.brandNegativeSamples);

  const summary = service.summary();
  assert.ok(summary.incidents.length > 0);

  const articles = service.generateArticles();
  assert.equal(articles.created.length, 10);
  const regenerated = service.generateArticles({ topicIds: ["selection-guide"], force: true });
  assert.equal(regenerated.created.length, 1);
  assert.notEqual(regenerated.created[0].slug, articles.created.find((article) => article.topic_id === "selection-guide").slug);
  const publication = await service.publishArticle({
    articleId: articles.created[0].id,
    channel: "local",
    approvedBy: "test-qa",
  });
  assert.equal(publication.status, "published");
  assert.match(publication.url, /^file:\/\//);
  assert.match(publication.contentSha256, /^[a-f0-9]{64}$/);

  const report = await service.writeReport({ runId: run.runId });
  assert.match(report.markdownPath, /REPORT\.md$/);
});

test("HTTP API serves health, summary and fixtures securely on loopback", async (t) => {
  const root = await fixtureRoot(t);
  const localSecret = randomUUID();
  const app = createGeoStudioServer({
    rootDir: root,
    dbPath: join(root, "server.sqlite"),
    token: localSecret,
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${base}/api/health`);
  assert.equal(unauthorized.status, 401);

  const health = await fetch(`${base}/api/health`, {
    headers: { authorization: `Bearer ${localSecret}` },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const runResponse = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${localSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "fixture", limit: 10, concurrency: 2 }),
  });
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.successful, 10);

  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /GeoEvidence Studio/);
});

test("WorkLoom tool bridge scopes GEO receipts and rejects caller-approved publication", async (t) => {
  const root = await fixtureRoot(t);
  const bridgeSecret = randomUUID();
  const app = createGeoStudioServer({
    rootDir: root,
    dbPath: join(root, "bridge.sqlite"),
    token: bridgeSecret,
    installationScope: { tenantId: "tenant-test", workspaceId: "workspace-test", projectId: "future-frontdesk" },
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const oldUrl = process.env.GEO_EVIDENCE_STUDIO_TEST_URL;
  const oldToken = process.env.GEO_EVIDENCE_STUDIO_TEST_TOKEN;
  process.env.GEO_EVIDENCE_STUDIO_TEST_URL = `http://127.0.0.1:${address.port}`;
  process.env.GEO_EVIDENCE_STUDIO_TEST_TOKEN = bridgeSecret;
  t.after(() => {
    if (oldUrl === undefined) delete process.env.GEO_EVIDENCE_STUDIO_TEST_URL;
    else process.env.GEO_EVIDENCE_STUDIO_TEST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.GEO_EVIDENCE_STUDIO_TEST_TOKEN;
    else process.env.GEO_EVIDENCE_STUDIO_TEST_TOKEN = oldToken;
  });
  const { createToolExecutorForScope, TOOL_PATTERNS } = await import(
    "../../../bundles/geo-growth/connectors/geo-evidence/executor.mjs"
  );
  assert.ok(TOOL_PATTERNS.includes("visibility.collect"));
  const execute = createToolExecutorForScope({ tenantId: "tenant-test", workspaceId: "workspace-test" });
  const collected = await execute("visibility.collect", {
    provider: "fixture",
    limit: 1,
    queryId: "ffd-brand-001",
  });
  assert.equal(collected.receipt.synced, true);
  assert.equal(collected.receipt.mode, "simulated");

  const generated = await execute("geo.rewrite", { dataMode: "draft" });
  assert.equal(generated.receipt.synced, true);
  const articleId = app.store.listArticles(1)[0].id;
  const published = await execute("rpa.source_publish", {
    articleId,
    channel: "local",
    approvedBy: "bridge-test",
  });
  assert.equal(published.receipt.synced, false);
  assert.equal(published.result.state, "review-required");
  const archive = await execute("archive.write_back", { articleId });
  assert.equal(archive.receipt.synced, true);
  assert.match(archive.receipt.snapshot_uri, /^geo-evidence:\/\/archive\//);
  const replay = await execute("archive.write_back", { articleId });
  assert.equal(replay.receipt.snapshot_uri, archive.receipt.snapshot_uri);
  const foreign = createToolExecutorForScope({ tenantId: "tenant-test", workspaceId: "other" });
  assert.equal((await foreign("geo_queue.emit", { articleId })).receipt.synced, false);
  assert.equal(app.store.listPublications(10).length, 0);
});
