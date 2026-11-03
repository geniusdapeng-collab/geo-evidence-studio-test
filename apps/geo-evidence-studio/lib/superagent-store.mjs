import { randomUUID } from "node:crypto";
import { sha256 } from "./core.mjs";

const scopeFields = ["tenantId", "workspaceId", "projectId", "channelId", "threadId"];
const whereScope = "tenant_id=? AND workspace_id=? AND project_id=? AND channel_id=? AND thread_id=?";
const selectTask = `SELECT * FROM superagent_tasks WHERE ${whereScope} AND id=?`;
const maxEventCharacters = 24_000;
const maxInputBytes = 64 * 1024;
const maxJsonBytes = 1024 * 1024;
const maxRevisionEvidenceBytes = 3 * 1024 * 1024;
const maxEventsPerTask = 33;
const maxStagesPerRevision = 12;
const maxStageAttempts = 2;
const previewLength = 600;

export class GeoStateError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "GeoStateError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function requireGeoId(value, name) {
  if (typeof value !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}_.:@-]{0,127}$/u.test(value)) {
    throw new GeoStateError("invalid_input", `${name} 必须是 1 到 128 个字符的标识符`, 400);
  }
  return value;
}

export function normalizeTaskScope(scope) {
  return Object.fromEntries(scopeFields.map((field) => [field, requireGeoId(scope?.[field], field)]));
}

function scopeParams(scope) {
  return Object.values(normalizeTaskScope(scope));
}

function stableJson(value, maxBytes = maxJsonBytes) {
  function order(entry, depth) {
    if (depth > 32) throw new GeoStateError("invalid_input", "JSON 嵌套过深", 400);
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map((item) => order(item, depth + 1));
    if (entry && [Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, order(entry[key], depth + 1)]));
    }
    throw new GeoStateError("invalid_input", "需要可持久化的 JSON 数据", 400);
  }
  const json = JSON.stringify(order(value, 0));
  if (Buffer.byteLength(json) > maxBytes) throw new GeoStateError("payload_too_large", "任务数据超出大小限制", 413);
  return json;
}

function eventSummary(row) {
  const query = JSON.parse(row.params_json).query;
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    cursor: row.cursor,
    kind: row.kind,
    preview: row.preview,
    hasSpill: Boolean(row.has_spill),
    storage: row.has_spill ? "spill" : "inline",
    hasQuery: typeof query === "string" && Boolean(query.trim()),
    fingerprint: row.fingerprint,
    acceptedAt: row.accepted_at,
  };
}

function parseStage(row) {
  return row && {
    revision: row.revision,
    stage: row.stage,
    external: Boolean(row.external),
    input: JSON.parse(row.input_json),
    evidence: JSON.parse(row.evidence_json),
    evidenceSha256: row.evidence_sha256,
    committedAt: row.committed_at,
  };
}

function summarizeStage(row) {
  return {
    revision: row.revision,
    stage: row.stage,
    external: Boolean(row.external),
    evidenceSha256: row.evidence_sha256,
    committedAt: row.committed_at,
  };
}

function leaseDuration(leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 30 * 60_000) {
    throw new GeoStateError("invalid_input", "leaseMs 必须是 1 到 1800000 的整数", 400);
  }
  return leaseMs;
}

export class GeoSuperagentStore {
  constructor(db, { clock = Date.now } = {}) {
    this.db = db;
    this.clock = clock;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS superagent_tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'blocked', 'completed')),
        reason TEXT,
        pending_stage_json TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        latest_event_cursor INTEGER,
        run_event_cursor INTEGER,
        completed_event_cursor INTEGER,
        lease_token TEXT,
        lease_expires_at INTEGER,
        first_claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, workspace_id, project_id, channel_id, thread_id, id),
        CHECK ((status='running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS idx_superagent_tasks_scope_status ON superagent_tasks (
        tenant_id, workspace_id, project_id, channel_id, thread_id, status, lease_expires_at
      );
      CREATE INDEX IF NOT EXISTS idx_superagent_tasks_installation_status ON superagent_tasks (
        tenant_id, workspace_id, project_id, status
      );

      CREATE TABLE IF NOT EXISTS superagent_events (
        cursor INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('request', 'followup')),
        fingerprint TEXT NOT NULL,
        preview TEXT NOT NULL,
        has_spill INTEGER NOT NULL CHECK (has_spill IN (0, 1)),
        inline_text TEXT,
        params_json TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        UNIQUE (tenant_id, workspace_id, project_id, channel_id, thread_id, event_id),
        FOREIGN KEY (tenant_id, workspace_id, project_id, channel_id, thread_id, task_id)
          REFERENCES superagent_tasks(tenant_id, workspace_id, project_id, channel_id, thread_id, id),
        CHECK ((has_spill=0) = (inline_text IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS idx_superagent_events_task ON superagent_events(task_id, cursor);

      CREATE TABLE IF NOT EXISTS superagent_event_spills (
        event_cursor INTEGER PRIMARY KEY REFERENCES superagent_events(cursor),
        text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS superagent_stage_receipts (
        seq INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES superagent_tasks(id),
        revision INTEGER NOT NULL CHECK (revision > 0),
        stage TEXT NOT NULL,
        external INTEGER NOT NULL CHECK (external IN (0, 1)),
        input_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        UNIQUE (task_id, revision, stage)
      );

      CREATE TABLE IF NOT EXISTS superagent_stage_attempts (
        seq INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES superagent_tasks(id),
        revision INTEGER NOT NULL CHECK (revision > 0),
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2),
        external INTEGER NOT NULL CHECK (external IN (0, 1)),
        input_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        UNIQUE (task_id, revision, stage, attempt)
      );

      CREATE TABLE IF NOT EXISTS superagent_stage_failures (
        attempt_seq INTEGER PRIMARY KEY REFERENCES superagent_stage_attempts(seq),
        reason TEXT NOT NULL,
        ambiguous INTEGER NOT NULL CHECK (ambiguous IN (0, 1)),
        receipt_json TEXT,
        failed_at TEXT NOT NULL
      );
    `);
  }

  #transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #requireTask(params, taskId) {
    const row = this.db.prepare(selectTask).get(...params, requireGeoId(taskId, "taskId"));
    if (!row) throw new GeoStateError("not_found", "当前范围内没有此任务", 404);
    return row;
  }

  #taskView(row, withEvidence = true) {
    const stageRows = this.db.prepare(withEvidence
      ? "SELECT * FROM superagent_stage_receipts WHERE task_id=? AND revision=? ORDER BY seq"
      : "SELECT revision, stage, external, evidence_sha256, committed_at FROM superagent_stage_receipts WHERE task_id=? AND revision=? ORDER BY seq"
    ).all(row.id, row.revision);
    const stages = stageRows.map(withEvidence ? parseStage : summarizeStage);
    const history = withEvidence ? this.db.prepare(`
      SELECT revision, stage, external, evidence_sha256, committed_at
      FROM superagent_stage_receipts WHERE task_id=? AND revision<? ORDER BY seq
    `).all(row.id, row.revision).map(summarizeStage) : undefined;
    const failures = withEvidence ? this.db.prepare(`
      SELECT a.revision, a.stage, a.attempt, f.reason, f.ambiguous,
        CASE WHEN a.revision=? THEN f.receipt_json ELSE NULL END AS receipt_json, f.failed_at
      FROM superagent_stage_attempts a JOIN superagent_stage_failures f ON a.seq=f.attempt_seq
      WHERE a.task_id=? ORDER BY a.seq
    `).all(row.revision, row.id).map((item) => ({
      revision: item.revision,
      stage: item.stage,
      attempt: item.attempt,
      reason: item.reason,
      ambiguous: Boolean(item.ambiguous),
      receipt: item.receipt_json ? JSON.parse(item.receipt_json) : null,
      failedAt: item.failed_at,
    })) : undefined;
    const pending = row.pending_stage_json ? JSON.parse(row.pending_stage_json) : null;
    return {
      taskId: row.id,
      scope: {
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        channelId: row.channel_id,
        threadId: row.thread_id,
      },
      status: row.status,
      reason: row.reason,
      revision: row.revision,
      latestEventCursor: row.latest_event_cursor,
      runEventCursor: row.run_event_cursor,
      completedEventCursor: row.completed_event_cursor,
      pendingStage: withEvidence || !pending ? pending : { stage: pending.stage, external: pending.external },
      checkpoint: stages.at(-1) ?? null,
      stages,
      ...(withEvidence ? { history, failures } : {}),
      leaseExpiresAt: row.lease_expires_at,
      firstClaimedAt: row.first_claimed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  admit(scope, { eventId, kind, taskId, text, params = {} } = {}) {
    const bindings = scopeParams(scope);
    requireGeoId(eventId, "eventId");
    if (!["request", "followup"].includes(kind) || (kind === "request" && taskId !== undefined)) {
      throw new GeoStateError("invalid_input", "新请求创建任务，补充事件需要显式 taskId", 400);
    }
    if (kind === "followup") requireGeoId(taskId, "taskId");
    if (typeof text !== "string" || !text.trim() || !text.isWellFormed() || text.includes("\u0000")) {
      throw new GeoStateError("invalid_input", "事件正文必须是有效的非空文本", 400);
    }
    if (text.length > maxEventCharacters) {
      throw new GeoStateError("payload_too_large", "事件正文超过 24000 个 UTF-16 单元", 413);
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new GeoStateError("invalid_input", "事件参数必须是 JSON 对象", 400);
    }
    const paramsJson = stableJson(params, maxInputBytes);
    const fingerprint = sha256(JSON.stringify([kind, taskId ?? null, text, paramsJson]));
    return this.#transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM superagent_events WHERE ${whereScope} AND event_id=?
      `).get(...bindings, eventId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new GeoStateError("event_conflict", "相同事件 ID 已绑定不同内容或任务");
        }
        return { replay: true, event: eventSummary(existing), task: this.#taskView(this.#requireTask(bindings, existing.task_id)) };
      }

      const timestamp = new Date(this.clock()).toISOString();
      if (kind === "request") {
        taskId = `geo-task-${randomUUID()}`;
        this.db.prepare(`
          INSERT INTO superagent_tasks (
            id, tenant_id, workspace_id, project_id, channel_id, thread_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        `).run(taskId, ...bindings, timestamp, timestamp);
      } else {
        const task = this.#requireTask(bindings, taskId);
        if (task.status === "blocked") {
          throw new GeoStateError("task_unavailable", "任务等待外部请求对账，无法附加补充事件");
        }
        const { count } = this.db.prepare("SELECT count(*) AS count FROM superagent_events WHERE task_id=?").get(taskId);
        if (count >= maxEventsPerTask) throw new GeoStateError("event_limit", "同一任务事件数量已达上限");
      }

      const preview = text.slice(0, previewLength).toWellFormed();
      const spill = text.length > previewLength;
      const row = this.db.prepare(`
        INSERT INTO superagent_events (
          event_id, tenant_id, workspace_id, project_id, channel_id, thread_id, task_id, kind,
          fingerprint, preview, has_spill, inline_text, params_json, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
      `).get(eventId, ...bindings, taskId, kind, fingerprint, preview, Number(spill), spill ? null : text, paramsJson, timestamp);
      if (spill) this.db.prepare("INSERT INTO superagent_event_spills VALUES (?, ?)").run(row.cursor, text);
      this.db.prepare(`
        UPDATE superagent_tasks SET latest_event_cursor=?, updated_at=?,
          revision=revision + (status='completed'),
          run_event_cursor=CASE WHEN status='completed' THEN NULL ELSE run_event_cursor END,
          status=CASE WHEN status='completed' THEN 'queued' ELSE status END
        WHERE id=?
      `).run(row.cursor, timestamp, taskId);
      return { replay: false, event: eventSummary(row), task: this.#taskView(this.#requireTask(bindings, taskId)) };
    });
  }

  listTasks(scope, { limit = 50, status } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new GeoStateError("invalid_input", "任务查询数量须为 1 到 100", 400);
    }
    if (status !== undefined && !["queued", "running", "paused", "blocked", "completed"].includes(status)) {
      throw new GeoStateError("invalid_input", "任务状态无效", 400);
    }
    return this.db.prepare(`
      SELECT * FROM superagent_tasks WHERE ${whereScope} ${status ? "AND status=?" : ""}
      ORDER BY ${status === "queued" ? "created_at, rowid" : "updated_at DESC, rowid DESC"} LIMIT ?
    `).all(...scopeParams(scope), ...(status ? [status] : []), limit).map((row) => this.#taskView(row, false));
  }

  listActiveScopes({ tenantId, workspaceId, projectId } = {}) {
    const ids = [[tenantId, "tenantId"], [workspaceId, "workspaceId"], [projectId, "projectId"]];
    return this.db.prepare(`
      SELECT DISTINCT channel_id AS channelId, thread_id AS threadId FROM superagent_tasks
      WHERE tenant_id=? AND workspace_id=? AND project_id=? AND status IN ('queued', 'running')
      ORDER BY channel_id, thread_id
    `).all(...ids.map(([value, name]) => requireGeoId(value, name)))
      .map((row) => ({ tenantId, workspaceId, projectId, ...row }));
  }

  getTask(scope, taskId) {
    const row = this.db.prepare(selectTask).get(...scopeParams(scope), requireGeoId(taskId, "taskId"));
    return row ? this.#taskView(row) : null;
  }

  getTaskRevision(scope, taskId, revision) {
    const row = this.#requireTask(scopeParams(scope), taskId);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > row.revision) {
      throw new GeoStateError("not_found", "当前任务内没有此修订", 404);
    }
    return this.db.prepare(`
      SELECT * FROM superagent_stage_receipts WHERE task_id=? AND revision=? ORDER BY seq
    `).all(taskId, revision).map(parseStage);
  }

  listEvents(scope, taskId, { throughCursor = Number.MAX_SAFE_INTEGER } = {}) {
    const params = scopeParams(scope);
    if (!Number.isSafeInteger(throughCursor) || throughCursor < 0) {
      throw new GeoStateError("invalid_input", "事件游标无效", 400);
    }
    this.#requireTask(params, taskId);
    return this.db.prepare(`
      SELECT * FROM superagent_events WHERE ${whereScope} AND task_id=? AND cursor<=? ORDER BY cursor
    `).all(...params, taskId, throughCursor).map(eventSummary);
  }

  readEvent(scope, taskId, eventId) {
    const row = this.db.prepare(`
      SELECT e.*, COALESCE(s.text, e.inline_text) AS full_text
      FROM superagent_events e LEFT JOIN superagent_event_spills s ON s.event_cursor=e.cursor
      WHERE ${whereScope} AND task_id=? AND event_id=?
    `).get(...scopeParams(scope), requireGeoId(taskId, "taskId"), requireGeoId(eventId, "eventId"));
    if (!row) throw new GeoStateError("not_found", "当前任务内没有此事件", 404);
    if (row.full_text === null) throw new GeoStateError("event_integrity", "事件原文缺失，无法读取");
    return { ...eventSummary(row), text: row.full_text, params: JSON.parse(row.params_json) };
  }

  claim(scope, taskId, { leaseMs = 120_000 } = {}) {
    const params = scopeParams(scope);
    const duration = leaseDuration(leaseMs);
    return this.#transaction(() => {
      const row = this.#requireTask(params, taskId);
      if (!["queued", "paused"].includes(row.status)) {
        throw new GeoStateError("task_unavailable", "当前任务无法认领");
      }
      const time = this.clock();
      const timestamp = new Date(time).toISOString();
      const leaseToken = randomUUID();
      this.db.prepare(`
        UPDATE superagent_tasks
        SET status='running', reason=NULL, lease_token=?, lease_expires_at=?,
          run_event_cursor=COALESCE(run_event_cursor, latest_event_cursor),
          first_claimed_at=COALESCE(first_claimed_at, ?), updated_at=?
        WHERE id=?
      `).run(leaseToken, time + duration, timestamp, timestamp, taskId);
      return { task: this.#taskView(this.#requireTask(params, taskId)), leaseToken };
    });
  }

  resume(scope, taskId) {
    const params = scopeParams(scope);
    return this.#transaction(() => {
      const row = this.#requireTask(params, taskId);
      if (row.status !== "paused") {
        throw new GeoStateError("task_unavailable", "只有安全暂停的任务可以恢复");
      }
      this.db.prepare("UPDATE superagent_tasks SET status='queued', reason=NULL, updated_at=? WHERE id=?")
        .run(new Date(this.clock()).toISOString(), taskId);
      return this.#taskView(this.#requireTask(params, taskId));
    });
  }

  #requireLease(params, taskId, leaseToken, time) {
    const row = this.#requireTask(params, taskId);
    if (row.status !== "running" || row.lease_token !== leaseToken || row.lease_expires_at <= time) {
      throw new GeoStateError("stale_lease", "任务租约已失效，拒绝写入");
    }
    return row;
  }

  renew(scope, taskId, leaseToken, { leaseMs = 120_000 } = {}) {
    const params = scopeParams(scope);
    const duration = leaseDuration(leaseMs);
    return this.#transaction(() => {
      const time = this.clock();
      const row = this.#requireLease(params, taskId, leaseToken, time);
      const leaseExpiresAt = Math.max(row.lease_expires_at, time + duration);
      this.db.prepare("UPDATE superagent_tasks SET lease_expires_at=? WHERE id=?").run(leaseExpiresAt, taskId);
      return { leaseExpiresAt };
    });
  }

  beginStage(scope, taskId, leaseToken, { stage, external = false, input = null } = {}) {
    const params = scopeParams(scope);
    requireGeoId(stage, "stage");
    if (typeof external !== "boolean") throw new GeoStateError("invalid_input", "external 必须为布尔值", 400);
    const inputJson = stableJson(input, maxInputBytes);
    return this.#transaction(() => {
      const time = this.clock();
      const row = this.#requireLease(params, taskId, leaseToken, time);
      if (row.pending_stage_json) {
        const pending = JSON.parse(row.pending_stage_json);
        if (pending.stage === stage && !pending.external && !external && stableJson(pending.input) === inputJson) {
          return pending;
        }
        throw new GeoStateError("stage_conflict", "当前任务已有未结算阶段");
      }
      if (this.db.prepare("SELECT 1 FROM superagent_stage_receipts WHERE task_id=? AND revision=? AND stage=?")
        .get(taskId, row.revision, stage)) {
        throw new GeoStateError("stage_conflict", "此阶段已有持久化回执");
      }
      const attempts = this.db.prepare(`
        SELECT stage, attempt, external, input_json FROM superagent_stage_attempts
        WHERE task_id=? AND revision=? ORDER BY seq
      `).all(taskId, row.revision);
      const prior = attempts.findLast((entry) => entry.stage === stage);
      if (!prior && new Set(attempts.map((entry) => entry.stage)).size >= maxStagesPerRevision) {
        throw new GeoStateError("stage_limit", "本次任务修订的阶段数量已达上限");
      }
      if (prior?.attempt >= maxStageAttempts) {
        throw new GeoStateError("stage_attempt_limit", "该阶段已达到本次修订的尝试上限");
      }
      if (prior && (prior.external !== Number(external) || prior.input_json !== inputJson)) {
        throw new GeoStateError("stage_conflict", "阶段重试必须使用第一次登记的输入");
      }
      const attempt = (prior?.attempt ?? 0) + 1;
      const timestamp = new Date(time).toISOString();
      this.db.prepare(`
        INSERT INTO superagent_stage_attempts (task_id, revision, stage, attempt, external, input_json, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(taskId, row.revision, stage, attempt, Number(external), inputJson, timestamp);
      const pending = { stage, external, input: JSON.parse(inputJson), attempt };
      this.db.prepare("UPDATE superagent_tasks SET pending_stage_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(pending), timestamp, taskId);
      return pending;
    });
  }

  commitStage(scope, taskId, leaseToken, { stage, evidence, complete = false } = {}) {
    const params = scopeParams(scope);
    requireGeoId(stage, "stage");
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
      throw new GeoStateError("invalid_input", "阶段提交必须携带回执证据", 400);
    }
    if (typeof complete !== "boolean") throw new GeoStateError("invalid_input", "complete 必须为布尔值", 400);
    const evidenceJson = stableJson(evidence);
    return this.#transaction(() => {
      const time = this.clock();
      const row = this.#requireLease(params, taskId, leaseToken, time);
      const pending = row.pending_stage_json ? JSON.parse(row.pending_stage_json) : null;
      if (pending?.stage !== stage) throw new GeoStateError("stage_conflict", "回执阶段与已登记阶段不同");
      const { bytes } = this.db.prepare(`
        SELECT COALESCE(sum(length(CAST(evidence_json AS BLOB))), 0) AS bytes
        FROM superagent_stage_receipts WHERE task_id=? AND revision=?
      `).get(taskId, row.revision);
      if (bytes + Buffer.byteLength(evidenceJson) > maxRevisionEvidenceBytes) {
        throw new GeoStateError("payload_too_large", "本次任务修订的回执总量已达上限", 413);
      }
      const timestamp = new Date(time).toISOString();
      this.db.prepare(`
        INSERT INTO superagent_stage_receipts (
          task_id, revision, stage, external, input_json, evidence_json, evidence_sha256, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(taskId, row.revision, stage, Number(pending.external), stableJson(pending.input),
        evidenceJson, sha256(evidenceJson), timestamp);
      const nextRevision = complete && row.latest_event_cursor > row.run_event_cursor;
      const status = complete ? (nextRevision ? "queued" : "completed") : "running";
      this.db.prepare(`
        UPDATE superagent_tasks SET pending_stage_json=NULL, updated_at=?, status=?, lease_token=?, lease_expires_at=?,
          revision=?, run_event_cursor=?, completed_event_cursor=?
        WHERE id=?
      `).run(timestamp, status, complete ? null : row.lease_token, complete ? null : row.lease_expires_at,
        row.revision + Number(nextRevision), nextRevision ? null : row.run_event_cursor,
        complete ? row.run_event_cursor : row.completed_event_cursor, taskId);
      return this.#taskView(this.#requireTask(params, taskId));
    });
  }

  fail(scope, taskId, leaseToken, { reason, ambiguous = false, receipt } = {}) {
    const params = scopeParams(scope);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 512 || typeof ambiguous !== "boolean") {
      throw new GeoStateError("invalid_input", "失败原因必须是 1 到 512 个字符的文本", 400);
    }
    if (receipt !== undefined && (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || !Object.keys(receipt).length)) {
      throw new GeoStateError("invalid_input", "失败回执必须是非空 JSON 对象", 400);
    }
    const receiptJson = receipt === undefined ? null : stableJson(receipt, maxInputBytes);
    return this.#transaction(() => {
      const time = this.clock();
      const row = this.#requireLease(params, taskId, leaseToken, time);
      const pending = row.pending_stage_json ? JSON.parse(row.pending_stage_json) : null;
      const unknown = ambiguous || (Boolean(pending?.external) && !receiptJson);
      if (pending) this.#recordFailure(row, pending, { reason, ambiguous: unknown, receiptJson, time });
      const atLimit = pending?.attempt >= maxStageAttempts;
      this.#stop(row.id, unknown || atLimit ? "blocked" : "paused",
        !unknown && atLimit ? "stage_attempt_limit" : reason, time, !unknown);
      return this.#taskView(this.#requireTask(params, taskId));
    });
  }

  #recordFailure(row, pending, { reason, ambiguous, receiptJson, time }) {
    this.db.prepare(`
      INSERT INTO superagent_stage_failures (attempt_seq, reason, ambiguous, receipt_json, failed_at)
      VALUES (
        (SELECT seq FROM superagent_stage_attempts WHERE task_id=? AND revision=? AND stage=? AND attempt=?),
        ?, ?, ?, ?
      )
    `).run(row.id, row.revision, pending.stage, pending.attempt, reason, Number(ambiguous),
      receiptJson, new Date(time).toISOString());
  }

  #stop(taskId, status, reason, time, clearPending) {
    this.db.prepare(`
      UPDATE superagent_tasks
      SET status=?, reason=?, lease_token=NULL, lease_expires_at=NULL, updated_at=?,
        pending_stage_json=CASE WHEN ? THEN NULL ELSE pending_stage_json END
      WHERE id=?
    `).run(status, reason, new Date(time).toISOString(), Number(clearPending), taskId);
  }

  recoverExpired(scope) {
    const params = scopeParams(scope);
    return this.#transaction(() => {
      const time = this.clock();
      const rows = this.db.prepare(`
        SELECT id, revision, pending_stage_json FROM superagent_tasks
        WHERE ${whereScope} AND status='running' AND lease_expires_at<=?
        ORDER BY lease_expires_at, id
      `).all(...params, time);
      const result = { paused: [], blocked: [] };
      for (const row of rows) {
        const pending = row.pending_stage_json ? JSON.parse(row.pending_stage_json) : null;
        const unknown = Boolean(pending?.external);
        const atLimit = pending?.attempt >= maxStageAttempts;
        const status = unknown || atLimit ? "blocked" : "paused";
        const reason = unknown ? "external_dispatch_ambiguous" : "lease_expired";
        if (pending) this.#recordFailure(row, pending, { reason, ambiguous: unknown, receiptJson: null, time });
        this.#stop(row.id, status, !unknown && atLimit ? "stage_attempt_limit" : reason, time, !unknown);
        result[status].push(row.id);
      }
      return result;
    });
  }
}
