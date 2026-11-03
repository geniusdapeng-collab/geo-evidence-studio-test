import { createHash } from "node:crypto";
import { GeoStateError } from "./superagent-store.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const reasonFor = (error) => typeof error?.code === "string" && /^[a-z_0-9]{1,70}$/i.test(error.code)
  ? error.code.toLowerCase() : "worker_error";
const cutoff = "\n[中段超出本次模型窗口，完整原文仍保存在当前任务。]\n";

// Store the full event. Select only bounded, explicitly scoped material to send.
function boundMaterial(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const chars = [...text];
  const half = Math.floor((maxBytes - Buffer.byteLength(cutoff)) / 2);
  let front = 0;
  let back = chars.length;
  for (let bytes = 0; front < back; front += 1) {
    bytes += Buffer.byteLength(chars[front]);
    if (bytes > half) break;
  }
  for (let bytes = 0; back > front; back -= 1) {
    bytes += Buffer.byteLength(chars[back - 1]);
    if (bytes > half) break;
  }
  return { text: chars.slice(0, front).join("") + cutoff + chars.slice(back).join(""), truncated: true };
}

export const GEO_SUPERAGENT_TEXT_MAX = 24_000;
export const GEO_SUPERAGENT_QUERY_MAX = 128;
const likelySecret = /(?:github_pat_[\w]{20,}|gh[pousr]_[\w]{24,}|sk-[a-z0-9_-]{18,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})/i;
const likelyContact = /(?:\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d))/u;

function publicText(value, max, label, min = 1) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new GeoStateError("invalid_input", `${label}须为 ${min} 至 ${max} 字符的文本`, 400);
  }
  if (likelySecret.test(value) || likelyContact.test(value)) {
    throw new GeoStateError("private_material", `${label}疑似包含凭据或个人联系方式`, 400);
  }
  return value;
}

function validateEvent(body) {
  if (body.publicResearch !== true) throw new GeoStateError("public_research_required", "须确认仅使用可公开研究的材料", 400);
  const { kind, eventId, taskId } = body;
  const text = publicText(body.text, GEO_SUPERAGENT_TEXT_MAX, "任务正文");
  const params = body.params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some((key) => key !== "query")) {
    throw new GeoStateError("invalid_input", "任务参数只接受明确的公开搜索词", 400);
  }
  const query = Object.hasOwn(params, "query") ? publicText(params.query, GEO_SUPERAGENT_QUERY_MAX * 2, "公开搜索词").trim() : undefined;
  if (query && ([...query].length > GEO_SUPERAGENT_QUERY_MAX || Buffer.byteLength(query) > 512)) {
    throw new GeoStateError("invalid_input", "公开搜索词最长 128 字符且不超过 512 字节", 400);
  }
  if (kind === "request" && !query) throw new GeoStateError("query_required", "新任务必须填写公开搜索词", 400);
  return { kind, eventId, ...(taskId === undefined ? {} : { taskId }), text, params: { publicResearch: true, ...(query ? { query } : {}) } };
}

export function createGeoSuperagent({
  state, installationScope, adapter, mode = "real", leaseMs = 30_000,
  workerConcurrency = 2, pollMs = 750, onError = (code) => console.error(`GeoEvidence worker: ${code}`),
} = {}) {
  const configured = Boolean(adapter?.configured);
  const inFlight = new Map();
  let timer;
  let stopped = false;

  async function execute(scope, taskId, controller) {
    let claim;
    try {
      claim = state.claim(scope, taskId, { leaseMs });
    } catch (error) {
      if (error.code !== "task_unavailable") onError(reasonFor(error));
      return;
    }
    const { task, leaseToken } = claim;
    const signal = controller.signal;
    const renew = () => state.renew(scope, taskId, leaseToken, { leaseMs });
    let providerReceipt;
    let beganExternal = false;
    const beforeRequest = async () => {
      signal.throwIfAborted();
      renew();
    };
    const heartbeat = setInterval(() => {
      try { renew(); } catch (error) {
        controller.abort(error);
        if (error.code !== "stale_lease") onError(reasonFor(error));
      }
    }, Math.max(250, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      const events = state.listEvents(scope, taskId, { throughCursor: task.runEventCursor });
      const request = events[0];
      if (!request || request.kind !== "request") throw new GeoStateError("event_integrity", "任务原始事件不存在");
      const latestQuery = events.findLast((event) => event.hasQuery);
      const queryMaterial = latestQuery && state.readEvent(scope, taskId, latestQuery.eventId);
      const query = queryMaterial?.params.publicResearch === true && queryMaterial.params.query;
      if (!query) throw new GeoStateError("event_integrity", "任务缺少公开搜索词");
      let evidence = task.stages.find((stage) => stage.stage === "evidence")?.evidence;
      if (!evidence) {
        state.beginStage(scope, taskId, leaseToken, {
          stage: "evidence", external: true, input: { eventCursor: task.runEventCursor, querySha256: digest(query) },
        });
        beganExternal = true;
        const result = await adapter.searchEvidence({ query, signal, beforeRequest });
        providerReceipt = { stage: "evidence", search: result.search, fetch: result.fetch, dataMode: mode };
        if (!Array.isArray(result.sources) || !result.sources.length) throw new GeoStateError("no_verified_sources", "没有可核验的公开来源");
        evidence = { ...result, dataMode: mode };
        state.commitStage(scope, taskId, leaseToken, { stage: "evidence", evidence });
        providerReceipt = undefined;
        beganExternal = false;
      }

      const selected = [request, ...events.slice(1).slice(-3)];
      const texts = selected.map((event, index) => {
        const { text, params } = state.readEvent(scope, taskId, event.eventId);
        if (params.publicResearch !== true) throw new GeoStateError("public_research_required", "该事件没有公开研究确认", 400);
        return { eventId: event.eventId, storage: event.storage, ...boundMaterial(text, index === 0 ? 12_000 : 10_000) };
      });
      state.beginStage(scope, taskId, leaseToken, {
        stage: "report", external: true,
        input: { eventCursor: task.runEventCursor, omittedFollowups: events.length - selected.length,
          materials: texts.map(({ eventId, storage, text, truncated }) => ({ eventId, storage, suppliedSha256: digest(text), truncated })) },
      });
      beganExternal = true;
      const result = await adapter.synthesize({ goal: texts[0].text, followups: texts.slice(1).map((row) => row.text),
        evidence, signal, beforeRequest });
      providerReceipt = { stage: "report", responseId: result.responseId, model: result.model, usage: result.usage,
        requestSha256: result.requestSha256, dataMode: mode };
      state.commitStage(scope, taskId, leaseToken, { stage: "report", evidence: { ...result, dataMode: mode }, complete: true });
    } catch (error) {
      if (error.code === "stale_lease") return;
      const reason = reasonFor(error);
      const known = providerReceipt ?? (error.receipt
        ? { ...error.receipt, dataMode: mode }
        : (!error.ambiguous && Number.isInteger(error.status) ? { httpStatus: error.status, dataMode: mode }
          : error.ambiguous === false ? { dispatch: "not_dispatched", dataMode: mode } : undefined));
      try {
        state.fail(scope, taskId, leaseToken, {
          reason, ambiguous: Boolean(error.ambiguous || (beganExternal && !known)), ...(known ? { receipt: known } : {}),
        });
      } catch (failed) {
        if (failed.code !== "stale_lease") onError(reasonFor(failed));
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  function wake() {
    if (!timer || stopped || !configured || inFlight.size >= workerConcurrency) return;
    try {
      for (const scope of state.listActiveScopes(installationScope)) {
        for (const task of state.listTasks(scope, { status: "queued", limit: workerConcurrency })) {
          const { taskId } = task;
          if (inFlight.has(taskId)) continue;
          const controller = new AbortController();
          const work = execute(scope, taskId, controller).catch((error) => onError(reasonFor(error))).finally(() => {
            inFlight.delete(taskId);
            if (!stopped) queueMicrotask(wake);
          });
          inFlight.set(taskId, { work, controller });
          if (inFlight.size >= workerConcurrency) return;
        }
      }
    } catch (error) {
      onError(reasonFor(error));
    }
  }

  function start() {
    if (timer || stopped || !configured) return;
    timer = setInterval(wake, pollMs);
    timer.unref();
    wake();
  }

  async function stop() {
    stopped = true;
    clearInterval(timer);
    for (const item of inFlight.values()) item.controller.abort(new Error("worker_shutdown"));
    await Promise.all([...inFlight.values()].map((item) => item.work));
  }

  return {
    configured, start, stop, wake, mode,
    admit(scope, body) {
      const result = state.admit(scope, validateEvent(body));
      if (!result.replay) setImmediate(wake);
      return result;
    },
    resume(scope, taskId) {
      const task = state.resume(scope, taskId);
      setImmediate(wake);
      return task;
    },
  };
}

export function scanGeoSuperagent(state, installationScope) {
  const result = { paused: [], blocked: [] };
  for (const scope of state.listActiveScopes(installationScope)) {
    const scan = state.recoverExpired(scope);
    result.paused.push(...scan.paused);
    result.blocked.push(...scan.blocked);
  }
  return result;
}
