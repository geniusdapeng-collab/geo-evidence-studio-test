import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { CASE_VERSION, FUTURE_FRONTDESK_CASE, buildFutureFrontdeskQueries, sha256 } from "./core.mjs";
import { GeoStateError, GeoSuperagentStore, requireGeoId } from "./superagent-store.mjs";

const installationFields = ["tenantId", "workspaceId", "projectId"];
const defaultInstallation = { tenantId: "local", workspaceId: "local", projectId: FUTURE_FRONTDESK_CASE.id };

export function normalizeInstallationScope(scope = defaultInstallation) {
  return Object.fromEntries(installationFields.map((field) => [field, requireGeoId(scope?.[field], field)]));
}

export function assertInstallationScope(scope, installationScope, { requireProject = false } = {}) {
  const fields = requireProject || scope?.projectId !== undefined ? installationFields : installationFields.slice(0, 2);
  if (fields.some((field) => scope?.[field] !== installationScope[field])) {
    throw new GeoStateError("scope_forbidden", "请求范围与本地工作区绑定不一致", 403);
  }
  return installationScope;
}

function now() {
  return new Date().toISOString();
}

function asJson(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function defaultDatabasePath(root = process.cwd()) {
  return resolve(root, "var/geo-evidence-studio-test.sqlite");
}

export class GeoStore {
  constructor(databasePath = defaultDatabasePath(), { installationScope, clock } = {}) {
    this.path = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.initialize(installationScope);
      this.superagent = new GeoSuperagentStore(this.db, { clock });
      this.setMeta("schema_version", "2");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  initialize(installationScope) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queries (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        case_version TEXT NOT NULL,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        category_label TEXT NOT NULL,
        priority TEXT NOT NULL,
        risk INTEGER NOT NULL,
        product TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        platform TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        requested_limit INTEGER NOT NULL,
        planned_samples INTEGER NOT NULL DEFAULT 0,
        successful_samples INTEGER NOT NULL DEFAULT 0,
        failed_samples INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        notes_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS samples (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        query_id TEXT NOT NULL REFERENCES queries(id),
        platform TEXT NOT NULL,
        model TEXT,
        provider TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        prompt TEXT NOT NULL,
        answer TEXT NOT NULL DEFAULT '',
        citations_json TEXT NOT NULL DEFAULT '[]',
        analysis_json TEXT NOT NULL DEFAULT '{}',
        raw_json TEXT,
        evidence_hash TEXT,
        screenshot_uri TEXT,
        status TEXT NOT NULL,
        error TEXT,
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_samples_run ON samples(run_id);
      CREATE INDEX IF NOT EXISTS idx_samples_query ON samples(query_id);
      CREATE INDEX IF NOT EXISTS idx_samples_platform ON samples(platform);

      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        markdown TEXT NOT NULL,
        query_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id),
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT,
        receipt_json TEXT NOT NULL,
        published_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        sample_id TEXT NOT NULL REFERENCES samples(id),
        query_id TEXT NOT NULL REFERENCES queries(id),
        severity TEXT NOT NULL,
        kind TEXT NOT NULL,
        claim TEXT NOT NULL,
        source_urls_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_article_archives (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL UNIQUE REFERENCES articles(id),
        content_sha256 TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const configuredScope = installationScope === undefined ? undefined : normalizeInstallationScope(installationScope);
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('installation_scope', ?) ON CONFLICT(key) DO NOTHING")
      .run(asJson(configuredScope ?? defaultInstallation));
    const boundScope = normalizeInstallationScope(JSON.parse(this.getMeta("installation_scope")));
    if (configuredScope) assertInstallationScope(configuredScope, boundScope, { requireProject: true });
    this.installationScope = Object.freeze(boundScope);
    this.seedCase();
  }

  assertInstallationScope(scope, options) {
    return assertInstallationScope(scope, this.installationScope, options);
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, String(value));
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  }

  seedCase(caseConfig = FUTURE_FRONTDESK_CASE) {
    const insert = this.db.prepare(`
      INSERT INTO queries (
        id, case_id, case_version, text, category, category_label, priority,
        risk, product, status, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text=excluded.text,
        category=excluded.category,
        category_label=excluded.category_label,
        priority=excluded.priority,
        risk=excluded.risk,
        product=excluded.product,
        status=excluded.status,
        source=excluded.source
    `);
    this.db.exec("BEGIN");
    try {
      for (const query of buildFutureFrontdeskQueries(caseConfig)) {
        insert.run(
          query.id,
          caseConfig.id,
          CASE_VERSION,
          query.text,
          query.category,
          query.categoryLabel,
          query.priority,
          query.risk ? 1 : 0,
          query.product,
          query.status,
          query.source,
          now(),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listQueries({ category, risk, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    if (category) {
      where.push("q.category=?");
      params.push(category);
    }
    if (risk !== undefined) {
      where.push("q.risk=?");
      params.push(risk ? 1 : 0);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT q.*,
        (SELECT count(*) FROM samples s WHERE s.query_id=q.id AND s.status='success') AS sample_count,
        (SELECT captured_at FROM samples s WHERE s.query_id=q.id ORDER BY captured_at DESC LIMIT 1) AS last_captured_at
      FROM queries q
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
        category, id
      LIMIT ?
    `).all(...params);
    return rows.map((row) => ({ ...row, risk: Boolean(row.risk) }));
  }

  createRun({ provider, dataMode, platform, model, requestedLimit, plannedSamples, notes = [] }) {
    const id = `run-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO runs (
        id, case_id, provider, data_mode, platform, model, status,
        requested_limit, planned_samples, started_at, notes_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      id,
      FUTURE_FRONTDESK_CASE.id,
      provider,
      dataMode,
      platform,
      model ?? null,
      requestedLimit,
      plannedSamples,
      now(),
      asJson(notes),
    );
    return id;
  }

  finishRun(id, { status, successful, failed, notes = [] }) {
    this.db.prepare(`
      UPDATE runs SET
        status=?,
        successful_samples=?,
        failed_samples=?,
        finished_at=?,
        notes_json=?
      WHERE id=?
    `).run(status, successful, failed, now(), asJson(notes), id);
  }

  insertSample({
    runId,
    query,
    platform,
    model,
    provider,
    dataMode,
    prompt,
    answer,
    citations,
    analysis,
    raw,
    screenshotUri,
    status,
    error,
  }) {
    const id = `sample-${randomUUID()}`;
    const capturedAt = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO samples (
          id, run_id, query_id, platform, model, provider, data_mode, prompt,
          answer, citations_json, analysis_json, raw_json, evidence_hash,
          screenshot_uri, status, error, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        runId,
        query.id,
        platform,
        model ?? null,
        provider,
        dataMode,
        prompt,
        answer ?? "",
        asJson(citations ?? []),
        asJson(analysis ?? {}),
        raw === undefined ? null : asJson(raw),
        analysis?.evidenceHash ?? (answer ? sha256(`${query.id}\n${answer}`) : null),
        screenshotUri ?? null,
        status,
        error ?? null,
        capturedAt,
      );

      if (status === "success" && analysis?.brandNegative) {
        const claim = analysis.negativeBrandSentences?.[0]?.text
          ?? "品牌负向提及";
        this.db.prepare(`
          INSERT INTO incidents (
            id, sample_id, query_id, severity, kind, claim, source_urls_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
        `).run(
          `incident-${randomUUID()}`,
          id,
          query.id,
          query.priority === "P0" ? "P0" : "P1",
          analysis.negativeCitation ? "brand_negative_citation" : "brand_negative_mention",
          claim.slice(0, 500),
          asJson((analysis.riskyCitations ?? []).map((citation) => citation.url)),
          capturedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    return id;
  }

  updateSampleAnalysis(sampleId, { analysis, citations }) {
    const row = this.db.prepare(`
      SELECT s.id, s.query_id, q.priority
      FROM samples s JOIN queries q ON q.id=s.query_id
      WHERE s.id=?
    `).get(sampleId);
    if (!row) throw new Error(`样本不存在：${sampleId}`);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE samples SET analysis_json=?, citations_json=?, evidence_hash=?
        WHERE id=?
      `).run(asJson(analysis), asJson(citations ?? []), analysis.evidenceHash ?? null, sampleId);
      this.db.prepare("DELETE FROM incidents WHERE sample_id=?").run(sampleId);
      if (analysis.brandNegative) {
        const claim = analysis.negativeBrandSentences?.[0]?.text ?? "品牌负向提及";
        this.db.prepare(`
          INSERT INTO incidents (
            id, sample_id, query_id, severity, kind, claim, source_urls_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
        `).run(
          `incident-${randomUUID()}`,
          sampleId,
          row.query_id,
          row.priority === "P0" ? "P0" : "P1",
          analysis.negativeCitation ? "brand_negative_citation" : "brand_negative_mention",
          claim.slice(0, 500),
          asJson((analysis.riskyCitations ?? []).map((citation) => citation.url)),
          now(),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasRun(id) {
    return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(id));
  }

  listRuns(limit = 20) {
    return this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit)
      .map((row) => ({ ...row, notes: parseJson(row.notes_json, []) }));
  }

  listSamples({ runId, queryId, platform, negative, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (runId) {
      where.push("s.run_id=?");
      params.push(runId);
    }
    if (queryId) {
      where.push("s.query_id=?");
      params.push(queryId);
    }
    if (platform) {
      where.push("s.platform=?");
      params.push(platform);
    }
    if (negative) {
      where.push("json_extract(s.analysis_json, '$.brandNegative')=1");
    }
    params.push(limit);
    return this.db.prepare(`
      SELECT s.*, q.text AS query_text, q.category, q.priority
      FROM samples s JOIN queries q ON q.id=s.query_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.captured_at DESC LIMIT ?
    `).all(...params).map((row) => ({
      ...row,
      dataMode: row.data_mode,
      evidenceHash: row.evidence_hash,
      screenshotUri: row.screenshot_uri,
      citations: parseJson(row.citations_json, []),
      analysis: parseJson(row.analysis_json, {}),
      raw: parseJson(row.raw_json, null),
    }));
  }

  listIncidents({ status = "open", limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT i.*, q.text AS query_text, s.platform, s.answer
      FROM incidents i
      JOIN queries q ON q.id=i.query_id
      JOIN samples s ON s.id=i.sample_id
      ${status ? "WHERE i.status=?" : ""}
      ORDER BY i.created_at DESC LIMIT ?
    `).all(...(status ? [status, limit] : [limit])).map((row) => ({
      ...row,
      sourceUrls: parseJson(row.source_urls_json, []),
    }));
  }

  createArticle({ topicId, title, slug, markdown, queryIds, dataMode, status = "draft" }) {
    const id = `article-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO articles (
        id, topic_id, title, slug, markdown, query_ids_json, status,
        data_mode, evidence_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      topicId,
      title,
      slug,
      markdown,
      asJson(queryIds),
      status,
      dataMode,
      sha256(markdown),
      now(),
    );
    return id;
  }

  listArticles(limit = 100) {
    return this.db.prepare("SELECT * FROM articles ORDER BY created_at DESC LIMIT ?").all(limit)
      .map((row) => ({ ...row, queryIds: parseJson(row.query_ids_json, []) }));
  }

  getArticle(id) {
    const row = this.db.prepare("SELECT * FROM articles WHERE id=?").get(id);
    return row ? { ...row, queryIds: parseJson(row.query_ids_json, []) } : null;
  }

  archiveArticle(articleId, scope) {
    this.assertInstallationScope(scope);
    requireGeoId(articleId, "articleId");
    const article = this.getArticle(articleId);
    if (!article) throw new GeoStateError("not_found", "当前工作区没有此文章", 404);
    const snapshot = {
      schemaVersion: "geo-local-archive/v1",
      articleId,
      scope: this.installationScope,
      title: article.title,
      slug: article.slug,
      markdown: article.markdown,
      queryIds: article.queryIds,
      dataMode: article.data_mode,
    };
    if (!["draft", "imported", "real"].includes(article.data_mode) || Buffer.byteLength(article.markdown) > 1024 * 1024) {
      throw new GeoStateError("archive_forbidden", "模拟文章或超出大小限制的文章不能归档", 422);
    }
    const contentHash = sha256(article.markdown);
    if (contentHash !== article.evidence_hash) {
      throw new GeoStateError("archive_integrity", "文章内容与存储的散列不一致");
    }
    this.db.prepare(`
      INSERT INTO local_article_archives (id, article_id, content_sha256, snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(article_id) DO NOTHING
    `).run(`archive-${randomUUID()}`, articleId, contentHash, asJson(snapshot), now());
    const archived = this.db.prepare(`
      SELECT id, content_sha256, created_at FROM local_article_archives WHERE article_id=?
    `).get(articleId);
    if (archived.content_sha256 !== contentHash) {
      throw new GeoStateError("archive_integrity", "归档内容与当前文章散列不一致");
    }
    return { archiveId: archived.id, articleId, contentSha256: archived.content_sha256, archivedAt: archived.created_at };
  }

  createPublication({ articleId, channel, status = "queued", receipt = {} }) {
    const id = `publication-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO publications (
        id, article_id, channel, status, receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, articleId, channel, status, asJson(receipt), now());
    return id;
  }

  completePublication(id, { url, receipt, error = null }) {
    this.db.prepare(`
      UPDATE publications SET
        status=?,
        url=?,
        receipt_json=?,
        published_at=?,
        error=?
      WHERE id=?
    `).run(error ? "failed" : "published", url ?? null, asJson(receipt), error ? null : now(), error, id);
  }

  listPublications(limit = 100) {
    return this.db.prepare(`
      SELECT p.*, a.title AS article_title, a.slug
      FROM publications p JOIN articles a ON a.id=p.article_id
      ORDER BY p.created_at DESC LIMIT ?
    `).all(limit).map((row) => ({ ...row, receipt: parseJson(row.receipt_json, {}) }));
  }

  close() {
    this.db.close();
  }
}
