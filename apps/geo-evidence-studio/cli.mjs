import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { GeoStore } from "./lib/store.mjs";
import { GeoEvidenceService } from "./lib/service.mjs";
import { createGeoStudioServer } from "./server.mjs";
import { installationOptions, STUDIO_HOST, STUDIO_PORT } from "./lib/installation.mjs";
import { scanGeoSuperagent } from "./lib/superagent.mjs";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const raw = item.slice(2);
    const equal = raw.indexOf("=");
    const rawKey = equal < 0 ? raw : raw.slice(0, equal);
    const inline = equal < 0 ? undefined : raw.slice(equal + 1);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) {
      result[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.log(`GeoEvidence Studio Test

Usage:
  node apps/geo-evidence-studio/cli.mjs init [--db PATH]
  node apps/geo-evidence-studio/cli.mjs run [--provider fixture|manual-import]
      [--limit 20] [--category brand] [--query-id ID]... [--file answers.jsonl]
      [--concurrency 2] [--db PATH]
  node apps/geo-evidence-studio/cli.mjs articles [--topic selection-guide] [--force]
  node apps/geo-evidence-studio/cli.mjs publish --article-id ID --channel local --approved-by NAME
  node apps/geo-evidence-studio/cli.mjs report [--run-id ID] [--out DIR]
  node apps/geo-evidence-studio/cli.mjs reanalyze --run-id ID
  node apps/geo-evidence-studio/cli.mjs export-queries [--out FILE]
  node apps/geo-evidence-studio/cli.mjs serve [--port 14317] [--host 127.0.0.1]
  node apps/geo-evidence-studio/cli.mjs superagent-watch [--db PATH]

Notes:
  - Use the local Super-agent workbench for real public research. Configure DEEPSEEK_API_KEY
    and a separate GEO_STUDIO_TEST_TOKEN in the serving process.
  - Fixture results are explicitly labelled and never count as production evidence.
`);
}

function queryIds(args) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--query-id" && process.argv[index + 1]) values.push(process.argv[index + 1]);
    if (process.argv[index].startsWith("--query-id=")) values.push(process.argv[index].split("=").slice(1).join("="));
  }
  return values.length ? values : undefined;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const { rootDir, dbPath, installationScope } = installationOptions({ rootDir: args.root, dbPath: args.db });

if (command === "help" || args.help) {
  usage();
  process.exit(0);
}

if (command === "serve") {
  const app = createGeoStudioServer({ rootDir, dbPath, installationScope });
  const host = args.host ?? process.env.GEO_STUDIO_TEST_HOST ?? STUDIO_HOST;
  const port = Number(args.port ?? process.env.GEO_STUDIO_TEST_PORT ?? STUDIO_PORT);
  try {
    const address = await app.listen({ host, port });
    console.log(`GeoEvidence Studio Test: http://localhost:${address.port}`);
  } catch (error) { await app.close(); throw error; }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close().catch(() => { process.exitCode = 1; }));
} else {
  const store = new GeoStore(dbPath, { installationScope });
  const service = new GeoEvidenceService(store, { rootDir });
  try {
    if (command === "init") {
      print({
        database: store.path,
        queryCount: store.listQueries({ limit: 1000 }).length,
        case: "future-frontdesk",
      });
    } else if (command === "superagent-watch") {
      print(scanGeoSuperagent(store.superagent, installationScope));
    } else if (command === "run") {
      if (args.provider && !["fixture", "manual-import"].includes(args.provider)) {
        throw new Error("真实 DeepSeek 任务通过本机证据任务工作台执行");
      }
      if (args.baseUrl || args.model) throw new Error("旧采集入口不允许自定义模型或服务地址");
      const result = await service.runObservations({
        provider: args.provider ?? "fixture",
        limit: number(args.limit, 20),
        category: args.category,
        queryIds: queryIds(args),
        file: args.file,
        concurrency: number(args.concurrency, 2),
        platform: args.platform,
      });
      print(result);
    } else if (command === "articles") {
      print(service.generateArticles({
        topicIds: args.topic ? [args.topic] : undefined,
        force: Boolean(args.force),
        dataMode: args.dataMode ?? "draft",
      }));
    } else if (command === "publish") {
      if (!args.articleId) throw new Error("publish 需要 --article-id");
      print(await service.publishArticle({
        articleId: args.articleId,
        channel: args.channel ?? "local",
        approvedBy: args.approvedBy,
      }));
    } else if (command === "report") {
      print(await service.writeReport({ runId: args.runId, outDir: args.out }));
    } else if (command === "reanalyze") {
      if (!args.runId) throw new Error("reanalyze 需要 --run-id");
      print(service.reanalyzeRun(args.runId));
    } else if (command === "export-queries") {
      const output = resolve(args.out ?? `${rootDir}/outputs/geo-evidence-studio/future-frontdesk-queries.csv`);
      await mkdir(resolve(output, ".."), { recursive: true });
      const queries = store.listQueries({ limit: 1000 });
      const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [
        ["id", "category", "priority", "risk", "product", "status", "query"],
        ...queries.map((query) => [
          query.id,
          query.category,
          query.priority,
          query.risk,
          query.product ?? "",
          query.status,
          query.text,
        ]),
      ].map((row) => row.map(quote).join(",")).join("\n");
      await writeFile(output, `${csv}\n`, "utf8");
      print({ output, queries: queries.length });
    } else if (command === "summary") {
      print(service.summary({ runId: args.runId }));
    } else {
      usage();
      process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}
