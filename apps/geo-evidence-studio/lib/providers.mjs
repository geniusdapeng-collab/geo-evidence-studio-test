import { readFile } from "node:fs/promises";

function deepseekConfig(overrides = {}) {
  const rawBase = overrides.baseUrl
    ?? process.env.DEEPSEEK_BASE_URL
    ?? process.env.LLM_BASE_URL
    ?? "https://api.deepseek.com";
  const baseUrl = rawBase.replace(/\/anthropic\/?$/, "").replace(/\/$/, "");
  return {
    apiKey: overrides.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "",
    baseUrl,
    model: overrides.model ?? process.env.DEEPSEEK_MODEL ?? process.env.LLM_MODEL ?? "deepseek-flash",
    timeoutMs: Number(overrides.timeoutMs ?? process.env.DEEPSEEK_TIMEOUT_MS ?? 60_000),
  };
}

function ensureKey(config) {
  if (!config.apiKey.trim()) {
    throw new Error("缺少 DEEPSEEK_API_KEY。真实采集必须显式配置凭据；fixture 模式无需凭据。");
  }
}

function fixtureAnswer(query) {
  if (query.category === "brand") {
    const negative = query.id.endsWith("8") || query.id.endsWith("7");
    if (negative) {
      return {
        answer: `有用户反馈未来前台这类酒店自助机在高峰时段可能响应慢，售后体验也需要结合门店情况核实。这里讨论的是行业现象，不能直接推断为苏州未来前台的产品问题。建议查看真实工单与服务记录。[品牌资料](https://future-frontdesk.example/brand)`,
        raw: { fixture: true, scenario: "ambiguous-negative" },
      };
    }
    return {
      answer: `苏州未来前台是面向酒店场景的前台自助设备品牌，产品方向涉及酒店自助入住机、前台自助机和入住一体机。采购时应核验具体型号、PMS 对接、售后和隐私方案。[品牌资料](https://future-frontdesk.example/brand)`,
      raw: { fixture: true, scenario: "brand-positive" },
    };
  }

  if (query.category === "risk") {
    const assignBrandNegative = query.id.endsWith("5");
    if (assignBrandNegative) {
      return {
        answer: `关于酒店自助机故障问题，苏州未来前台某型号被反馈发卡失败后恢复较慢，需要人工前台介入。这个结论来自演示夹具，真实项目必须用原始答案和来源替换。[行业讨论](https://example.com/hotel-self-service-risk)`,
        raw: { fixture: true, scenario: "brand-negative" },
      };
    }
    return {
      answer: `酒店自助机可能遇到卡顿、识别失败、发卡异常或售后响应慢等问题。这些问题属于行业风险，不能因为问题里出现“酒店自助机不好”就自动判定某个品牌负面。采购方应要求现场试点并明确售后 SLA。[选型指南](https://example.com/hotel-self-service-guide)`,
      raw: { fixture: true, scenario: "industry-negative" },
    };
  }

  if (query.category === "compare") {
    return {
      answer: `酒店自助入住机方案需要比较前台流程、PMS 接口、证件识别、发卡、支付、隐私和售后。苏州未来前台可作为候选之一，但是否适合取决于具体酒店场景，不能只凭品牌名下结论。[采购清单](https://example.com/checklist)`,
      raw: { fixture: true, scenario: "comparison" },
    };
  }

  if (query.category === "scene") {
    return {
      answer: `小酒店和民宿实施自助入住，应先把提前预订、身份核验、房卡发放和异常转人工分开设计。入住量低或异常率高的门店，应保留人工入口。[实施指南](https://example.com/self-checkin)`,
      raw: { fixture: true, scenario: "scene-no-brand" },
    };
  }

  const mention = query.id.endsWith("0") || query.id.endsWith("5");
  return {
    answer: mention
      ? `选择酒店自助入住机时，要核对 PMS、证件、房卡、支付和售后。苏州未来前台是一个酒店前台自助设备品牌，采购前仍需用真实订单验证。[选型指南](https://example.com/selection)`
      : `酒店自助入住机采购要先确认业务流程、PMS 对接、身份核验、房卡发放、异常转人工和售后 SLA。仅有参数表不足以证明设备适合实际门店。[选型指南](https://example.com/selection)`,
    raw: { fixture: true, scenario: mention ? "category-brand" : "category-no-brand" },
  };
}

function normalizeSearchResults(body) {
  const candidates = [
    body?.results,
    body?.data?.results,
    body?.web?.results,
    body?.data,
  ];
  const results = candidates.find(Array.isArray) ?? [];
  return results.map((item) => ({
    title: String(item.title ?? item.name ?? ""),
    url: String(item.url ?? item.link ?? ""),
    content: String(item.content ?? item.snippet ?? item.summary ?? ""),
  })).filter((item) => item.url);
}

async function requestJson(url, init, timeoutMs) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { rawText: text.slice(0, 2000) };
  }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? body?.rawText ?? `HTTP ${response.status}`;
    throw new Error(`DeepSeek 请求失败 ${response.status}: ${String(message).slice(0, 500)}`);
  }
  return body;
}

function chatPrompt(query) {
  return `你是一个独立的消费者问题回答助手，不是品牌方。请直接回答用户问题，使用自然中文。不得编造品牌、型号、参数、价格、认证、客户案例或引用。无法确认时明确说明。若提供了搜索结果，只能使用结果中可核验的事实，并在末尾用 Markdown 链接列出实际使用来源。\n\n用户问题：${query.text}`;
}

export function getProviderCapabilities() {
  const config = deepseekConfig();
  return {
    fixture: true,
    deepseek: Boolean(config.apiKey),
    "deepseek-search": Boolean(config.apiKey),
    model: config.model,
    baseUrl: config.baseUrl,
  };
}

export function createProvider(name = "fixture", options = {}) {
  if (name === "fixture") {
    return {
      name,
      platform: options.platform ?? "fixture",
      dataMode: "fixture",
      model: "fixture-rules/v1",
      async answer(query) {
        return fixtureAnswer(query);
      },
    };
  }

  if (name === "manual-import") {
    if (!options.file) throw new Error("manual-import 需要 --file <jsonl>");
    const records = new Map();
    return {
      name,
      platform: options.platform ?? "manual",
      dataMode: "imported",
      model: "external-import",
      async prepare() {
        const text = await readFile(options.file, "utf8");
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          records.set(String(row.queryId ?? row.query_id), row);
        }
      },
      async answer(query) {
        const row = records.get(query.id);
        if (!row) throw new Error(`导入文件缺少 queryId=${query.id}`);
        return {
          answer: row.answer,
          raw: row,
          model: row.model ?? "external-import",
          citations: row.citations ?? undefined,
        };
      },
    };
  }

  if (name === "deepseek" || name === "deepseek-search") {
    const config = deepseekConfig(options);
    ensureKey(config);
    return {
      name,
      platform: options.platform ?? "deepseek",
      dataMode: "real",
      model: config.model,
      async answer(query) {
        let searchResults = [];
        let searchRaw = null;
        if (name === "deepseek-search") {
          const searchBody = await requestJson(`${config.baseUrl}/v1/tools/search`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ query: query.text, count: 5, need_content: true }),
          }, config.timeoutMs);
          searchRaw = searchBody;
          searchResults = normalizeSearchResults(searchBody);
        }

        const context = searchResults.length
          ? `\n\n搜索结果：\n${searchResults.map((item, index) =>
              `${index + 1}. ${item.title}\nURL: ${item.url}\n摘要: ${item.content.slice(0, 1800)}`).join("\n\n")}`
          : "";
        const callChat = (maxTokens) => requestJson(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              {
                role: "system",
                content: "你是独立消费者问题回答助手。事实不清楚时必须说明，不得编造。最终答案直接输出给用户。",
              },
              { role: "user", content: `${chatPrompt(query)}${context}` },
            ],
            temperature: 0.2,
            max_tokens: maxTokens,
            stream: false,
          }),
        }, config.timeoutMs);
        let body = await callChat(2200);
        let answer = String(body?.choices?.[0]?.message?.content ?? "").trim();
        if (!answer) {
          body = await callChat(3200);
          answer = String(body?.choices?.[0]?.message?.content ?? "").trim();
        }
        if (!answer) {
          const finishReason = body?.choices?.[0]?.finish_reason ?? "unknown";
          const reasoningLength = String(body?.choices?.[0]?.message?.reasoning_content ?? "").length;
          throw new Error(`DeepSeek 返回了空答案（finish_reason=${finishReason}, reasoning_chars=${reasoningLength}）`);
        }
        return {
          answer,
          raw: {
            completion: body,
            search: searchRaw,
            searchResults,
          },
          model: String(body?.model ?? config.model),
          citations: searchResults.map(({ title, url }) => ({ title, url, kind: "provider-search" })),
        };
      },
    };
  }

  throw new Error(`未知 provider：${name}`);
}
