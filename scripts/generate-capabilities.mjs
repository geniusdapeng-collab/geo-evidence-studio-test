#!/usr/bin/env node
/**
 * generate-capabilities.mjs · 代码与能力入口导览生成器（文档派生，防漂移）
 *
 * 从 manifest、脚本与文件存在性（不等于真实工具接通或生产实测通过）
 * 自动生成两份导览及 README 区块：
 *   ① docs/capabilities.auto.md   —— 入口、用途、依赖边界与来源
 *   ② docs/capabilities.auto.json —— 结构化数据（供 PPT 生成器等消费）
 *   ③ README.md 中 <!-- CAPABILITIES:BEGIN/END --> 区块 —— CNB 项目页入口
 *
 * 用法：
 *   node scripts/generate-capabilities.mjs          # 生成/更新（README 区块原地替换）
 *   node scripts/generate-capabilities.mjs --check  # 校验产物是否最新（漂移 exit 1，可入 CI/门禁）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { capabilityStatus } from "./capability-status.mjs";

const ROOT = join(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");
const J = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const ls = (p, filter) => existsSync(join(ROOT, p)) ? readdirSync(join(ROOT, p)).filter(filter ?? (() => true)).sort() : [];

const pkg = J("package.json");
const scripts = Object.keys(pkg.scripts ?? {});
const has = (s) => scripts.includes(s);
const basePkgs = ls("packages/base", (d) => !d.includes(".") && d !== "node_modules");
const bundles = ls("bundles", (d) => !d.includes("."));
const skills = ls("skills/official", (d) => !d.includes("."));
const demoPages = ls("docs/demo", (f) => f.endsWith(".html") && !["index.html", "shell.html"].includes(f));
const shots = ls("docs/demo/preview-shots", (f) => f.endsWith(".png"));
// 按 manifest 统计所有包的声明；默认包由 product.manifest.json 指定。
const productManifest = existsSync(join(ROOT, "product.manifest.json")) ? J("product.manifest.json") : {};
const studioManifest = existsSync(join(ROOT, "apps/geo-evidence-studio/project.manifest.json"))
  ? J("apps/geo-evidence-studio/project.manifest.json") : null;
const repository = studioManifest?.repository ?? productManifest.repository;
const repositoryHost = repository?.startsWith("geniusdapeng-collab/") ? "github.com" : "cnb.cool";
const defaultBundle = bundles.includes(productManifest.defaultBundle) ? productManifest.defaultBundle : null;
const bundleDeclarations = bundles.filter((b) => existsSync(join(ROOT, `bundles/${b}/bundle.json`))).map((b) => {
  const manifest = J(`bundles/${b}/bundle.json`);
  const provides = manifest.workloom?.provides;
  if (!provides || !["presets", "skills", "pipelines"].every((key) => Array.isArray(provides[key]))) throw new Error(`Bundle 声明不完整：${b}`);
  const presetKeys = provides.presets.map((file) => {
    const body = readFileSync(join(ROOT, "bundles", b, file), "utf8");
    const matches = [...body.matchAll(/^preset_key:\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/gm)];
    if (matches.length !== 1) throw new Error(`无法唯一提取 preset_key：${b}/${file}`);
    return matches[0][1];
  });
  for (const key of ["presets", "skills", "pipelines"]) for (const file of provides[key]) {
    if (!existsSync(join(ROOT, "bundles", b, file))) throw new Error(`Bundle 声明路径不存在：${b}/${file}`);
  }
  return { bundle: b, version: manifest.version, status: manifest.workloom.status, presets: provides.presets.length, skills: provides.skills.length, pipelines: provides.pipelines.length, presetKeys, sourcePath: `bundles/${b}/bundle.json` };
});
const defaultDeclaration = bundleDeclarations.find((b) => b.bundle === defaultBundle);
const declarationTotals = bundleDeclarations.reduce((sum, b) => ({ presets: sum.presets + b.presets, skills: sum.skills + b.skills, pipelines: sum.pipelines + b.pipelines }), { presets: 0, skills: 0, pipelines: 0 });
const uniquePresetKeys = new Set(bundleDeclarations.flatMap((b) => b.presetKeys)).size;
const repoName = pkg.name?.split("/").pop() || "workloom";
const desc = "企业获客与内容运营工作系统：工作台、行业包声明、内容生产工位与共享治理组件。";
const evidenceNotice = "本导览检查 manifest、脚本和文件入口。目录可发现、实际可调用、结果已验证分别记录；缺少同提交独立运行证据时后两项为未验证。岗位、技能与管线数是声明资产数，不是生产实测通过数。";

// ---------- 能力分组（按事实探测，出现的才列出） ----------
const groups = [];

groups.push({
  icon: "🖥", title: "三端应用入口",
  items: [
    existsSync(join(ROOT, "apps/web/package.json")) && { name: "PC 工作台", how: "隔离演示启动后：http://localhost:3000", desc: "任务、岗位、报告、行业入口；可见内容受权限和活动行业包影响" },
    existsSync(join(ROOT, "apps/webb/package.json")) && { name: "员工移动工作台", how: "隔离演示启动后：http://localhost:3001", desc: "React 员工移动应用；与 docs/demo 的历史静态原型分开看" },
    existsSync(join(ROOT, "apps/webc/package.json")) && { name: "客户 H5 服务前台", how: "隔离演示启动后：http://localhost:3002", desc: "对话/服务/工单/消息/我的；preview 脚本使用酒店服务夹具" },
  ].filter(Boolean),
});

if (has("geo:studio") && existsSync(join(ROOT, "apps/geo-evidence-studio/README-superagent.md"))) {
  groups.push({
    icon: "🔎", title: "GEO 研究任务工作台",
    items: [{
      name: "公开取证与历史轮次", how: "[启动与鉴权说明](../apps/geo-evidence-studio/README-superagent.md)",
      desc: "本机按线程补充研究；SQLite 留存证据、引用和模型用量。真实研究需单独配置凭据。",
      sourcePaths: ["apps/geo-evidence-studio/server.mjs", "apps/geo-evidence-studio/lib/superagent.mjs"],
    }],
  });
}

if (bundles.length) groups.push({
  icon: "📦", title: "行业包声明资产",
  items: bundleDeclarations.map((b) => ({
    name: `bundles/${b.bundle}/`,
    how: `[manifest](../${b.sourcePath})`,
    desc: `${b.presets} 条岗位定义 / ${b.skills} 项技能路径 / ${b.pipelines} 条管线；版本 ${b.version}，状态 ${b.status}；不等于已接通功能数`,
  })),
});

// 数字员工与数字人（事实探测：页面/组件/资产/语音引擎存在才列出）
const digitalWorkforce = [
  existsSync(join(ROOT, "apps/web/src/pages/p8/P8.tsx")) && {
    name: "数字员工中心（`/agents`）",
    how: "按 README 准备隔离环境后：`LLM_PROVIDER=mock pnpm preview:all` → http://localhost:3000/agents",
    desc: `岗位档案 / 技能与围栏绑定 / 任务派遣${defaultDeclaration ? `；默认包声明 ${defaultDeclaration.presets} 个岗位` : ""}，不是在线员工数`,
  },
  existsSync(join(ROOT, "apps/web/src/components/loommate/LoomMate.tsx")) && {
    name: "织伴数字人组件",
    how: "查看组件与语音配置",
    desc: "形象、语音与动作交互组件；需要对应资源与配置，不承诺每个部署均启用",
  },
  existsSync(join(ROOT, "apps/web/src/voice/VoiceEngine.ts")) && {
    name: "语音与口型引擎",
    how: "docs/voice-and-avatar-delivery-contract.md",
    desc: "语音播放、音色与口型相关实现；真实 TTS 需要服务或本地引擎",
  },
].filter(Boolean);
if (digitalWorkforce.length) groups.push({
  icon: "🧑‍💼", title: "岗位与交互入口", items: digitalWorkforce,
});

if (basePkgs.includes("computer-use")) groups.push({
  icon: "🖐", title: "电脑操作接口",
  items: [
    { name: "浏览器与桌面驱动接口", how: "按工位指南准备后：`pnpm computer:preflight` / `pnpm computer:smoke`", desc: "DOM、语义树与截图接口；真实登录、文件上传和平台动作需逐项联调" },
    { name: "HTTP / MCP 工位入口", how: "`pnpm computer:serve` / `pnpm computer:mcp`", desc: "远程工位服务入口；需要驱动、设备权限、认证与网络配置" },
  ],
});

const engine = [
  ["fence-engine", "围栏判定", "auto/review/block 判定组件；仍需核对业务调用点"],
  ["skill-ops", "技能分发组件", "技能预检、分发与回滚基础模块"],
  ["captain", "任务编排基础组件", "任务与协作基础模块；Ask/Quest 实际执行见 packages/runtime"],
  ["night-shift", "夜班状态与调度", "确认、暂停、恢复与触发器；暂停记录不等于中断全部外部动作"],
  ["model-router", "模型路由与用量记录", "模拟与真实提供器入口；真实端点、成本和预算链需验收"],
  ["publish-rpa", "发布适配层（默认演练）", "浏览器发布参考适配器；真实登录、上传和发布回执待逐平台接通"],
  ["workdata", "业务事件与权限网关", "追加事件、哈希链与权限组件；不承诺外部动作重放零丢失"],
  ["im-channels", "消息渠道适配层", "消息接口模块；实际送达取决于已配置渠道与回执"],
  ["service-dialog", "服务对话基础模块", "对话组件；客户 H5 实际接口见 apps/server/src/service"],
  ["inspection", "巡检基础模块", "巡检规则与任务组件；具体数据源和处置链需接入"],
  ["review-console", "审批后端", "决定与审计 API 保留；PC 通用审批页已移除，业务关卡就地处理"],
  ["asset-cms", "资产管理基础模块", "资产元数据组件；视频媒资实现见 apps/server/src/video/media"],
  ["cost-ledger", "成本台账组件", "成本记录与投影；目录存在不代表全部调用已有预算强制"],
  ["deal-flow", "交易流程组件", "商机与交易状态模块；不代表真实支付和收入归因已完成"],
  ["social-listening", "社媒监听组件", "监听相关基础模块；实际采集来源需逐项接入"],
].filter(([k]) => basePkgs.includes(k));
if (engine.length) groups.push({
  icon: "⚙", title: "共享基础模块（目录存在性）",
  items: engine.map(([key, n, d]) => ({ name: n, how: `[源码](../packages/base/${key}/)`, desc: d, sourcePaths: [`packages/base/${key}`] })),
});

if (existsSync(join(ROOT, "apps/server/src/video/router.ts"))) groups.push({
  icon: "🎬", title: "内容生产专用入口",
  items: [
    { name: "视频工位", how: "PC /ai-video/assets?tab=studio", desc: "预生产、渲染与后期分阶段启动；真实模型、供应商和媒体依赖需配置", sourcePaths: ["apps/server/src/video/router.ts", "apps/server/src/video/studio-worker.ts"] },
    { name: "媒资与交付", how: "媒资：/ai-video/media；交付：/ai-video/assets?tab=delivery", desc: "媒资检索、商品档案、合集、成片和交付记录；需要数据库与媒体文件", sourcePaths: ["apps/server/src/video/media/index.ts", "apps/web/src/extensions/ai-video/pages/AssetsOrStudio.tsx", "apps/web/src/extensions/ai-video/routes.tsx"] },
    { name: "白板与口播解释片", how: "CLI / 服务端接口", desc: "白板和口播制作链已提供代码入口；当前没有独立 React 编辑页，需要对应引擎与后期工具", sourcePaths: ["apps/server/src/video/whiteboard/router.ts", "apps/server/src/video/explainer/router.ts"] },
  ],
});

const quality = [
  has("setup") && { name: "环境安装脚本", how: "`pnpm setup`；先读 README 的当前限制", desc: "安装依赖并尝试数据库、迁移与种子；当前会枚举缺失 ai-pm 包的种子，推荐按 README 手动初始化" },
  has("suite") && { name: "主测试套件", how: "`pnpm suite`", desc: "运行已定义场景；需要测试数据库和种子，不能由脚本存在推断测试已通过" },
  has("suite:geo") && { name: "GEO 域套件", how: "`pnpm suite:geo`", desc: "GEO 双域专项" },
  has("suite:hotel") && { name: "酒店域套件", how: "`pnpm suite:hotel`", desc: "酒店域专项" },
  has("release:gate") && { name: "发布门禁", how: "`pnpm release:gate`", desc: "未全过禁止发布（硬性）" },
  has("db:verify-chain") && { name: "五元事件验链", how: "`pnpm db:verify-chain`", desc: "事件链完整性校验" },
  has("agent:tour") && { name: "能力巡游脚本", how: "`pnpm agent:tour`", desc: "按脚本范围巡游；完整模式可能启动服务、灌种子和运行测试" },
  has("doctor") && { name: "环境自检", how: "`pnpm doctor`", desc: "一屏排查环境问题" },
].filter(Boolean);
groups.push({ icon: "✅", title: "验证与维护命令", items: quality });

const assets = [
  demoPages.length && { name: `静态演示原型 ×${demoPages.length}`, how: "docs/demo/index.html", desc: "按 HTML 文件枚举；历史原型不作为当前 React 页面证明" },
  existsSync(join(ROOT, "apps/site")) && { name: "官网静态页面", how: "apps/site/index.html", desc: "网站素材；文字和截图需按当前代码复核" },
  skills.length && { name: `official 技能目录 ×${skills.length}`, how: "skills/official/", desc: "按目录枚举；与 Bundle 技能声明计数不同，也不等于真实执行器数量" },
  existsSync(join(ROOT, "docs/capability-tour.pptx")) && { name: "历史能力导览 PPT", how: "docs/capability-tour.pptx", desc: "历史参考资产；其中旧文案和截图需要独立更新，不作为当前实现证明" },
  existsSync(join(ROOT, "mock/README.md")) && { name: "模拟数据说明", how: "mock/README.md", desc: "种子、模拟提供器与演示身份；真实数据和生产模式单独配置" },
].filter(Boolean);
groups.push({ icon: "📚", title: "演示与说明资产", items: assets });

const sourceSets = {
  "三端应用入口": ["product.manifest.json", "apps/web/src/App.tsx", "apps/webb/src/App.tsx", "apps/webc/src/App.tsx"],
  "GEO 研究任务工作台": ["apps/geo-evidence-studio/project.manifest.json", "apps/geo-evidence-studio/README-superagent.md"],
  "行业包声明资产": bundleDeclarations.map((b) => b.sourcePath),
  "岗位与交互入口": ["apps/web/src/pages/p8/P8.tsx", "apps/web/src/components/loommate/LoomMate.tsx", "apps/web/src/voice/VoiceEngine.ts"],
  "电脑操作接口": ["packages/base/computer-use/driver.ts", "docs/computer-use-production.md"],
  "共享基础模块（目录存在性）": ["packages/base", "packages/runtime/src"],
  "内容生产专用入口": ["apps/server/src/video"],
  "验证与维护命令": ["package.json", "scripts/bootstrap.sh", ".cnb.yml"],
  "演示与说明资产": ["docs/demo", "skills/official", "mock/README.md"],
};
for (const group of groups) {
  group.sourcePaths = sourceSets[group.title] ?? [];
  for (const entry of group.items) entry.sourcePaths ??= group.sourcePaths;
  for (const file of [...group.sourcePaths, ...group.items.flatMap((entry) => entry.sourcePaths)]) {
    if (!existsSync(join(ROOT, file))) throw new Error(`能力导览来源不存在：${file}`);
  }
}
const sourceLinks = (paths) => paths.map((file) => `[${file}](../${encodeURI(file)})`).join(" · ");
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

// ---------- 生成 JSON ----------
// 路径只证明可发现性。运行状态从提交/散列/时间绑定的独立结果取证，默认未验证。
let currentCommit = null;
try { currentCommit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { currentCommit = null; }
const attestations = existsSync(join(ROOT, "acceptance/capability-status.json")) ? J("acceptance/capability-status.json") : { entries: [] };
if (!Array.isArray(attestations.entries)) throw new Error("capability-status.json 必须含 entries 数组");
for (const group of groups) for (const item of group.items) {
  item.id = `cap:${createHash("sha256").update(`${group.title}/${item.name}`).digest("hex").slice(0, 16)}`;
  item.availability = capabilityStatus({ root: ROOT, id: item.id, discoverable: true, currentCommit, attestation: attestations.entries.find(entry => entry.id === item.id) });
}
const data = { schema: "workloom.capabilities/v2", repo: repoName, productId: productManifest.productId, repository, displayName: productManifest.displayName, description: desc, generatedAt: new Date().toISOString(), evidenceNotice, bundleDeclarations, declarationTotals: { ...declarationTotals, uniquePresetKeys }, demoPages, shots, groups };

// ---------- 生成 Markdown（人类版导览） ----------
const declarationTable = `| 行业包 | 声明版本 | 状态 | 岗位定义 | 技能路径 | 管线 |\n|---|---|---|---:|---:|---:|\n${bundleDeclarations.map((b) => `| [${b.bundle}](../${b.sourcePath}) | ${b.version} | ${b.status} | ${b.presets} | ${b.skills} | ${b.pipelines} |`).join("\n")}\n| 声明合计 | — | — | ${declarationTotals.presets} | ${declarationTotals.skills} | ${declarationTotals.pipelines} |`;

const md = `# ${productManifest.displayName || repoName} · 代码与能力入口导览

> ${desc}
> 本文件由 [generate-capabilities.mjs](../scripts/generate-capabilities.mjs) 自动生成（${data.generatedAt.slice(0, 10)}）。请修改生成器或事实输入后重新生成，不手改本文件。
> ${evidenceNotice}
> 产品身份：\`${productManifest.productId}\`；默认包：\`${productManifest.defaultBundle}\`；仓库：[${repository}](https://${repositoryHost}/${repository})。

## 从哪里开始

先读 [README](../README.md) 的功能状态、依赖和快速开始。准备 Node ${pkg.engines.node}、${pkg.packageManager} 与隔离 PostgreSQL 后，按 README 运行模拟体验。\`preview:all\` 会迁移、灌种子并处理占用端口，不应指向现有生产库；模型模拟需显式设置，视频、语音、发布与消息渠道另需真实依赖。

| 端 | 地址 | 看什么 |
|---|---|---|
| PC 工作台 | http://localhost:3000 | 任务、岗位、报告、组合看板与视频入口 |
| 员工移动工作台 | http://localhost:3001 | React 员工移动应用，与静态原型分开 |
| 客户 H5 服务前台 | http://localhost:3002 | preview 默认使用酒店夹具；增长前台需按 README 单独配置 |

## 行业包声明数量

${declarationTable}

岗位文件的 \`preset_key\` 去重得到 **${uniquePresetKeys} 个不同标识**；这是本仓声明去重计数，实际依赖装配和同名权威归属以主包 \`composition.presetOwners\` 与 [装配器](../packages/base/bundles/assembly.ts) 为准。

## 代码与资产入口（${groups.reduce((n, g) => n + g.items.length, 0)} 项）

${groups.map((g) => `### ${g.icon} ${g.title}\n\n来源：${sourceLinks(g.sourcePaths)}。\n\n| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |\n|---|---|---|---|---|---|\n${g.items.map((i) => `| **${cell(i.name)}** | ${cell(i.desc)} | ${cell(i.how)} | 是 | ${i.availability.callable === true ? "是" : "未验证"} | ${i.availability.verified === true ? `是 / ${i.availability.environment}` : "未验证"} |`).join("\n")}`).join("\n\n")}

## 🧭 下一步

- 开始开发先读 [AGENTS.md](../AGENTS.md)、[本仓规则](../AGENTS.repo.md) 与 [开发协议](DEVELOPMENT-PROTOCOL.md)。
- 能力入口变化后运行 \`pnpm capabilities\` 和 \`pnpm capabilities:check\`；UI 改动还需按 [设计规范](design-system.md) 实际打开页面核对。
- 发布前按 [发布清单](release-checklist.md) 执行 \`pnpm release:gate\`，真实平台接入另做场景验收；本目录不替代门禁结果。
`;

// ---------- README 区块 ----------
const readmeBlock = `<!-- CAPABILITIES:BEGIN -->
<!-- 本区块由 scripts/generate-capabilities.mjs 自动生成（${data.generatedAt.slice(0, 10)}），请勿手改；重跑 pnpm capabilities 更新 -->

## 代码与资产速览（自动生成）

${evidenceNotice}

${groups.map((g) => `- ${g.icon} **${g.title}**：${g.items.map((i) => i.name.replace(/\*\*/g, "")).slice(0, 6).join(" · ")}${g.items.length > 6 ? ` 等 ${g.items.length} 项` : ""}`).join("\n")}

本仓 manifest 共声明 **${declarationTotals.presets} 条岗位定义、${declarationTotals.skills} 项技能路径、${declarationTotals.pipelines} 条管线**；岗位按 \`preset_key\` 去重为 **${uniquePresetKeys} 个不同标识**。实际组合以主包与装配器为准。

完整来源与边界见 [自动导览](docs/capabilities.auto.md) 和 [机器清单](docs/capabilities.auto.json)；首次体验按下文“快速开始”准备隔离环境。
<!-- CAPABILITIES:END -->`;

// ---------- 写入 / 校验 ----------
const outs = [
  ["docs/capabilities.auto.md", md],
  ["docs/capabilities.auto.json", JSON.stringify(data, null, 1) + "\n"],
];
let stale = false;

const readmePath = join(ROOT, "README.md");
let readme = readFileSync(readmePath, "utf8");
let newReadme = readme;
if (readme.includes("<!-- CAPABILITIES:BEGIN -->")) {
  newReadme = readme.replace(/<!-- CAPABILITIES:BEGIN -->[\s\S]*?<!-- CAPABILITIES:END -->/, readmeBlock);
} else {
  // 首次：插到第一个 "---" 分隔线之前（标题区之后）
  const i = readme.indexOf("\n---\n");
  newReadme = i >= 0 ? readme.slice(0, i) + "\n\n" + readmeBlock + "\n" + readme.slice(i) : readmeBlock + "\n" + readme;
}
outs.push(["README.md", newReadme]);

// 校验模式下归一化易变字段（生成时间），避免跨时间误报漂移
const normalize = (s) => s
  .replace(/自动生成（\d{4}-\d{2}-\d{2}）/g, "自动生成（<DATE>）")
  .replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<TS>"')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "<TS>");

for (const [rel, content] of outs) {
  const p = join(ROOT, rel);
  const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
  if (cur === content || (CHECK && cur !== null && normalize(cur) === normalize(content))) { console.log(`  ✓ ${rel}（已最新）`); continue; }
  if (CHECK) { console.log(`  ✗ ${rel} 已漂移`); stale = true; continue; }
  writeFileSync(p, content);
  console.log(`  ✍ ${rel} 已更新`);
}

if (CHECK) {
  if (stale) { console.error("\n能力产物与代码漂移 → 运行 pnpm capabilities 重新生成"); process.exit(1); }
  console.log("能力文档与生成器一致 ✓（不代表生产验证）");
} else {
  console.log(`\n能力导览已生成：${groups.reduce((n, g) => n + g.items.length, 0)} 项代码/资产入口 · ${groups.length} 组；未调用模型、连接器或生产系统`);
}
