# WorkLoom 获客增长系统 · 代码与能力入口导览

> 企业获客与内容运营工作系统：工作台、行业包声明、内容生产工位与共享治理组件。
> 本文件由 [generate-capabilities.mjs](../scripts/generate-capabilities.mjs) 自动生成（2026-11-03）。请修改生成器或事实输入后重新生成，不手改本文件。
> 本导览检查 manifest、脚本和文件入口。目录可发现、实际可调用、结果已验证分别记录；缺少同提交独立运行证据时后两项为未验证。岗位、技能与管线数是声明资产数，不是生产实测通过数。
> 产品身份：`workloom-ai-acquisition`；默认包：`geo-growth`；仓库：[geniusdapeng-collab/geo-evidence-studio-test](https://github.com/geniusdapeng-collab/geo-evidence-studio-test)。

## 从哪里开始

先读 [README](../README.md) 的功能状态、依赖和快速开始。准备 Node >=24.0.0、pnpm@10.14.0 与隔离 PostgreSQL 后，按 README 运行模拟体验。`preview:all` 会迁移、灌种子并处理占用端口，不应指向现有生产库；模型模拟需显式设置，视频、语音、发布与消息渠道另需真实依赖。

| 端 | 地址 | 看什么 |
|---|---|---|
| PC 工作台 | http://localhost:3000 | 任务、岗位、报告、组合看板与视频入口 |
| 员工移动工作台 | http://localhost:3001 | React 员工移动应用，与静态原型分开 |
| 客户 H5 服务前台 | http://localhost:3002 | preview 默认使用酒店夹具；增长前台需按 README 单独配置 |

## 行业包声明数量

| 行业包 | 声明版本 | 状态 | 岗位定义 | 技能路径 | 管线 |
|---|---|---|---:|---:|---:|
| [ai-video](../bundles/ai-video/bundle.json) | 1.0.0 | candidate | 42 | 35 | 6 |
| [geo-growth](../bundles/geo-growth/bundle.json) | 1.0.0 | candidate | 27 | 29 | 4 |
| [hotel](../bundles/hotel/bundle.json) | 3.4.0 | candidate | 16 | 30 | 1 |
| 声明合计 | — | — | 85 | 94 | 11 |

岗位文件的 `preset_key` 去重得到 **81 个不同标识**；这是本仓声明去重计数，实际依赖装配和同名权威归属以主包 `composition.presetOwners` 与 [装配器](../packages/base/bundles/assembly.ts) 为准。

## 代码与资产入口（43 项）

### 🖥 三端应用入口

来源：[product.manifest.json](../product.manifest.json) · [apps/web/src/App.tsx](../apps/web/src/App.tsx) · [apps/webb/src/App.tsx](../apps/webb/src/App.tsx) · [apps/webc/src/App.tsx](../apps/webc/src/App.tsx)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **PC 工作台** | 任务、岗位、报告、行业入口；可见内容受权限和活动行业包影响 | 隔离演示启动后：http://localhost:3000 | 是 | 未验证 | 未验证 |
| **员工移动工作台** | React 员工移动应用；与 docs/demo 的历史静态原型分开看 | 隔离演示启动后：http://localhost:3001 | 是 | 未验证 | 未验证 |
| **客户 H5 服务前台** | 对话/服务/工单/消息/我的；preview 脚本使用酒店服务夹具 | 隔离演示启动后：http://localhost:3002 | 是 | 未验证 | 未验证 |

### 🔎 GEO 研究任务工作台

来源：[apps/geo-evidence-studio/project.manifest.json](../apps/geo-evidence-studio/project.manifest.json) · [apps/geo-evidence-studio/README-superagent.md](../apps/geo-evidence-studio/README-superagent.md)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **公开取证与历史轮次** | 本机按线程补充研究；SQLite 留存证据、引用和模型用量。真实研究需单独配置凭据。 | [启动与鉴权说明](../apps/geo-evidence-studio/README-superagent.md) | 是 | 未验证 | 未验证 |

### 📦 行业包声明资产

来源：[bundles/ai-video/bundle.json](../bundles/ai-video/bundle.json) · [bundles/geo-growth/bundle.json](../bundles/geo-growth/bundle.json) · [bundles/hotel/bundle.json](../bundles/hotel/bundle.json)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **bundles/ai-video/** | 42 条岗位定义 / 35 项技能路径 / 6 条管线；版本 1.0.0，状态 candidate；不等于已接通功能数 | [manifest](../bundles/ai-video/bundle.json) | 是 | 未验证 | 未验证 |
| **bundles/geo-growth/** | 27 条岗位定义 / 29 项技能路径 / 4 条管线；版本 1.0.0，状态 candidate；不等于已接通功能数 | [manifest](../bundles/geo-growth/bundle.json) | 是 | 未验证 | 未验证 |
| **bundles/hotel/** | 16 条岗位定义 / 30 项技能路径 / 1 条管线；版本 3.4.0，状态 candidate；不等于已接通功能数 | [manifest](../bundles/hotel/bundle.json) | 是 | 未验证 | 未验证 |

### 🧑‍💼 岗位与交互入口

来源：[apps/web/src/pages/p8/P8.tsx](../apps/web/src/pages/p8/P8.tsx) · [apps/web/src/components/loommate/LoomMate.tsx](../apps/web/src/components/loommate/LoomMate.tsx) · [apps/web/src/voice/VoiceEngine.ts](../apps/web/src/voice/VoiceEngine.ts)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **数字员工中心（`/agents`）** | 岗位档案 / 技能与围栏绑定 / 任务派遣；默认包声明 27 个岗位，不是在线员工数 | 按 README 准备隔离环境后：`LLM_PROVIDER=mock pnpm preview:all` → http://localhost:3000/agents | 是 | 未验证 | 未验证 |
| **织伴数字人组件** | 形象、语音与动作交互组件；需要对应资源与配置，不承诺每个部署均启用 | 查看组件与语音配置 | 是 | 未验证 | 未验证 |
| **语音与口型引擎** | 语音播放、音色与口型相关实现；真实 TTS 需要服务或本地引擎 | docs/voice-and-avatar-delivery-contract.md | 是 | 未验证 | 未验证 |

### 🖐 电脑操作接口

来源：[packages/base/computer-use/driver.ts](../packages/base/computer-use/driver.ts) · [docs/computer-use-production.md](../docs/computer-use-production.md)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **浏览器与桌面驱动接口** | DOM、语义树与截图接口；真实登录、文件上传和平台动作需逐项联调 | 按工位指南准备后：`pnpm computer:preflight` / `pnpm computer:smoke` | 是 | 未验证 | 未验证 |
| **HTTP / MCP 工位入口** | 远程工位服务入口；需要驱动、设备权限、认证与网络配置 | `pnpm computer:serve` / `pnpm computer:mcp` | 是 | 未验证 | 未验证 |

### ⚙ 共享基础模块（目录存在性）

来源：[packages/base](../packages/base) · [packages/runtime/src](../packages/runtime/src)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **围栏判定** | auto/review/block 判定组件；仍需核对业务调用点 | [源码](../packages/base/fence-engine/) | 是 | 未验证 | 未验证 |
| **技能分发组件** | 技能预检、分发与回滚基础模块 | [源码](../packages/base/skill-ops/) | 是 | 未验证 | 未验证 |
| **任务编排基础组件** | 任务与协作基础模块；Ask/Quest 实际执行见 packages/runtime | [源码](../packages/base/captain/) | 是 | 未验证 | 未验证 |
| **夜班状态与调度** | 确认、暂停、恢复与触发器；暂停记录不等于中断全部外部动作 | [源码](../packages/base/night-shift/) | 是 | 未验证 | 未验证 |
| **模型路由与用量记录** | 模拟与真实提供器入口；真实端点、成本和预算链需验收 | [源码](../packages/base/model-router/) | 是 | 未验证 | 未验证 |
| **发布适配层（默认演练）** | 浏览器发布参考适配器；真实登录、上传和发布回执待逐平台接通 | [源码](../packages/base/publish-rpa/) | 是 | 未验证 | 未验证 |
| **业务事件与权限网关** | 追加事件、哈希链与权限组件；不承诺外部动作重放零丢失 | [源码](../packages/base/workdata/) | 是 | 未验证 | 未验证 |
| **消息渠道适配层** | 消息接口模块；实际送达取决于已配置渠道与回执 | [源码](../packages/base/im-channels/) | 是 | 未验证 | 未验证 |
| **服务对话基础模块** | 对话组件；客户 H5 实际接口见 apps/server/src/service | [源码](../packages/base/service-dialog/) | 是 | 未验证 | 未验证 |
| **巡检基础模块** | 巡检规则与任务组件；具体数据源和处置链需接入 | [源码](../packages/base/inspection/) | 是 | 未验证 | 未验证 |
| **审批后端** | 决定与审计 API 保留；PC 通用审批页已移除，业务关卡就地处理 | [源码](../packages/base/review-console/) | 是 | 未验证 | 未验证 |
| **资产管理基础模块** | 资产元数据组件；视频媒资实现见 apps/server/src/video/media | [源码](../packages/base/asset-cms/) | 是 | 未验证 | 未验证 |
| **成本台账组件** | 成本记录与投影；目录存在不代表全部调用已有预算强制 | [源码](../packages/base/cost-ledger/) | 是 | 未验证 | 未验证 |
| **交易流程组件** | 商机与交易状态模块；不代表真实支付和收入归因已完成 | [源码](../packages/base/deal-flow/) | 是 | 未验证 | 未验证 |
| **社媒监听组件** | 监听相关基础模块；实际采集来源需逐项接入 | [源码](../packages/base/social-listening/) | 是 | 未验证 | 未验证 |

### 🎬 内容生产专用入口

来源：[apps/server/src/video](../apps/server/src/video)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **视频工位** | 预生产、渲染与后期分阶段启动；真实模型、供应商和媒体依赖需配置 | PC /ai-video/assets?tab=studio | 是 | 未验证 | 未验证 |
| **媒资与交付** | 媒资检索、商品档案、合集、成片和交付记录；需要数据库与媒体文件 | 媒资：/ai-video/media；交付：/ai-video/assets?tab=delivery | 是 | 未验证 | 未验证 |
| **白板与口播解释片** | 白板和口播制作链已提供代码入口；当前没有独立 React 编辑页，需要对应引擎与后期工具 | CLI / 服务端接口 | 是 | 未验证 | 未验证 |

### ✅ 验证与维护命令

来源：[package.json](../package.json) · [scripts/bootstrap.sh](../scripts/bootstrap.sh) · [.cnb.yml](../.cnb.yml)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **环境安装脚本** | 安装依赖并尝试数据库、迁移与种子；当前会枚举缺失 ai-pm 包的种子，推荐按 README 手动初始化 | `pnpm setup`；先读 README 的当前限制 | 是 | 未验证 | 未验证 |
| **主测试套件** | 运行已定义场景；需要测试数据库和种子，不能由脚本存在推断测试已通过 | `pnpm suite` | 是 | 未验证 | 未验证 |
| **GEO 域套件** | GEO 双域专项 | `pnpm suite:geo` | 是 | 未验证 | 未验证 |
| **酒店域套件** | 酒店域专项 | `pnpm suite:hotel` | 是 | 未验证 | 未验证 |
| **发布门禁** | 未全过禁止发布（硬性） | `pnpm release:gate` | 是 | 未验证 | 未验证 |
| **五元事件验链** | 事件链完整性校验 | `pnpm db:verify-chain` | 是 | 未验证 | 未验证 |
| **能力巡游脚本** | 按脚本范围巡游；完整模式可能启动服务、灌种子和运行测试 | `pnpm agent:tour` | 是 | 未验证 | 未验证 |
| **环境自检** | 一屏排查环境问题 | `pnpm doctor` | 是 | 未验证 | 未验证 |

### 📚 演示与说明资产

来源：[docs/demo](../docs/demo) · [skills/official](../skills/official) · [mock/README.md](../mock/README.md)。

| 入口 | 用途与边界 | 查阅或运行 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **静态演示原型 ×12** | 按 HTML 文件枚举；历史原型不作为当前 React 页面证明 | docs/demo/index.html | 是 | 未验证 | 未验证 |
| **官网静态页面** | 网站素材；文字和截图需按当前代码复核 | apps/site/index.html | 是 | 未验证 | 未验证 |
| **official 技能目录 ×9** | 按目录枚举；与 Bundle 技能声明计数不同，也不等于真实执行器数量 | skills/official/ | 是 | 未验证 | 未验证 |
| **历史能力导览 PPT** | 历史参考资产；其中旧文案和截图需要独立更新，不作为当前实现证明 | docs/capability-tour.pptx | 是 | 未验证 | 未验证 |
| **模拟数据说明** | 种子、模拟提供器与演示身份；真实数据和生产模式单独配置 | mock/README.md | 是 | 未验证 | 未验证 |

## 🧭 下一步

- 开始开发先读 [AGENTS.md](../AGENTS.md)、[本仓规则](../AGENTS.repo.md) 与 [开发协议](DEVELOPMENT-PROTOCOL.md)。
- 能力入口变化后运行 `pnpm capabilities` 和 `pnpm capabilities:check`；UI 改动还需按 [设计规范](design-system.md) 实际打开页面核对。
- 发布前按 [发布清单](release-checklist.md) 执行 `pnpm release:gate`，真实平台接入另做场景验收；本目录不替代门禁结果。
