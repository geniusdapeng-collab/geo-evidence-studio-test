const DEFAULT_BASE_URL = "http://127.0.0.1:14317";

export const TOOL_PATTERNS = [
  "visibility.collect",
  "answer.structure",
  "citation.fetch",
  "geo.rewrite",
  "geo_queue.emit",
  "rpa.source_publish",
  "archive.write_back",
];

function connectorError(name, error) {
  return { result: { state: "connector-error", tool: name, error }, receipt: { synced: false, mode: "real", error } };
}

export function createToolExecutorForScope(scope = {}) {
  const url = new URL(process.env.GEO_EVIDENCE_STUDIO_TEST_URL ?? DEFAULT_BASE_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("GeoEvidence Studio Test connector accepts a loopback HTTP origin only");
  }
  const endpoint = new URL("/api/tool", url);
  const token = String(process.env.GEO_EVIDENCE_STUDIO_TEST_TOKEN ?? "");
  const timeoutMs = Number(process.env.GEO_EVIDENCE_STUDIO_TEST_TIMEOUT_MS ?? 120_000);
  const requestScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    ...(scope.projectId ? { projectId: scope.projectId } : {}) };

  return async (name, params = {}) => {
    if (!TOOL_PATTERNS.includes(name)) {
      return {
        result: { state: "connector-required", tool: name },
        receipt: { synced: false, mode: "real" },
      };
    }
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ name, params, scope: requestScope }),
        signal: AbortSignal.timeout(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000 ? timeoutMs : 120_000),
      });
      const payload = await response.json();
      if (!response.ok) return connectorError(name, payload.error ?? `HTTP ${response.status}`);
      return {
        result: payload.result ?? payload,
        receipt: payload.receipt ?? { synced: false, mode: "real" },
      };
    } catch {
      return connectorError(name, "无法获取 GeoEvidence Studio Test 的本地回执");
    }
  };
}
