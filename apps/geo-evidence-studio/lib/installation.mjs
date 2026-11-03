import { resolve } from "node:path";
import { defaultDatabasePath, normalizeInstallationScope } from "./store.mjs";

export const STUDIO_PORT = 14317;
export const STUDIO_HOST = "127.0.0.1";
export const isLoopback = (host) => ["127.0.0.1", "localhost", "::1"].includes(host);

export function installationOptions(options = {}, env = process.env) {
  const rootDir = resolve(options.rootDir ?? env.GEO_STUDIO_TEST_ROOT ?? process.cwd());
  const path = options.dbPath ?? env.GEO_STUDIO_TEST_DB ?? defaultDatabasePath(rootDir);
  const dbPath = path === ":memory:" ? path : resolve(rootDir, path);
  const installationScope = normalizeInstallationScope(options.installationScope ?? {
    tenantId: env.GEO_STUDIO_TEST_TENANT ?? "local",
    workspaceId: env.GEO_STUDIO_TEST_WORKSPACE ?? "local",
    projectId: "future-frontdesk",
  });
  return { rootDir, dbPath, installationScope, token: options.token ?? env.GEO_STUDIO_TEST_TOKEN ?? "" };
}
