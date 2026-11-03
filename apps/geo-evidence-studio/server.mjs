import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GeoStore } from "./lib/store.mjs";
import project from "./project.manifest.json" with { type: "json" };
import { GeoEvidenceService } from "./lib/service.mjs";
import { GeoStateError, normalizeTaskScope } from "./lib/superagent-store.mjs";
import { createGeoSuperAgentDeepSeek } from "./lib/superagent-deepseek.mjs";
import { createGeoSuperagent, GEO_SUPERAGENT_QUERY_MAX, GEO_SUPERAGENT_TEXT_MAX, scanGeoSuperagent } from "./lib/superagent.mjs";
import { installationOptions, isLoopback, STUDIO_HOST, STUDIO_PORT } from "./lib/installation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "../..");
const contentType = "application/json";
const MAX_BODY = 128 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

const badInput = (message) => new GeoStateError("invalid_input", message, 400);
const forbidden = (message) => new GeoStateError("forbidden", message, 403);

function onlyKeys(data, names) {
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) => !names.includes(key))) {
    throw badInput("请求包含未知字段或格式有误");
  }
  return data;
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== contentType) {
    throw new GeoStateError("unsupported_media", "请求必须使用 application/json", 415);
  }
  if (Number(request.headers["content-length"]) > MAX_BODY) throw new GeoStateError("body_too_large", "请求体超过 128 KiB", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) {
      request.resume();
      throw new GeoStateError("body_too_large", "请求体超过 128 KiB", 413);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw badInput("请求体不是有效 JSON"); }
}

const hash = (value) => createHash("sha256").update(value).digest();
function authorized(request, expected) {
  return !expected || timingSafeEqual(hash(request.headers.authorization ?? ""), expected);
}

function hostAllowed(request, address) {
  if (!address || typeof address === "string") return false;
  const port = address.port === 80 ? "" : `:${address.port}`;
  return ["127.0.0.1", "localhost", "[::1]"].some((hostname) => request.headers.host === hostname + port);
}

function checkOrigin(request) {
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${request.headers.host}`) {
    throw forbidden("拒绝跨站请求");
  }
}

function serveStatic(response, publicDir, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(publicDir, relative);
  if (!target.startsWith(publicDir + sep) || !existsSync(target)) return false;
  const real = realpathSync(target);
  if (!real.startsWith(publicDir + sep) || !statSync(real).isFile()) return false;
  response.writeHead(200, {
    "content-type": MIME[extname(real)] ?? "application/octet-stream",
    "cache-control": extname(real) === ".html" ? "no-store" : "public, max-age=300",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  const stream = createReadStream(real);
  stream.once("error", () => response.destroy());
  stream.pipe(response);
  return true;
}

function boundedNumber(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" && typeof value !== "string") throw badInput("查询数量有误");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw badInput(`查询数量须为 1 到 ${max}`);
  return number;
}

export function createGeoStudioServer(options = {}) {
  const { rootDir, dbPath, installationScope, token } = installationOptions({
    ...options, rootDir: options.rootDir ?? process.env.GEO_STUDIO_TEST_ROOT ?? defaultRoot,
  });
  const expected = token ? hash(`Bearer ${token}`) : null;
  const publicDir = realpathSync(join(here, "public"));
  const adapter = options.adapter ?? createGeoSuperAgentDeepSeek();
  const store = new GeoStore(dbPath, { installationScope, clock: options.clock });
  const service = new GeoEvidenceService(store, { rootDir });
  const state = store.superagent;
  const paidActionsAllowed = Boolean(expected) || Boolean(options.adapter);
  let watchdogStore;
  try { watchdogStore = dbPath === ":memory:" ? store : new GeoStore(dbPath, { installationScope, clock: options.clock }); }
  catch (error) { store.close(); throw error; }
  const watchdog = watchdogStore.superagent;
  let watchdogTimer;
  const logError = options.onError ?? ((code) => console.error(`GeoEvidence: ${code}`));
  const coordinator = createGeoSuperagent({
    state, installationScope, adapter, mode: options.adapter ? "fixture" : "real",
    leaseMs: options.leaseMs, pollMs: options.pollMs, onError: logError,
  });

  const scope = (channelId, threadId) => normalizeTaskScope({ ...installationScope, channelId: channelId ?? "studio", threadId });
  const queryScope = (url) => scope(url.searchParams.get("channelId"), url.searchParams.get("threadId"));
  const superagentBase = "/api/superagent";
  const pathPrefix = `${superagentBase}/tasks/`;
  const decode = (value) => {
    try { return decodeURIComponent(value); } catch { throw badInput("路径标识符有误"); }
  };

  const server = createHttpServer({ requestTimeout: 25_000, headersTimeout: 10_000 }, async (request, response) => {
    try {
      if (!hostAllowed(request, server.address())) throw forbidden("此应用只接受本机访问");
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw badInput("请求路径有误");
      const url = new URL(request.url, "http://127.0.0.1");
      const { method } = request;
      if (url.pathname.startsWith("/api/")) {
        checkOrigin(request);
        if (!authorized(request, expected)) return sendJson(response, 401, { code: "unauthorized", error: "访问令牌无效" });
      }

      if (method === "GET" && url.pathname === `${superagentBase}/config`) {
        return sendJson(response, 200, { configured: coordinator.configured && paidActionsAllowed, authorizationRequired: coordinator.configured && !paidActionsAllowed, dataMode: coordinator.mode, scope: installationScope,
          limits: { textMax: GEO_SUPERAGENT_TEXT_MAX, queryMax: GEO_SUPERAGENT_QUERY_MAX } });
      }
      if (method === "GET" && url.pathname === `${superagentBase}/tasks`) {
        return sendJson(response, 200, { tasks: state.listTasks(queryScope(url)) });
      }
      if (method === "POST" && url.pathname === `${superagentBase}/events`) {
        if (!paidActionsAllowed) throw forbidden("提交研究任务需要配置单独的本机访问令牌");
        const body = onlyKeys(await readJson(request), ["channelId", "threadId", "eventId", "kind", "taskId", "text", "params", "publicResearch"]);
        const result = coordinator.admit(scope(body.channelId, body.threadId), body);
        return sendJson(response, result.replay ? 200 : 202, result);
      }
      if (method === "POST" && url.pathname === `${superagentBase}/watch`) {
        const body = onlyKeys(await readJson(request), ["channelId", "threadId"]);
        return sendJson(response, 200, watchdog.recoverExpired(scope(body.channelId, body.threadId)));
      }
      if (url.pathname.startsWith(pathPrefix)) {
        const [taskId, action, subject, ...rest] = url.pathname.slice(pathPrefix.length).split("/").map(decode);
        if (method === "GET" && !action && !subject && rest.length === 0) {
          const activeScope = queryScope(url);
          const task = state.getTask(activeScope, taskId);
          if (!task) throw new GeoStateError("not_found", "当前线程没有此任务", 404);
          return sendJson(response, 200, { task, events: state.listEvents(activeScope, taskId) });
        }
        if (method === "GET" && action === "events" && subject && rest.length === 0) {
          return sendJson(response, 200, { event: state.readEvent(queryScope(url), taskId, subject) });
        }
        if (method === "GET" && action === "revisions" && /^\d+$/.test(subject ?? "") && rest.length === 0) {
          return sendJson(response, 200, { stages: state.getTaskRevision(queryScope(url), taskId, Number(subject)) });
        }
        if (method === "POST" && action === "resume" && subject === undefined) {
          if (!paidActionsAllowed) throw forbidden("恢复研究任务需要配置单独的本机访问令牌");
          const body = onlyKeys(await readJson(request), ["channelId", "threadId"]);
          return sendJson(response, 202, { task: coordinator.resume(scope(body.channelId, body.threadId), taskId) });
        }
      }

      if (method === "GET" && url.pathname === "/api/health") {
        const { database: _database, providers, ...health } = service.health();
        return sendJson(response, 200, { ...health, service: project.id, version: project.version,
          providers: { fixture: providers.fixture, deepseek: providers.deepseek, "deepseek-search": providers["deepseek-search"] } });
      }
      if (method === "GET" && url.pathname === "/api/summary") {
        return sendJson(response, 200, service.summary({ runId: url.searchParams.get("runId") ?? undefined }));
      }
      if (method === "GET" && url.pathname === "/api/queries") {
        return sendJson(response, 200, { queries: store.listQueries({
          category: url.searchParams.get("category") ?? undefined,
          risk: url.searchParams.has("risk") ? url.searchParams.get("risk") === "true" : undefined,
          limit: boundedNumber(url.searchParams.get("limit"), 1000, 1000),
        }) });
      }
      if (method === "GET" && url.pathname === "/api/samples") {
        return sendJson(response, 200, { samples: store.listSamples({
          runId: url.searchParams.get("runId") ?? undefined,
          queryId: url.searchParams.get("queryId") ?? undefined,
          platform: url.searchParams.get("platform") ?? undefined,
          negative: url.searchParams.get("negative") === "true",
          limit: boundedNumber(url.searchParams.get("limit"), 500, 1000),
        }) });
      }
      if (method === "GET" && url.pathname === "/api/runs") return sendJson(response, 200, { runs: store.listRuns(50) });
      if (method === "GET" && url.pathname === "/api/incidents") {
        return sendJson(response, 200, { incidents: store.listIncidents({
          status: url.searchParams.get("status") ?? "open", limit: boundedNumber(url.searchParams.get("limit"), 200, 1000),
        }) });
      }
      if (method === "GET" && url.pathname === "/api/articles") return sendJson(response, 200, { articles: store.listArticles(1000) });
      if (method === "GET" && url.pathname === "/api/publications") return sendJson(response, 200, { publications: store.listPublications(1000) });
      if (method === "POST" && url.pathname === "/api/run") {
        const body = onlyKeys(await readJson(request), ["provider", "limit", "category", "queryIds", "concurrency"]);
        // The legacy dashboard endpoint remains a fixture. Paid research goes through the explicit consent and bounded queue.
        if (body.provider !== undefined && body.provider !== "fixture") throw forbidden("真实取证请使用证据任务工作台");
        return sendJson(response, 200, await service.runObservations({ ...body, provider: "fixture",
          limit: boundedNumber(body.limit, 20, 100), concurrency: boundedNumber(body.concurrency, 2, 6) }));
      }
      if (method === "POST" && url.pathname === "/api/articles/generate") {
        const body = onlyKeys(await readJson(request), ["topicIds", "force", "dataMode"]);
        if (body.dataMode !== undefined && body.dataMode !== "draft") throw badInput("看板只生成草案");
        return sendJson(response, 200, service.generateArticles({ ...body, dataMode: "draft" }));
      }
      if (method === "POST" && url.pathname === "/api/publish") throw forbidden("发布需人工审核；请用本地命令导出已核对的草案");
      if (method === "POST" && url.pathname === "/api/report") {
        const body = onlyKeys(await readJson(request), ["runId"]);
        return sendJson(response, 200, await service.writeReport(body));
      }
      if (method === "POST" && url.pathname === "/api/tool") {
        const body = onlyKeys(await readJson(request), ["name", "params", "scope"]);
        store.assertInstallationScope(body.scope);
        if (body.name === "citation.fetch" && !expected) throw forbidden("抓取需要配置本机访问令牌");
        if (body.name === "visibility.collect" && body.params?.provider && body.params.provider !== "fixture") {
          throw forbidden("真实取证请使用证据任务工作台");
        }
        return sendJson(response, 200, await service.handleTool(body.name, body.params, body.scope));
      }

      if (method === "GET" && serveStatic(response, publicDir, url.pathname)) return;
      return sendJson(response, 404, { code: "not_found", error: "没有此路径" });
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (error instanceof GeoStateError) return sendJson(response, error.statusCode, { code: error.code, error: error.message });
      logError("request_failed");
      return sendJson(response, 500, { code: "request_failed", error: "处理请求失败" });
    }
  });

  return {
    server, store, service, dbPath,
    async listen({ port = STUDIO_PORT, host = STUDIO_HOST } = {}) {
      if (!isLoopback(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw badInput("仅支持本机地址和有效端口");
      await new Promise((resolveListen, reject) => {
        const failed = (error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolveListen(); };
        server.once("error", failed).once("listening", ready);
        server.listen(port, host);
      });
      const watch = () => {
        try { scanGeoSuperagent(watchdog, installationScope); } catch { logError("watchdog_failed"); }
      };
      watch();
      watchdogTimer = setInterval(watch, options.watchdogMs ?? 5_000);
      watchdogTimer.unref();
      if (options.startWorker !== false && paidActionsAllowed) coordinator.start();
      return server.address();
    },
    async close() {
      clearInterval(watchdogTimer);
      if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await coordinator.stop();
      if (watchdogStore !== store) watchdogStore.close();
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createGeoStudioServer();
  try {
    const address = await app.listen({ port: Number(process.env.GEO_STUDIO_TEST_PORT ?? STUDIO_PORT),
      host: process.env.GEO_STUDIO_TEST_HOST ?? STUDIO_HOST });
    console.log(`GeoEvidence Studio Test: http://localhost:${address.port}`);
  } catch (error) { await app.close(); throw error; }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close().catch(() => { process.exitCode = 1; }));
}
