import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createGeoSuperAgentDeepSeek, GEO_DEEPSEEK_MODEL } from "../lib/superagent-deepseek.mjs";

const apiKey = randomUUID();
const origin = "https://api.deepseek.com";
const sourceUrl = "https://docs.example.com/hotel-guide";
const sourceContent = "# 酒店自助入住\n\n身份证件核验与房卡发放是分开的步骤。";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const searchResults = { results: [{ title: "酒店公开资料", url: sourceUrl, content: "不应采信搜索摘要" }] };
const fetched = { title: "酒店指南", content: sourceContent };

function completion(id, overrides = {}) {
  const report = { title: "酒店研究摘要", summary: "对入住步骤的梳理。",
    claims: [{ text: "核验与发卡可分步执行。", sourceIds: [id] }] };
  return {
    id: "fixture-response-123",
    model: GEO_DEEPSEEK_MODEL,
    choices: [{ finish_reason: "stop", message: {
      role: "assistant", content: JSON.stringify(report),
    } }],
    usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60,
      prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 35 },
    ...overrides,
  };
}

function fixture({ search = searchResults, page = fetched, answer, fetch, resolveHost, timeoutMs, key = apiKey } = {}) {
  const calls = [];
  const resolutions = [];
  const sourceId = "src-" + sha(sourceUrl + "\n" + sha(sourceContent)).slice(0, 16);
  const client = createGeoSuperAgentDeepSeek({
    apiKey: key, timeoutMs, baseUrl: "https://untrusted.example.com",
    async resolveHost(host) {
      resolutions.push(host);
      return resolveHost ? resolveHost(host) : [{ address: "8.8.8.8" }, { address: "2606:4700:4700::1111" }];
    },
    async fetch(url, init) {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (fetch) return fetch(url, init);
      if (url.endsWith("/tools/search")) return Response.json(search, { headers: { "x-request-id": "fixture-search-id" } });
      if (url.endsWith("/tools/fetch")) return Response.json(page, { headers: { "x-request-id": "fixture-fetch-id" } });
      if (url.endsWith("/chat/completions")) return Response.json(answer ? answer(sourceId) : completion(sourceId));
      throw new Error("unexpected fixture URL");
    },
  });
  return { client, calls, resolutions, sourceId };
}

test("sends only bounded official requests and keeps evidence, usage, and supplied citation IDs", async () => {
  const { client, calls, resolutions, sourceId } = fixture();
  const admitted = [];
  const beforeRequest = ({ operation, requestSha256 }) => admitted.push({ operation, requestSha256 });
  const evidence = await client.searchEvidence({ query: "酒店自助入住", beforeRequest });
  const completed = await client.synthesize({ goal: "评估入住核验流程", followups: [{ text: "关注房卡发放" }], evidence, beforeRequest });
  assert.equal(client.configured, true);
  assert.deepEqual(calls.map(({ url }) => url), [
    origin + "/v1/tools/search", origin + "/v1/tools/fetch", origin + "/chat/completions",
  ]);
  assert.deepEqual(resolutions, ["docs.example.com"]);
  assert.deepEqual(calls[0].body, { query: "酒店自助入住", count: 5, need_content: false });
  assert.deepEqual(calls[1].body, { url: sourceUrl });
  for (const { init } of calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer " + apiKey);
  }
  assert.equal(calls[2].body.model, "deepseek-flash");
  assert.deepEqual(calls[2].body.response_format, { type: "json_object" });
  assert.equal(calls[2].body.max_tokens, 2500);
  const modelInput = JSON.parse(calls[2].body.messages[1].content);
  assert.deepEqual(modelInput.followups, ["关注房卡发放"]);
  assert.match(modelInput.sources[0].excerpt, /身份证件核验/);
  assert.equal(JSON.stringify(modelInput).includes("不应采信搜索摘要"), false);
  assert.deepEqual(evidence.sources[0], { sourceId, url: sourceUrl, title: "酒店指南",
    contentSha256: sha(sourceContent), excerpt: sourceContent, excerptSha256: sha(sourceContent) });
  assert.equal(evidence.querySha256, sha("酒店自助入住"));
  assert.equal(evidence.search.responseId, "fixture-search-id");
  assert.equal(evidence.fetch.responseId, "fixture-fetch-id");
  assert.equal(completed.responseId, "fixture-response-123");
  assert.equal(completed.model, "deepseek-flash");
  assert.deepEqual(completed.usage, { promptTokens: 40, completionTokens: 20, totalTokens: 60,
    promptCacheHitTokens: 5, promptCacheMissTokens: 35 });
  assert.deepEqual(completed.report.claims[0].sourceIds, [sourceId]);
  assert.deepEqual(admitted.map((row) => row.operation), ["search", "fetch", "synthesize"]);
  assert.deepEqual(admitted.map((row) => row.requestSha256), [
    evidence.search.requestSha256, evidence.fetch.requestSha256, completed.requestSha256,
  ]);
  for (const result of [evidence.search, evidence.fetch, completed]) {
    assert.match(result.responseSha256, /^[a-f0-9]{64}$/u);
  }
  const serialized = JSON.stringify({ evidence, completed });
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes("fixture private reasoning to discard"), false);
  assert.equal(serialized.includes("reasoning_content"), false);
});

test("skips non-public candidates and mixed public/private DNS answers before vendor Fetch", async () => {
  const bad = ["http://example.com/a", "https://someone:pass@example.com/", "https://example.com/?x=1",
    "https://[::ffff:7f00:1]/", "https://127.1/", "https://localhost/", "https://www.internal/"];
  for (const url of bad) {
    const { client, calls, resolutions } = fixture({
      search: { results: [{ url }, { url: "https://unsafe.example.com/page" }, { url: sourceUrl }] },
      resolveHost: (hostname) => hostname === "unsafe.example.com" ? ["8.8.8.8", "0:0:0:0:0:ffff:7f00:1"] : ["8.8.8.8"],
    });
    const evidence = await client.searchEvidence({ query: "行业研究" });
    assert.deepEqual(resolutions, ["unsafe.example.com", "docs.example.com"], url);
    assert.equal(calls.length, 2, url);
    assert.deepEqual(calls[1].body, { url: sourceUrl }, url);
    assert.equal(evidence.sources[0].url, sourceUrl);
  }
});

test("rejects all unsuitable results without spending a Fetch slot", async () => {
  const { client, calls } = fixture({
    search: { results: [{ url: "https://unsafe.example.com/page" }] },
    resolveHost: () => ["100.100.0.1", "2001:db8::1"],
  });
  await assert.rejects(client.searchEvidence({ query: "行业研究" }), (error) => {
    assert.equal(error.code, "DEEPSEEK_NO_PUBLIC_SOURCE");
    assert.equal(error.ambiguous, false);
    assert.equal(error.receipt.search.responseId, "fixture-search-id");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("the Search limit counts Unicode code points and rejects malformed input before network", async () => {
  const { client, calls } = fixture();
  for (const query of [" ", "界".repeat(129), "🏨".repeat(129), "\u0000公开", apiKey]) {
    await assert.rejects(client.searchEvidence({ query }), { code: "DEEPSEEK_INVALID_INPUT", ambiguous: false });
  }
  assert.equal(calls.length, 0);
  await client.searchEvidence({ query: "🏨".repeat(128) });
  assert.equal(calls[0].body.query, "🏨".repeat(128));
});

test("missing or invalid credentials do not dispatch", async () => {
  for (const key of ["", "invalid fixture key"]) {
    const { client, calls } = fixture({ key });
    assert.equal(client.configured, false);
    await assert.rejects(client.searchEvidence({ query: "公开数据" }), { code: "DEEPSEEK_NOT_CONFIGURED", ambiguous: false });
    assert.equal(calls.length, 0);
  }
});

test("bounds excerpts at a UTF-8 character boundary and preserves the full content hash", async () => {
  const content = "早".repeat(5000);
  const { client } = fixture({ page: { content, title: "" } });
  const evidence = await client.searchEvidence({ query: "行业研究" });
  const source = evidence.sources[0];
  assert.equal(Buffer.byteLength(source.excerpt), 9999);
  assert.equal(source.excerpt, "早".repeat(3333));
  assert.equal(source.contentSha256, sha(content));
  assert.equal(source.excerptSha256, sha(source.excerpt));
  assert.equal(source.title, "酒店公开资料");
});

test("rejects empty, mismatched and secret-bearing fetched material", async () => {
  for (const page of [{ content: "" }, { content: sourceContent, url: "https://mismatch.example.com/" },
    { content: sourceContent + apiKey }]) {
    const { client, calls } = fixture({ page });
    await assert.rejects(client.searchEvidence({ query: "行业研究" }), (error) => {
      assert.equal(error.code, "DEEPSEEK_INVALID_SOURCE");
      assert.equal(error.ambiguous, false);
      assert.equal(error.receipt.fetch.responseId, "fixture-fetch-id");
      assert.equal(JSON.stringify(error).includes(apiKey), false);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test("rejects tampered evidence and excessive same-thread context before model I/O", async () => {
  const { client, calls } = fixture();
  const evidence = await client.searchEvidence({ query: "行业研究" });
  const corrupted = structuredClone(evidence);
  corrupted.sources[0].excerpt += "添加的未经验证文字";
  await assert.rejects(client.synthesize({ goal: "分析", evidence: corrupted }), { code: "DEEPSEEK_INVALID_INPUT" });
  await assert.rejects(client.synthesize({ goal: "分析", evidence, followups: ["补充一", "补充二", "补充三", "补充四"] }),
    { code: "DEEPSEEK_INVALID_INPUT" });
  assert.equal(calls.length, 2);
});

test("rejects fabricated citation IDs and hyperlinks in model prose while retaining known billing", async () => {
  for (const makeClaim of [
    () => ({ text: "事实", sourceIds: ["fake-source"] }),
    (id) => ({ text: "https://unrelated.example.com/a", sourceIds: [id] }),
    (id) => ({ text: "见 unrelated.example.com", sourceIds: [id] }),
    (id) => ({ text: "重复引用", sourceIds: [id, id] }),
  ]) {
    const { client, calls } = fixture({ answer(id) {
      const body = completion(id);
      const report = JSON.parse(body.choices[0].message.content);
      report.claims = [makeClaim(id)];
      body.choices[0].message.content = JSON.stringify(report);
      return body;
    } });
    const evidence = await client.searchEvidence({ query: "行业研究" });
    await assert.rejects(client.synthesize({ goal: "分析", evidence }), (error) => {
      assert.equal(error.code, "DEEPSEEK_INVALID_REPORT");
      assert.equal(error.ambiguous, false);
      assert.equal(error.receipt.usage.totalTokens, 60);
      assert.equal(error.receipt.responseId, "fixture-response-123");
      return true;
    });
    assert.equal(calls.length, 3);
  }
});

test("fails closed on truncated, blank, missing-usage and mismatched-model chat results", async () => {
  for (const [mutate, code, ambiguous] of [
    [(body) => { body.choices[0].finish_reason = "length"; }, "DEEPSEEK_INCOMPLETE_MODEL", false],
    [(body) => { body.choices[0].message.content = "   "; }, "DEEPSEEK_INCOMPLETE_MODEL", false],
    [(body) => { delete body.usage; }, "DEEPSEEK_MODEL_RECEIPT", true],
    [(body) => { body.usage.total_tokens += 1; }, "DEEPSEEK_MODEL_RECEIPT", true],
    [(body) => { body.model = "deepseek-v4-pro"; }, "DEEPSEEK_MODEL_RECEIPT", false],
    [(body) => { delete body.id; }, "DEEPSEEK_MODEL_RECEIPT", false],
  ]) {
    const { client, calls } = fixture({ answer(id) {
      const body = completion(id);
      mutate(body);
      return body;
    } });
    const evidence = await client.searchEvidence({ query: "行业研究" });
    await assert.rejects(client.synthesize({ goal: "分析", evidence }), { code, ambiguous });
    assert.equal(calls.length, 3);
  }
});

test("does not reveal vendor error bodies or retry on redirect, rate limit or server error", async () => {
  for (const status of [302, 429, 502]) {
    const { client, calls } = fixture({ fetch: () => new Response("vendor secret " + apiKey,
      { status, headers: { location: "https://unrelated.example.com/" } }) });
    await assert.rejects(client.searchEvidence({ query: "行业研究" }), (error) => {
      assert.equal(error.code, "DEEPSEEK_HTTP_ERROR");
      assert.equal(error.status, status);
      assert.equal(error.ambiguous, status === 502);
      assert.equal(error.message.includes(apiKey), false);
      assert.equal(error.message.includes("unrelated"), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("caps vendor response bodies and marks lost results ambiguous", async () => {
  for (const [make, code] of [
    [() => new Response("x".repeat(2_000_001)), "DEEPSEEK_RESPONSE_LIMIT"],
    [() => new Response("!"), "DEEPSEEK_PROTOCOL"],
    [() => { throw new Error("raw socket error " + apiKey); }, "DEEPSEEK_TRANSPORT"],
  ]) {
    const { client, calls } = fixture({ fetch: make });
    await assert.rejects(client.searchEvidence({ query: "行业研究" }), { code, ambiguous: true });
    assert.equal(calls.length, 1);
  }
});

test("does not dispatch after cancellation or rejected lease admission, distinguishes cancellation after dispatch", async () => {
  const controller = new AbortController();
  const { client, calls } = fixture({ fetch: () => {
    controller.abort();
    return new Promise(() => {});
  } });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.searchEvidence({ query: "行业研究", signal: cancelled.signal }),
    { code: "DEEPSEEK_ABORTED", ambiguous: false });
  const denied = new Error("fixture lease lost");
  await assert.rejects(client.searchEvidence({ query: "行业研究", beforeRequest() { throw denied; } }), (error) => error === denied);
  assert.equal(calls.length, 0);
  await assert.rejects(client.searchEvidence({ query: "行业研究", signal: controller.signal }),
    { code: "DEEPSEEK_ABORTED", ambiguous: true });
  assert.equal(calls.length, 1);
});

test("bounds a transport that ignores the AbortSignal", async () => {
  const holdProcess = setTimeout(() => {}, 1000);
  try {
    const { client, calls } = fixture({ timeoutMs: 20, fetch: () => new Promise(() => {}) });
    await assert.rejects(client.searchEvidence({ query: "行业研究" }), { code: "DEEPSEEK_TIMEOUT", ambiguous: true });
    assert.equal(calls.length, 1);
  } finally { clearTimeout(holdProcess); }
});

test("blocks outbound private contact input and removes public-page contacts from excerpts", async () => {
  const contact = "fixture-person@example.com";
  const mobile = ["138", "0000", "0000"].join("-");
  const { client, calls } = fixture({ page: {
    content: sourceContent + "\n\n联系方式：" + contact + " 或 " + mobile,
    title: "联系 " + contact,
  } });
  await assert.rejects(client.searchEvidence({ query: "搜索 " + contact }), { code: "DEEPSEEK_INVALID_INPUT" });
  assert.equal(calls.length, 0);
  const evidence = await client.searchEvidence({ query: "公开行业研究" });
  const source = evidence.sources[0];
  assert.match(source.excerpt, /\[联系方式已隐去\]/u);
  assert.equal(JSON.stringify(evidence).includes(contact), false);
  assert.equal(JSON.stringify(evidence).includes(mobile), false);
  assert.equal(source.contentSha256, sha(sourceContent + "\n\n联系方式：" + contact + " 或 " + mobile));
  assert.equal(source.excerptSha256, sha(source.excerpt));
  await assert.rejects(client.synthesize({ goal: "分析", evidence, followups: ["联系电话 " + mobile] }),
    { code: "DEEPSEEK_INVALID_INPUT" });
  assert.equal(calls.length, 2);
});

test("direct citation verification uses only vendor Fetch and rejects a private URL before outbound calls", async () => {
  const { client, calls, resolutions } = fixture({
    resolveHost: (host) => host === "unsafe.example.com" ? ["169.254.169.254"] : ["8.8.8.8"],
  });
  await assert.rejects(client.fetchPublicEvidence({ url: "https://unsafe.example.com/" }),
    { code: "DEEPSEEK_INVALID_SOURCE", status: 400, ambiguous: false });
  assert.equal(calls.length, 0);
  const admitted = [];
  const evidence = await client.fetchPublicEvidence({ url: sourceUrl, beforeRequest: (request) => admitted.push(request) });
  assert.deepEqual(resolutions, ["unsafe.example.com", "docs.example.com"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, origin + "/v1/tools/fetch");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(calls[0].body, { url: sourceUrl });
  assert.equal(admitted[0].operation, "fetch");
  assert.equal(evidence.provider, "deepseek");
  assert.equal(evidence.source.contentSha256, sha(sourceContent));
  assert.equal(evidence.fetch.bytes, Buffer.byteLength(sourceContent));
  assert.equal(evidence.fetch.status, 200);
  assert.equal(evidence.fetch.responseId, "fixture-fetch-id");
  assert.equal(evidence.fetch.requestSha256, admitted[0].requestSha256);
  assert.ok(!Number.isNaN(Date.parse(evidence.fetch.fetchedAt)));
});


test("accepts only the exact canonical returned model and retains the rejected identity", async () => {
  for (const model of ["deepseek-v4.1-flash-1017", "DEEPSEEK-FLASH", "deepseek-v4-pro"]) {
    const { client } = fixture({ answer: (id) => completion(id, { model }) });
    const evidence = await client.searchEvidence({ query: "行业研究" });
    await assert.rejects(client.synthesize({ goal: "分析", evidence }), (error) => {
      assert.equal(error.code, "DEEPSEEK_MODEL_RECEIPT");
      assert.equal(error.ambiguous, false);
      assert.equal(error.receipt.model, model);
      assert.equal(error.receipt.requestedModel, GEO_DEEPSEEK_MODEL);
      assert.equal(error.receipt.usage.totalTokens, 60);
      return true;
    });
  }
});

test("keeps zero reasoning usage and rejects unexpected disabled-mode reasoning without losing billing", async () => {
  const { client } = fixture({ answer(id) {
    const body = completion(id);
    body.usage.completion_tokens_details = { reasoning_tokens: 0 };
    return body;
  } });
  const evidence = await client.searchEvidence({ query: "行业研究" });
  const result = await client.synthesize({ goal: "分析", evidence });
  assert.equal(result.usage.reasoningTokens, 0);
  assert.deepEqual(result.thinking, { type: "disabled" });
  assert.equal(result.requestedModel, GEO_DEEPSEEK_MODEL);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.maxOutputTokens, 2500);
  for (const kind of ["tokens", "content"]) {
    const { client, calls } = fixture({ answer(id) {
      const body = completion(id);
      if (kind === "tokens") body.usage.completion_tokens_details = { reasoning_tokens: 3 };
      else body.choices[0].message.reasoning_content = "fixture private reasoning to discard";
      return body;
    } });
    const evidence = await client.searchEvidence({ query: "行业研究" });
    await assert.rejects(client.synthesize({ goal: "分析", evidence }), (error) => {
      assert.equal(error.code, "DEEPSEEK_MODE_MISMATCH");
      assert.equal(error.ambiguous, false);
      assert.equal(error.receipt.usage.totalTokens, 60);
      if (kind === "tokens") assert.equal(error.receipt.usage.reasoningTokens, 3);
      assert.equal(JSON.stringify(error).includes("fixture private reasoning"), false);
      return true;
    });
    assert.equal(calls.length, 3);
  }
});

test("rejects inconsistent usage details while retaining valid total usage", async () => {
  for (const details of [
    { prompt_cache_hit_tokens: 4 },
    { prompt_cache_hit_tokens: -1 },
    { prompt_cache_miss_tokens: undefined },
    { prompt_tokens_details: { cached_tokens: 6 } },
    { prompt_tokens_details: [] },
    { completion_tokens_details: { reasoning_tokens: -1 } },
    { completion_tokens_details: { reasoning_tokens: 0.5 } },
    { completion_tokens_details: { reasoning_tokens: 21 } },
    { completion_tokens_details: "unexpected" },
  ]) {
    const { client } = fixture({ answer(id) {
      const body = completion(id);
      Object.assign(body.usage, details);
      return body;
    } });
    const evidence = await client.searchEvidence({ query: "行业研究" });
    await assert.rejects(client.synthesize({ goal: "分析", evidence }), (error) => {
      assert.equal(error.code, "DEEPSEEK_MODEL_RECEIPT");
      assert.equal(error.ambiguous, false);
      assert.equal(error.receipt.usage.totalTokens, 60);
      return true;
    });
  }
});

test("binds synthesized source provenance to its successful fetch request before model I/O", async () => {
  for (const mutate of [
    (evidence) => { delete evidence.fetch; },
    (evidence) => { evidence.fetch.url = "https://different.example.com/"; },
    (evidence) => { evidence.fetch.status = 404; },
    (evidence) => { evidence.fetch.requestSha256 = "1".repeat(64); },
    (evidence) => { evidence.fetch.responseSha256 = "not-a-hash"; },
    (evidence) => {
      const source = evidence.sources[0];
      source.url = "https://different.example.com/";
      source.sourceId = "src-" + sha(source.url + "\n" + source.contentSha256).slice(0, 16);
    },
  ]) {
    const { client, calls } = fixture();
    const evidence = await client.searchEvidence({ query: "行业研究" });
    mutate(evidence);
    await assert.rejects(client.synthesize({ goal: "分析", evidence }), { code: "DEEPSEEK_INVALID_INPUT", ambiguous: false });
    assert.equal(calls.length, 2);
  }
});

test("cancels a late response body from a transport that ignored cancellation", async () => {
  const controller = new AbortController();
  let resolveTransport;
  let bodyCancelled = false;
  const { client } = fixture({ fetch: () => new Promise((resolve) => { resolveTransport = resolve; }) });
  const work = client.searchEvidence({ query: "行业研究", signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(work, { code: "DEEPSEEK_ABORTED", ambiguous: true });
  resolveTransport(new Response(new ReadableStream({
    cancel() { bodyCancelled = true; },
  })));
  await new Promise(setImmediate);
  assert.equal(bodyCancelled, true);
});


test("bounds a stalled response body, cancels its reader, and does not retry", async () => {
  let bodyCancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const { client, calls } = fixture({ timeoutMs: 20, fetch: () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"results":[')); },
      cancel() { bodyCancelled = true; },
    })) });
    await assert.rejects(client.searchEvidence({ query: "行业研究" }), { code: "DEEPSEEK_TIMEOUT", ambiguous: true });
    assert.equal(calls.length, 1);
    assert.equal(bodyCancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("bounds stalled preflight and DNS work without spending the next provider slot", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const preflight = fixture({ timeoutMs: 20 });
    await assert.rejects(preflight.client.searchEvidence({ query: "行业研究", beforeRequest: () => new Promise(() => {}) }),
      { code: "DEEPSEEK_TIMEOUT", ambiguous: false });
    assert.equal(preflight.calls.length, 0);
    const dns = fixture({ timeoutMs: 20, resolveHost: () => new Promise(() => {}) });
    await assert.rejects(dns.client.searchEvidence({ query: "行业研究" }), (error) => {
      assert.equal(error.code, "DEEPSEEK_TIMEOUT");
      assert.equal(error.ambiguous, false);
      assert.equal(error.receipt.search.responseId, "fixture-search-id");
      return true;
    });
    assert.equal(dns.calls.length, 1);
  } finally { clearTimeout(keepAlive); }
});

test("keeps a truncated result's finish reason and actual usage for reconciliation", async () => {
  const { client, calls } = fixture({ answer(id) {
    const body = completion(id);
    body.choices[0].finish_reason = "length";
    return body;
  } });
  const evidence = await client.searchEvidence({ query: "行业研究" });
  await assert.rejects(client.synthesize({ goal: "分析", evidence }), (error) => {
    assert.equal(error.code, "DEEPSEEK_INCOMPLETE_MODEL");
    assert.equal(error.ambiguous, false);
    assert.equal(error.receipt.finishReason, "length");
    assert.equal(error.receipt.usage.totalTokens, 60);
    assert.equal(error.receipt.maxOutputTokens, 2500);
    return true;
  });
  assert.equal(calls.length, 3);
});
