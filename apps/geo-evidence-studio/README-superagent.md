# GeoEvidence Studio Test · 研究任务工作台

从 Studio 首页的「研究任务工作台」提交公开研究。任务保留在讨论线程中，补充资料、引用、历史轮次和执行回执可以从同一个入口回查。原有 GEO 观测看板和样本数据继续使用各自的数据模式。

## 本机启动

需要 Node.js 24 或更高版本。从仓库根目录启动 Studio。默认只监听本机，使用端口 `14317` 和独立数据库 `var/geo-evidence-studio-test.sqlite`。

```bash
node apps/geo-evidence-studio/server.mjs
```

在本机浏览器打开 `http://127.0.0.1:14317/#research-tasks`。未配置模型密钥时可以浏览看板和已有研究回执。真实研究同时要求启动环境提供 `DEEPSEEK_API_KEY` 和独立的 `GEO_STUDIO_TEST_TOKEN`，请通过自己的秘密管理方式临时注入。模型采用官方公开调用 ID `deepseek-flash`，在 DeepSeek 的 2026-10-17 更新中对应 **DeepSeek-V4.1-Flash-1017**。Search 和 Fetch 各自调用官方接口，模型响应 ID 和计量在报告回执中单独记录。 [DeepSeek 更新日志](https://api-docs.deepseek.com/zh-cn/updates/) · [网页搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search/)

| 可选环境变量 | 用途 |
| --- | --- |
| `GEO_STUDIO_TEST_ROOT`、`GEO_STUDIO_TEST_DB` | 单独指定此副本的数据根目录与 SQLite 文件。 |
| `GEO_STUDIO_TEST_HOST`、`GEO_STUDIO_TEST_PORT` | 本机监听地址和端口。 |
| `GEO_STUDIO_TEST_TENANT`、`GEO_STUDIO_TEST_WORKSPACE` | 在启动时限定租户与工作区，默认均为 `local`。项目固定为 `future-frontdesk`。 |
| `GEO_STUDIO_TEST_TOKEN` | 本机 API 访问令牌。真实研究要求设置，离线看板可按需配置。设置后，在页面的「连接受保护的本地服务」输入。令牌仅在当前页面内存保存，刷新后需重新输入。 |

## 任务流程

1. 在当前项目的 `studio` 渠道输入讨论线程编号，并点「打开线程」。线程编号区分大小写。
2. 写研究目标并填写明确的公开搜索词。公开搜索词最多 128 个 Unicode 字符、512 字节。确认资料可以公开研究后提交。外部搜索服务只接收搜索词，原目标和补充信息会作为文本材料交给选定模型。
3. 选择任务，看排队、研究、完成、暂停或阻断状态。时间线显示接单和补充摘要，较长事件可点「读取事件原文」。报告中的来源编号可以与引用区对应，回执显示模型响应 ID、输入输出词元和请求摘要。
4. 对同一个任务追加线索，可填写新的公开搜索词，留空沿用最近一次已确认的搜索词。完成后收到补充会排队生成新一轮，旧轮报告和回执可通过「查看研究轮次」继续核对。
5. 如需排查停滞，点「扫描过期执行」。已暂停任务可在核对后显式恢复。外部调用结果不明的任务会进入阻断，防止自动重复收费。搜索、抓取、报告的回执独立保存。

也可用受信本机 CLI 扫描此安装下所有活动线程的过期租约。

```bash
node apps/geo-evidence-studio/cli.mjs superagent-watch
```

## HTTP 核对点

调用使用已配置的本机鉴权。租户、工作区和项目由启动配置决定，客户端通过 `channelId`、`threadId` 指定讨论范围。

| 路径 | 用途 |
| --- | --- |
| `GET /api/superagent/config` | 读取本机服务可用性、数据模式和固定范围。 |
| `GET /api/superagent/tasks?channelId=studio&threadId=geo-research` | 读取当前讨论的任务列表。 |
| `POST /api/superagent/events` | 新任务需要 `kind: "request"`、`eventId`、`channelId`、`threadId`、`text`、`publicResearch: true` 和 `params.query`。补充使用 `kind: "followup"` 并传当前 `taskId`。相同事件原样重放返回已有回执。 |
| `GET /api/superagent/tasks/<taskId>` | 带同一渠道和线程查询参数，读取任务、当前轮回执及事件摘要。 |
| `GET /api/superagent/tasks/<taskId>/events/<eventId>` | 带同一渠道和线程查询参数，按需读取事件原文。 |
| `GET /api/superagent/tasks/<taskId>/revisions/<revision>` | 带同一渠道和线程查询参数，读取指定轮次已提交的证据与报告。 |
| `POST /api/superagent/tasks/<taskId>/resume` | 用 `channelId`、`threadId` 显式恢复可安全重试的任务。 |
| `POST /api/superagent/watch` | 用 `channelId`、`threadId` 扫描本线程的过期执行。 |

测试副本的 HTTP 服务禁止发布。需要经过人工核对的本地导出继续通过受信本机 CLI 进行。待发布内容和客户数据保留在已有独立流程中。

## 无模型凭据的验证

```bash
node --test apps/geo-evidence-studio/test/*.test.mjs
```

本机测试使用隔离 SQLite 和确定性 HTTP 替身。可用同一事件 ID 发送两次、切换线程、回读长原文和历史轮次，核对浏览器展示与实际回执一致。真实模型验收应另行使用公开资料、真实响应 ID 和用量回执，保留与本机夹具的区分。
