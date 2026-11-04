import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARTICLE_TOPICS,
  FUTURE_FRONTDESK_CASE,
  analyzeAnswer,
  buildArticleDraft,
  computeMetrics,
  groupMetrics,
  sha256,
} from "./core.mjs";
import { createProvider, getProviderCapabilities } from "./providers.mjs";
import { createGeoSuperAgentDeepSeek } from "./superagent-deepseek.mjs";
import { GeoStateError, requireGeoId } from "./superagent-store.mjs";
import project from "../project.manifest.json" with { type: "json" };

function slugify(value) {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `article-${sha256(value).slice(0, 10)}`;
}

function mergeProviderCitations(analysis, providerCitations = []) {
  const combined = [...(analysis.citations ?? [])];
  const seen = new Set(combined.map((citation) => citation.url));
  for (const citation of providerCitations) {
    if (!citation?.url || seen.has(citation.url)) continue;
    let domain = "";
    try {
      domain = new URL(citation.url).hostname.toLowerCase();
    } catch {
      domain = "";
    }
    combined.push({ ...citation, domain });
    seen.add(citation.url);
  }
  return {
    ...analysis,
    citations: combined,
    ownedCitations: FUTURE_FRONTDESK_CASE.brand.ownedDomains.length === 0
      ? []
      : combined.filter((citation) => FUTURE_FRONTDESK_CASE.brand.ownedDomains
          .some((domain) => citation.domain === domain || citation.domain.endsWith(`.${domain}`))),
    riskyCitations: combined.filter((citation) =>
      FUTURE_FRONTDESK_CASE.negativeDomains.some((domain) =>
        citation.domain === domain || citation.domain.endsWith(`.${domain}`))),
  };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export class GeoEvidenceService {
  constructor(store, { rootDir = process.cwd(), env = process.env, citationAdapter } = {}) {
    this.store = store;
    this.rootDir = resolve(rootDir);
    this.env = env;
    this.citationAdapter = citationAdapter ?? createGeoSuperAgentDeepSeek({ apiKey: env.DEEPSEEK_API_KEY ?? "" });
  }

  health() {
    return {
      ok: true,
      service: project.id,
      version: project.version,
      case: FUTURE_FRONTDESK_CASE.id,
      database: this.store.path,
      providers: getProviderCapabilities(),
      generatedAt: new Date().toISOString(),
    };
  }

  async runObservations({
    provider = "fixture",
    limit = 20,
    category,
    queryIds,
    platform,
    file,
    concurrency = 2,
    model,
    baseUrl,
  } = {}) {
    const adapter = createProvider(provider, {
      platform,
      file,
      model,
      baseUrl,
      apiKey: this.env.DEEPSEEK_API_KEY,
      timeoutMs: this.env.DEEPSEEK_TIMEOUT_MS,
    });
    if (category !== undefined && (typeof category !== "string" || !category.trim())) {
      throw new GeoStateError("invalid_input", "问题分类须为非空文本", 400);
    }
    if (queryIds !== undefined && (!Array.isArray(queryIds) || !queryIds.length || queryIds.length > 1000
      || queryIds.some((id) => typeof id !== "string" || !id))) {
      throw new GeoStateError("invalid_input", "queryIds 须为非空的问题编号数组", 400);
    }
    const allQueries = this.store.listQueries({ category, limit: 1000 });
    const selectedIds = queryIds ? new Set(queryIds) : null;
    if (!allQueries.length || (selectedIds && allQueries.filter((query) => selectedIds.has(query.id)).length !== selectedIds.size)) {
      throw new GeoStateError("query_not_found", "指定范围中没有所选问题", 400);
    }
    const queries = allQueries
      .filter((query) => !selectedIds || selectedIds.has(query.id))
      .slice(0, Math.max(1, Number(limit) || 20));
    await adapter.prepare?.();
    const runId = this.store.createRun({
      provider,
      dataMode: adapter.dataMode,
      platform: adapter.platform,
      model: adapter.model,
      requestedLimit: limit,
      plannedSamples: queries.length,
      notes: [
        "每个问题代表一个计划样本。",
        "真实模式不得用 fixture 回执冒充，结果按 provider 与 dataMode 分开展示。",
      ],
    });
    const evidenceDir = join(this.rootDir, "outputs", "geo-evidence-studio", "evidence", runId);
    await mkdir(evidenceDir, { recursive: true });
    let successful = 0;
    let failed = 0;
    const notes = [];

    await mapLimit(queries, Math.max(1, Math.min(6, Number(concurrency) || 2)), async (query) => {
      const prompt = `请回答酒店采购方会问的问题：${query.text}`;
      try {
        const result = await adapter.answer(query);
        const { answer } = result;
        if (typeof answer !== "string" || !answer.trim()) throw new GeoStateError("answer_missing", "样本缺少有效答案", 422);
        let analysis = analyzeAnswer(query, answer, FUTURE_FRONTDESK_CASE);
        analysis = mergeProviderCitations(analysis, result.citations ?? []);
        const evidenceHash = sha256(JSON.stringify({
          queryId: query.id,
          provider,
          platform: adapter.platform,
          model: result.model ?? adapter.model,
          answer,
          raw: result.raw ?? null,
          citations: analysis.citations,
        }));
        analysis.evidenceHash = evidenceHash;
        const evidencePath = join(evidenceDir, `${query.id}.json`);
        await writeFile(evidencePath, `${JSON.stringify({
          schemaVersion: "geo-evidence/v1",
          dataMode: adapter.dataMode,
          provider,
          platform: adapter.platform,
          model: result.model ?? adapter.model,
          query,
          prompt,
          answer,
          citations: analysis.citations,
          analysis,
          raw: result.raw ?? null,
          evidenceHash,
          capturedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        this.store.insertSample({
          runId,
          query,
          platform: adapter.platform,
          model: result.model ?? adapter.model,
          provider,
          dataMode: adapter.dataMode,
          prompt,
          answer,
          citations: analysis.citations,
          analysis,
          raw: result.raw,
          screenshotUri: `file://${evidencePath}`,
          status: "success",
        });
        successful += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`${query.id}: ${message}`);
        this.store.insertSample({
          runId,
          query,
          platform: adapter.platform,
          model: adapter.model,
          provider,
          dataMode: adapter.dataMode,
          prompt,
          answer: "",
          citations: [],
          analysis: {},
          raw: null,
          status: "failed",
          error: message,
        });
      }
    });

    const status = failed === 0 ? "completed" : successful > 0 ? "partial" : "failed";
    this.store.finishRun(runId, { status, successful, failed, notes });
    return {
      runId,
      status,
      provider,
      dataMode: adapter.dataMode,
      platform: adapter.platform,
      planned: queries.length,
      successful,
      failed,
      metrics: computeMetrics(this.store.listSamples({ runId, limit: 1000 })),
      notes,
    };
  }

  async ingestAnswer({
    queryId,
    answer,
    platform = "manual",
    model = "manual",
    citations = [],
    dataMode = "imported",
  }) {
    if (!["fixture", "imported"].includes(dataMode)) {
      throw new GeoStateError("invalid_input", "手工导入答案只能标记为 imported 或 fixture", 400);
    }
    if (typeof answer !== "string" || !answer.trim()) throw new GeoStateError("answer_missing", "导入样本须包含有效的答案原文", 400);
    const query = this.store.listQueries({ limit: 1000 }).find((item) => item.id === queryId);
    if (!query) throw new GeoStateError("query_not_found", "当前项目没有所选问题", 400);
    const runId = this.store.createRun({
      provider: "manual-import",
      dataMode,
      platform,
      model,
      requestedLimit: 1,
      plannedSamples: 1,
      notes: ["通过工具桥接导入的答案必须携带原始答案；引用缺证时不得伪造。"],
    });
    let analysis = analyzeAnswer(query, answer, FUTURE_FRONTDESK_CASE);
    analysis = mergeProviderCitations(analysis, citations);
    analysis.evidenceHash = sha256(JSON.stringify({ queryId, answer, citations, platform, model }));
    const evidenceDir = join(this.rootDir, "outputs", "geo-evidence-studio", "evidence", runId);
    await mkdir(evidenceDir, { recursive: true });
    const evidencePath = join(evidenceDir, `${queryId}.json`);
    await writeFile(evidencePath, `${JSON.stringify({
      schemaVersion: "geo-evidence/v1",
      dataMode,
      provider: "manual-import",
      platform,
      model,
      query,
      answer,
      citations: analysis.citations,
      analysis,
      evidenceHash: analysis.evidenceHash,
      capturedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    const sampleId = this.store.insertSample({
      runId,
      query,
      platform,
      model,
      provider: "manual-import",
      dataMode,
      prompt: query.text,
      answer,
      citations: analysis.citations,
      analysis,
      raw: { imported: true },
      screenshotUri: `file://${evidencePath}`,
      status: "success",
    });
    this.store.finishRun(runId, { status: "completed", successful: 1, failed: 0 });
    return { runId, sampleId, dataMode, analysis, evidenceUri: `file://${evidencePath}` };
  }

  reanalyzeRun(runId) {
    const samples = this.store.listSamples({ runId, limit: 5000 });
    const queries = new Map(this.store.listQueries({ limit: 1000 }).map((query) => [query.id, query]));
    let updated = 0;
    let brandNegativeSamples = 0;
    for (const sample of samples) {
      if (sample.status !== "success") continue;
      const query = queries.get(sample.query_id);
      if (!query) continue;
      let analysis = analyzeAnswer(query, sample.answer, FUTURE_FRONTDESK_CASE);
      analysis = mergeProviderCitations(analysis, sample.citations ?? []);
      analysis.evidenceHash = sample.evidence_hash;
      this.store.updateSampleAnalysis(sample.id, { analysis, citations: analysis.citations });
      updated += 1;
      if (analysis.brandNegative) brandNegativeSamples += 1;
    }
    return {
      runId,
      updated,
      brandNegativeSamples,
      metrics: computeMetrics(this.store.listSamples({ runId, limit: 5000 })),
    };
  }

  async fetchCitation(url) {
    const { provider, source, fetch: fetchReceipt } = await this.citationAdapter.fetchPublicEvidence({ url });
    return {
      url: source.url,
      finalUrl: null,
      status: null,
      provider,
      contentType: "text/markdown",
      title: source.title,
      contentSha256: source.contentSha256,
      bytes: fetchReceipt.bytes,
      fetchedAt: fetchReceipt.fetchedAt,
      fetchReceipt,
    };
  }

  summary({ runId } = {}) {
    const samples = this.store.listSamples({ runId, limit: 2000 });
    const successful = samples.filter((sample) => sample.status === "success");
    return {
      case: FUTURE_FRONTDESK_CASE,
      runId: runId ?? null,
      metrics: computeMetrics(samples),
      byCategory: groupMetrics(successful, (row) => row.category),
      byPlatform: groupMetrics(successful, (row) => row.platform),
      latestRuns: this.store.listRuns(10),
      incidents: this.store.listIncidents({ status: "open", limit: 50 }),
      publicationCount: this.store.listPublications(100).length,
      dataModes: [...new Set(samples.map((sample) => sample.dataMode))],
      generatedAt: new Date().toISOString(),
    };
  }

  generateArticles({ topicIds, force = false, dataMode = "draft" } = {}) {
    if (dataMode !== "draft" || typeof force !== "boolean"
      || (topicIds !== undefined && (!Array.isArray(topicIds) || topicIds.some((id) => typeof id !== "string" || !id)))) {
      throw new GeoStateError("invalid_input", "文章生成只支持草案模式、布尔 force 和主题编号数组", 400);
    }
    const queries = this.store.listQueries({ limit: 1000 });
    const existing = this.store.listArticles(1000);
    const selectedTopics = ARTICLE_TOPICS.filter((topic) =>
      !topicIds?.length || topicIds.includes(topic.id));
    const created = [];
    for (const topic of selectedTopics) {
      if (!force && existing.some((article) => article.topic_id === topic.id)) continue;
      const topicQueries = queries.filter((query) => topic.categories.includes(query.category));
      const markdown = buildArticleDraft(topic, topicQueries, FUTURE_FRONTDESK_CASE);
      const id = this.store.createArticle({
        topicId: topic.id,
        title: topic.title,
        slug: `${slugify(topic.id)}-${Date.now().toString(36)}-${sha256(topic.title).slice(0, 8)}`,
        markdown,
        queryIds: topicQueries.map((query) => query.id),
        dataMode,
      });
      created.push(this.store.getArticle(id));
    }
    return {
      created,
      totalArticles: this.store.listArticles(1000).length,
      note: "文章是可审计草案；客户事实、数字、资质、型号和价格未确认时不得对外发布。",
    };
  }

  async publishArticle({ articleId, channel = "local", approvedBy }) {
    if (channel !== "local") {
      throw new GeoStateError("publish_forbidden", "此实例只支持由本地操作员导出文章", 403);
    }
    requireGeoId(articleId, "articleId");
    if (typeof approvedBy !== "string" || !approvedBy.trim() || approvedBy.length > 128) {
      throw new GeoStateError("approval_required", "本地导出需要操作员署名", 403);
    }
    const article = this.store.getArticle(articleId);
    if (!article) throw new GeoStateError("not_found", "当前工作区没有此文章", 404);
    const publicationId = this.store.createPublication({
      articleId,
      channel,
      status: "running",
      receipt: { approvedBy, dataMode: article.data_mode },
    });
    try {
      const outDir = join(this.rootDir, "outputs", "geo-evidence-studio", "published", publicationId);
      await mkdir(outDir, { recursive: true });
      const markdownPath = join(outDir, "article.md");
      const manifestPath = join(outDir, "receipt.json");
      await writeFile(markdownPath, article.markdown, { encoding: "utf8", flag: "wx" });
      const receipt = {
        schemaVersion: "geo-publication/v1",
        articleId,
        channel,
        status: "published",
        url: pathToFileURL(markdownPath).href,
        contentSha256: sha256(article.markdown),
        approvedBy,
        publishedAt: new Date().toISOString(),
        dataMode: article.data_mode,
      };
      await writeFile(manifestPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      this.store.completePublication(publicationId, {
        url: receipt.url,
        receipt: { ...receipt, manifest: pathToFileURL(manifestPath).href },
      });
      return { publicationId, ...receipt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.completePublication(publicationId, { error: message, receipt: { error: message } });
      throw error;
    }
  }

  async writeReport({ runId, outDir } = {}) {
    if (runId !== undefined) {
      requireGeoId(runId, "runId");
      if (!this.store.hasRun(runId)) throw new GeoStateError("run_not_found", "当前工作区没有此观测运行", 404);
    }
    const summary = this.summary({ runId });
    const reportDir = resolve(outDir ?? join(this.rootDir, "outputs", "geo-evidence-studio", "report"));
    await mkdir(reportDir, { recursive: true });
    const targetDir = outDir === undefined ? await mkdtemp(join(reportDir, "snapshot-")) : reportDir;
    const jsonPath = join(targetDir, "summary.json");
    const markdownPath = join(targetDir, "REPORT.md");
    const metric = summary.metrics;
    const pct = (value) => value === null ? "未验证" : `${(value * 100).toFixed(1)}%`;
    const markdown = `# GeoEvidence Studio 运行报告\n\n` +
      `- 案例：${summary.case.name}\n` +
      `- 运行：${summary.runId ?? "全部样本"}\n` +
      `- 数据模式：${summary.dataModes.join(", ") || "无样本"}\n` +
      `- 样本：${metric.successfulSamples}/${metric.totalSamples}\n` +
      `- 品牌提及率：${pct(metric.mentionRate)}\n` +
      `- 首推率：${pct(metric.firstRecommendationRate)}\n` +
      `- 有引用回答率：${pct(metric.citationPresenceRate)}\n` +
      `- 自有信源引用率：${pct(metric.ownedCitationRate)}\n` +
      `- 品牌负面提及率：${pct(metric.brandNegativeMentionRate)}\n` +
      `- 品牌负面引用率：${pct(metric.negativeCitationRate)}\n` +
      `- 证据覆盖率：${pct(metric.evidenceCoverageRate)}\n\n` +
      `> “未验证”表示缺真实采集、缺来源域名或分母为 0，不表示 0%。\n`;
    try {
      await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      await writeFile(markdownPath, markdown, "utf8");
    } catch (error) {
      if (outDir === undefined) {
        try { await rm(targetDir, { recursive: true, force: true }); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "报告写入失败，临时目录清理失败"); }
      }
      throw error;
    }
    return { jsonPath, markdownPath, summary };
  }

  async handleTool(name, params = {}, scope = {}) {
    const installation = this.store.assertInstallationScope(scope);
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new GeoStateError("invalid_input", "工具参数必须是 JSON 对象", 400);
    }
    switch (name) {
      case "visibility.collect": {
        const run = await this.runObservations({
          provider: params.provider ?? "fixture",
          limit: params.limit ?? 1,
          queryIds: params.queryId ? [params.queryId] : undefined,
          platform: params.platform,
        });
        return {
          result: { ...run, scope: installation },
          receipt: {
            synced: run.successful > 0,
            snapshot_uri: `geo-evidence://run/${run.runId}`,
            verified_at: new Date().toISOString(),
            mode: run.dataMode === "fixture" ? "simulated" : "real",
          },
        };
      }
      case "geo.rewrite": {
        const generated = this.generateArticles({
          topicIds: params.topicIds,
          force: params.force,
          dataMode: "draft",
        });
        return {
          result: { ...generated, scope: installation },
          receipt: {
            synced: generated.created.length > 0,
            mode: "real",
            verified_at: new Date().toISOString(),
          },
        };
      }
      case "answer.structure": {
        const result = await this.ingestAnswer({
          queryId: params.queryId,
          answer: params.answer,
          platform: params.platform,
          model: params.model,
          citations: params.citations,
          dataMode: params.dataMode ?? "imported",
        });
        return {
          result: { ...result, scope: installation },
          receipt: {
            synced: true,
            snapshot_uri: result.evidenceUri,
            verified_at: new Date().toISOString(),
            mode: result.dataMode === "fixture" ? "simulated" : "real",
            dataMode: result.dataMode,
          },
        };
      }
      case "citation.fetch": {
        const citation = await this.fetchCitation(String(params.url ?? ""));
        return {
          result: { citation, scope: installation },
          receipt: {
            synced: true,
            snapshot_uri: citation.url,
            verified_at: citation.fetchedAt,
            mode: "real",
          },
        };
      }
      case "geo_queue.emit": {
        requireGeoId(params.articleId, "articleId");
        const article = this.store.getArticle(params.articleId);
        if (!article) throw new GeoStateError("not_found", "当前工作区没有此文章", 404);
        const channel = params.channel ?? "manual";
        if (channel !== "manual") throw new GeoStateError("publish_forbidden", "仅允许写入人工审核队列", 403);
        const publicationId = this.store.createPublication({
          articleId: article.id,
          channel,
          receipt: { queuedBy: "geo_queue.emit", scope: installation },
        });
        return {
          result: { publicationId, articleId: article.id, channel, status: "queued" },
          receipt: { synced: true, mode: "real", snapshot_uri: `geo-evidence://queue/${publicationId}`, verified_at: new Date().toISOString() },
        };
      }
      case "rpa.source_publish": {
        return {
          result: { state: "review-required", scope: installation },
          receipt: { synced: false, mode: "real" },
        };
      }
      case "archive.write_back": {
        if (Object.keys(params).length !== 1 || !Object.hasOwn(params, "articleId")) {
          throw new GeoStateError("invalid_input", "归档只接受一个已存文章的 articleId", 400);
        }
        const archive = this.store.archiveArticle(params.articleId, installation);
        return {
          result: { state: "archived", scope: installation, ...archive },
          receipt: {
            synced: true,
            mode: "real",
            snapshot_uri: `geo-evidence://archive/${archive.archiveId}`,
            verified_at: archive.archivedAt,
          },
        };
      }
      default:
        return {
          result: { state: "connector-required", tool: name, scope: installation },
          receipt: { synced: false, mode: "real" },
        };
    }
  }
}

export function buildSampleMetrics(samples) {
  return computeMetrics(samples);
}
