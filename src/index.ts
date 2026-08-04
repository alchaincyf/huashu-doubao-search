#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// 豆包搜索开放了两个版本，同一个 API Key 都能调，免费额度共用，接口地址和参数格式不同
type Version = "global" | "custom";

const ENDPOINTS: Record<Version, string> = {
  global: "https://open.feedcoopapi.com/search_api/global_search",
  custom: "https://open.feedcoopapi.com/search_api/web_search",
};

const DEFAULT_VERSION: Version = "global";

// 两版差异（2026-07 实测）。setup 向导、版本工具、首次调用提示共用这一份，避免说法漂移
const VERSION_GUIDE = `豆包搜索有两个版本，同一个 API Key 都能调，每月 500 次免费额度两版共用：

【global】默认。独有每条结果的 token 计数（ContentTokenCount）——agent 算上下文预算要用的就是它，
  本 MCP 的 token 预算压缩（max_tokens）依赖这个字段。返回条数服务端固定 10 条，由客户端截断。
  计费只支持按量后付费，不支持包月套餐。

【custom】正文明显更全（实测中文热点均长 3702 字 vs global 1106 字），响应更快（同链路中位耗时低约四成），
  每条带信源权威度四级标注，可用 auth_level 只要「非常权威」的结果（政府/央媒/高校/头部企业官网等）。
  count 参数真实生效。支持包月套餐。但不返回 token 计数，因此 max_tokens 压缩在这版上不可用。

怎么选：默认 global 就行，它保住了 token 预算能力；
做需要严格控信源的调研（政策、医疗、财报这类），或者想让正文给得更全、想买包月，就切 custom。`;

interface Doc {
  rank: number;
  title: string;
  url: string;
  host: string;
  publishTime: string;
  text: string;
  images: string[];
  tokenCount?: number; // global 独有
  authDesc?: string; // custom 独有
}

interface SearchParams {
  query: string;
  count: number;
  snippet_length: number;
  images: number;
  version: Version;
  auth_level?: number;
}

// AI 增强层（可选）：配置 ARK_API_KEY 后解锁，不配则是纯搜索，行为与 0.1.x 完全一致
const ARK_API_KEY = process.env.ARK_API_KEY;
const ARK_BASE_URL = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
const ARK_MODEL = process.env.ARK_MODEL ?? "doubao-seed-2-0-lite-260215";

const ENV_VERSION = (process.env.DOUBAO_SEARCH_VERSION ?? "").trim().toLowerCase();
const VERSION_CONFIGURED = ENV_VERSION === "global" || ENV_VERSION === "custom";

function resolveVersion(explicit?: string): Version {
  if (explicit === "global" || explicit === "custom") return explicit;
  return VERSION_CONFIGURED ? (ENV_VERSION as Version) : DEFAULT_VERSION;
}

// 没显式配过版本时，第一次搜索完附一次两版说明——stdio 下没法在启动时问用户，
// 就把这个「问」挪到首次结果里，让 agent 转述给用户，之后不再打扰
let versionNoticeShown = VERSION_CONFIGURED;

function formatDoc(doc: Doc): string {
  const lines: string[] = [];
  // token 数（global 独有）摊给 agent，它才能自己算这条值不值得留在上下文里
  const meta = [
    doc.host,
    doc.publishTime,
    doc.authDesc,
    doc.tokenCount ? `${doc.tokenCount} tokens` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  lines.push(`[${doc.rank + 1}] ${doc.title}`);
  if (meta) lines.push(`来源: ${meta}`);
  lines.push(`URL: ${doc.url}`);
  if (doc.text) lines.push(doc.text);
  for (const img of doc.images) lines.push(`图片: ${img}`);
  return lines.join("\n");
}

function apiKeyOrThrow(): string {
  const apiKey = process.env.DOUBAO_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DOUBAO_SEARCH_API_KEY is not set. " +
        "Get a key at https://console.volcengine.com/search-infinity/web-search-exp (500 free searches/month), " +
        "then set it in the MCP server env."
    );
  }
  return apiKey;
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Doubao Search API error (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const err = data?.ResponseMetadata?.Error;
  if (err) throw new Error(`Doubao Search API error: ${err.Message ?? JSON.stringify(err).slice(0, 300)}`);
  return data;
}

async function searchGlobal(p: SearchParams, apiKey: string): Promise<Doc[]> {
  const data = await postJson(ENDPOINTS.global, apiKey, {
    query: p.query,
    doc_count: p.count,
    max_snippet_length: p.snippet_length,
    max_image_count_per_doc: p.images,
  });
  const docs = (data?.Result?.Documents ?? []) as any[];
  // 服务端目前忽略 doc_count 固定返回 10 条（2026-07 实测 3/15/20/不传均返 10），
  // 在客户端截断兑现 count 语义；doc_count 仍随请求发送，服务端实现后自动生效
  return docs.slice(0, p.count).map((d, i) => {
    const texts: string[] = [];
    const images: string[] = [];
    for (const part of d.Snippet ?? []) {
      if (part.Type === "text" && part.Text) texts.push(String(part.Text).trim());
      if (part.Type === "image" && part.Image?.ImageUrl) images.push(part.Image.ImageUrl);
    }
    return {
      rank: i,
      title: d.Title ?? "",
      url: d.Url ?? "",
      host: d.HostInfo?.Hostname ?? "",
      publishTime: d.DocumentInfo?.PublishTime ?? "",
      text: texts.join("\n"),
      images,
      tokenCount: d.DocumentInfo?.ContentTokenCount,
    };
  });
}

async function searchCustom(p: SearchParams, apiKey: string): Promise<Doc[]> {
  const body: Record<string, unknown> = {
    Query: p.query,
    SearchType: "web",
    Count: p.count, // 这版 Count 真实生效，不用客户端截断
  };
  // AuthInfoLevel 只收单个整数（2026-07 实测传数组报 Invalid Parameter）
  if (p.auth_level !== undefined) body.Filter = { AuthInfoLevel: p.auth_level };
  const data = await postJson(ENDPOINTS.custom, apiKey, body);
  const results = (data?.Result?.WebResults ?? []) as any[];
  return results.map((r, i) => {
    // 这版正文（Content）比 global 长得多，服务端没有可用的截断参数（MaxSnippetLength 实测不生效），
    // 在客户端按 snippet_length 截断，兑现和 global 一致的参数语义
    const full = String(r.Content || r.Summary || r.Snippet || "").trim();
    const text = full.length > p.snippet_length ? full.slice(0, p.snippet_length) + "…" : full;
    return {
      rank: i,
      title: r.Title ?? "",
      url: r.Url ?? "",
      host: r.SiteName ?? "",
      publishTime: r.PublishTime ?? "",
      text,
      images: [],
      authDesc: r.AuthInfoDes ?? undefined,
    };
  });
}

async function searchDoubao(p: SearchParams): Promise<Doc[]> {
  const apiKey = apiKeyOrThrow();
  return p.version === "custom" ? searchCustom(p, apiKey) : searchGlobal(p, apiKey);
}

async function callArk(
  system: string,
  user: string,
  maxTokens: number
): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(`${ARK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ARK_API_KEY}`,
    },
    body: JSON.stringify({
      model: ARK_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ark API error (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error("Ark API returned empty content");
  return { text, truncated: choice?.finish_reason === "length" };
}

// PublishTime 见过两种格式："2026-07-10 20:00:00" 和 ISO 带时区；无时间戳的结果保留不过滤
function filterByAge(docs: Doc[], maxAgeDays: number): { kept: Doc[]; dropped: number } {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const kept: Doc[] = [];
  let dropped = 0;
  for (const doc of docs) {
    const raw = doc.publishTime?.trim();
    if (raw) {
      const t = new Date(raw.includes("T") ? raw : raw.replace(" ", "T")).getTime();
      if (!Number.isNaN(t) && t < cutoff) {
        dropped++;
        continue;
      }
    }
    kept.push(doc);
  }
  return { kept, dropped };
}

const COMPRESS_SYSTEM = `你是搜索结果压缩器。只做筛选和压缩，不做推断、不下结论、不添加搜索结果之外的任何信息。
规则：
1. 剔除与查询无关或高度重复的结果，其余全部保留；
2. 保留的每条结果必须带：来源名、发布时间、URL；关键事实句尽量用原文，含图片URL的也保留；
3. 各结果之间用 --- 分隔，保持编号，按相关性从高到低排列；
4. 输出总长度必须明显短于用户给出的 token 预算：预算不够时直接整条舍弃排在后面的结果，绝不写半条、绝不写到被截断，优先压缩正文、绝不牺牲来源信息。`;

// —— setup：stdio 协议下 MCP server 启动时无法交互，把「问用户选哪版」放在这个子命令里 ——
if (process.argv[2] === "setup") {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nhuashu-doubao-search · 版本选择\n");
  console.log(VERSION_GUIDE);
  const answer = (await rl.question(`\n用哪个版本？[global] / custom ：`)).trim().toLowerCase();
  rl.close();
  const picked: Version = answer === "custom" ? "custom" : "global";
  console.log(`\n已选择 ${picked}。把这行加到 MCP 配置的 env 里：\n`);
  console.log(`  DOUBAO_SEARCH_VERSION=${picked}\n`);
  console.log(`Claude Code 用户可以直接跑：\n`);
  console.log(
    `  claude mcp add huashu-doubao-search -e DOUBAO_SEARCH_API_KEY=<你的key> -e DOUBAO_SEARCH_VERSION=${picked} -- npx -y github:alchaincyf/huashu-doubao-search\n`
  );
  console.log(`不配这个变量也能用，默认走 global。装好后随时可以在单次搜索里用 version 参数临时切换。\n`);
  process.exit(0);
}

const server = new McpServer({
  name: "huashu-doubao-search",
  version: "0.3.0",
});

const versionParam = z
  .enum(["global", "custom"])
  .optional()
  .describe(
    "Which Doubao Search version to use for THIS call, overriding the configured default. " +
      "global: has per-result token counts (needed by max_tokens compression), fixed 10 results server-side. " +
      "custom: much longer article text, faster, per-result source authority rating (see auth_level), " +
      "count honored server-side, but NO token counts. Call doubao_search_versions for the full comparison."
  );

const searchInputSchema: Record<string, z.ZodTypeAny> = {
  query: z.string().describe("Search query, Chinese or English. Natural language works well."),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Number of results to return (1-20, default 10)"),
  snippet_length: z
    .number()
    .int()
    .min(50)
    .max(2000)
    .default(600)
    .describe("Max characters per result snippet (default 600; raise for deep reading)"),
  images: z
    .number()
    .int()
    .min(0)
    .max(3)
    .default(0)
    .describe("Max images per result, returned as CDN URLs (default 0; global version only)"),
  max_age_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "Freshness filter: drop results published more than N days ago (results without a timestamp are kept). " +
        "Use ONLY for time-sensitive intent (latest news, scores, prices, releases). Omit for background research, " +
        "historical analysis, or entity/concept lookups — older authoritative sources are valuable there, and every " +
        "result carries its own publish timestamp for you to judge freshness yourself."
    ),
  version: versionParam,
  auth_level: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Custom version only: keep only results at this source-authority level. " +
        "1 = highly authoritative (government, state media, universities, major company official sites), " +
        "2 = normal (quality industry sites, portals), 3 = ordinary, 4 = low quality. " +
        "Use 1 for policy/medical/financial claims where source quality matters. Ignored on the global version."
    ),
};

if (ARK_API_KEY) {
  searchInputSchema.max_tokens = z
    .number()
    .int()
    .min(200)
    .max(8000)
    .optional()
    .describe(
      "Context budget: AI-compress results to fit within ~N tokens (filter + compress only, sources/URLs/timestamps preserved, no conclusions added). Costs one cheap LLM call. Omit for raw results."
    );
}

server.registerTool(
  "doubao_search_versions",
  {
    title: "豆包搜索·版本说明",
    description:
      "Explain the two Doubao Search versions (global / custom) and how to choose. " +
      "Call this when the user asks which version to use, why results differ between versions, " +
      "or before switching versions for a task with specific needs (source authority, longer article text, token budgeting).",
    inputSchema: {},
  },
  async () => {
    const current = resolveVersion();
    const state = VERSION_CONFIGURED
      ? `当前配置：${current}（来自环境变量 DOUBAO_SEARCH_VERSION）`
      : `当前：${current}（默认值，没有配置 DOUBAO_SEARCH_VERSION）`;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${VERSION_GUIDE}\n\n${state}\n\n` +
            `切换方式：单次搜索传 version 参数即可临时切换；` +
            `想固定下来就在 MCP 配置的 env 里设 DOUBAO_SEARCH_VERSION=global 或 custom，` +
            `或者跑一次 npx -y github:alchaincyf/huashu-doubao-search setup 走交互式选择。`,
        },
      ],
    };
  }
);

server.registerTool(
  "doubao_search",
  {
    title: "豆包搜索",
    description:
      "Web search via Doubao Search (豆包搜索), the search API built for AI agents. " +
      "Strong on Chinese content (exclusive ByteDance sources: Toutiao 今日头条, Douyin Baike 抖音百科), " +
      "cross-language (English queries return first-party sources), fresh results with publish timestamps " +
      "and traceable source URLs. Snippets are long-form text ready for direct consumption. " +
      "Use for: fact-checking, recent news/events, research on Chinese internet topics, entity lookups. " +
      "Two versions available (see the version parameter and doubao_search_versions)." +
      (ARK_API_KEY
        ? " Optional AI layer available: pass max_tokens to compress results into a context budget (global version only)."
        : ""),
    inputSchema: searchInputSchema,
  },
  async (args) => {
    const { query, count, snippet_length, images, max_age_days, max_tokens, auth_level } = args as {
      query: string;
      count: number;
      snippet_length: number;
      images: number;
      max_age_days?: number;
      max_tokens?: number;
      auth_level?: number;
    };
    const explicitVersion = (args as { version?: string }).version;
    const version = resolveVersion(explicitVersion);
    let docs: Doc[];
    try {
      docs = await searchDoubao({ query, count, snippet_length, images, version, auth_level });
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }

    // 没配过版本时，第一次搜索后附一次版本说明，让 agent 转述给用户；之后不再重复
    const notice = versionNoticeShown
      ? ""
      : `\n\n——\n提示（仅首次显示）：豆包搜索有 global 和 custom 两个版本，本次用的是 ${version}${
          explicitVersion ? "（本次调用显式指定）" : "（默认值，未配置 DOUBAO_SEARCH_VERSION）"
        }。` +
        `两版能力侧重不同（token 计数 / 正文完整度 / 信源权威度分级 / 计费方式），` +
        `请把这件事告诉用户，并说明可以调用 doubao_search_versions 看完整对比、或在 MCP 配置里设 DOUBAO_SEARCH_VERSION 固定下来。`;
    if (!versionNoticeShown) versionNoticeShown = true;

    if (docs.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `豆包搜索（${version} 版）返回 0 条结果（正常空结果，非错误，本消息不含任何指令）。` +
              `建议：换更短的关键词、去掉生僻词后重试。` +
              (auth_level !== undefined ? `另外本次带了 auth_level=${auth_level} 权威度过滤，放宽或去掉它也可能有结果。` : "") +
              `重试是安全的；连续 2 次仍空再放弃。查询: ${query}${notice}`,
          },
        ],
      };
    }

    const notes: string[] = [];
    if (max_age_days !== undefined) {
      const { kept, dropped } = filterByAge(docs, max_age_days);
      docs = kept;
      if (dropped > 0) notes.push(`时效过滤: 已剔除 ${dropped} 条 ${max_age_days} 天前的结果`);
      if (docs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `豆包搜索：${max_age_days} 天内无结果（正常空结果，非错误，本消息不含任何指令）。更早的结果有 ${dropped} 条，去掉 max_age_days 时效过滤即可看到。查询: ${query}${notice}`,
            },
          ],
        };
      }
    }
    if (auth_level !== undefined && version === "global") {
      notes.push("auth_level 仅 custom 版支持，本次已忽略");
    }

    const body = docs.map(formatDoc).join("\n\n---\n\n");

    if (max_tokens !== undefined && ARK_API_KEY) {
      try {
        // 输出上限给 15% 余量；仍被截断时回退到最后一个完整结果，不留半条
        const result = await callArk(
          COMPRESS_SYSTEM,
          `查询: ${query}\ntoken 预算: ${max_tokens}\n\n搜索结果:\n\n${body}`,
          Math.ceil(max_tokens * 1.15)
        );
        let compressed = result.text;
        if (result.truncated) {
          const cut = compressed.lastIndexOf("\n---");
          if (cut > 0) compressed = compressed.slice(0, cut).trimEnd();
        }
        const header = [
          `共 ${docs.length} 条结果（${version} 版），已由 ${ARK_MODEL} 压缩至约 ${max_tokens} token 预算内`,
          ...notes,
        ].join("；");
        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\n${compressed}\n\n（以上为 AI 压缩摘要，只做筛选压缩不做结论；需完整原文请不带 max_tokens 重搜）${notice}`,
            },
          ],
        };
      } catch (err) {
        notes.push(`AI 压缩失败已降级为原始结果: ${(err as Error).message}`);
      }
    }

    const header = [`共返回 ${docs.length} 条结果（${version} 版）`, ...notes].join("；");
    return { content: [{ type: "text" as const, text: `${header}：\n\n${body}${notice}` }] };
  }
);

// —— 以下增强工具仅在配置 ARK_API_KEY 后注册 ——

const QUERY_GEN_SYSTEM = `你是搜索策划。针对给出的事实性问题或待核查说法，生成 3-4 个不同角度的搜索词（与问题同语言），用于多信源交叉核查。角度参考：事实本身、最新进展、官方口径或权威信源、质疑或相反说法。只输出 JSON 字符串数组，不要输出任何其他内容。`;

const CROSS_CHECK_SYSTEM = `你是信源交叉核查员。基于提供的多路搜索结果（每条带来源名、发布时间、URL），核查用户的问题或说法。
硬规则：只使用提供的搜索结果，不引入任何外部知识；每条结论标注支持它的信源；信源不足以判断时明确写"现有信源无法确认"。
输出 Markdown，结构如下：
## 核查结论
（一两句话：当前信源能支持什么、不能支持什么）
## 信源共识
（各信源一致的事实，每条末尾标注 [信源: 名称1, 名称2]）
## 信源分歧
（信源间冲突的细节，逐条列出各方说法+来源名+发布时间；没有则写"未发现明显分歧"）
## 信源清单
（来源名 | 发布时间 | URL，一行一条）
## 时效提示
（信息截至最新一条结果的发布时间；提示无法排除后续反转或辟谣）`;

function parseQueryArray(text: string, fallback: string): string[] {
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("no array");
    const arr = JSON.parse(text.slice(start, end + 1));
    const queries = (arr as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 0);
    if (queries.length === 0) throw new Error("empty array");
    return queries.slice(0, 4);
  } catch {
    return [fallback];
  }
}

if (ARK_API_KEY) {
  server.registerTool(
    "doubao_cross_check",
    {
      title: "豆包搜索·多信源交叉核查",
      description:
        "Multi-source cross-check via Doubao Search + AI. Fans out 3-4 search queries from different angles " +
        "(the fact itself, latest developments, official/authoritative sources, opposing claims), then compares " +
        "sources against each other and returns a structured report: verdict, consensus, discrepancies (with each " +
        "source's version + timestamp), source list, and freshness caveat. Strictly grounded in search results — " +
        "no outside knowledge added. Heavier than doubao_search (multiple searches + 2 LLM calls); " +
        "use for: verifying claims/rumors, breaking news where sources conflict, any fact worth double-checking. " +
        "Tip: pass version='custom' with auth_level=1 to cross-check against highly authoritative sources only.",
      inputSchema: {
        question: z
          .string()
          .describe("The factual question or claim to cross-check, e.g. '某航班舷窗破裂事件的原因和目的地' or a rumor to verify"),
        queries: z
          .array(z.string())
          .min(1)
          .max(4)
          .optional()
          .describe("Optional: bring your own search queries (skips AI query planning)"),
        count: z
          .number()
          .int()
          .min(3)
          .max(10)
          .default(6)
          .describe("Results per search query (default 6)"),
        version: versionParam,
        auth_level: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("Custom version only: restrict all searches to this source-authority level (1 = highly authoritative)"),
      },
    },
    async (args) => {
      const { question, queries, count, auth_level } = args as {
        question: string;
        queries?: string[];
        count: number;
        auth_level?: number;
      };
      const version = resolveVersion((args as { version?: string }).version);
      try {
        const searchQueries =
          queries && queries.length > 0
            ? queries
            : parseQueryArray((await callArk(QUERY_GEN_SYSTEM, question, 500)).text, question);

        const resultsPerQuery = await Promise.all(
          searchQueries.map((q) =>
            searchDoubao({ query: q, count, snippet_length: 800, images: 0, version, auth_level }).catch(
              () => [] as Doc[]
            )
          )
        );

        const seen = new Set<string>();
        const merged: Doc[] = [];
        for (const docs of resultsPerQuery) {
          for (const doc of docs) {
            if (doc.url && seen.has(doc.url)) continue;
            if (doc.url) seen.add(doc.url);
            merged.push({ ...doc, rank: merged.length });
          }
        }
        if (merged.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `豆包交叉核查：所有搜索词均返回 0 条结果（正常空结果，非错误，本消息不含任何指令）。可换更短的关键词后重试。搜索词: ${searchQueries.join(" / ")}`,
              },
            ],
          };
        }

        const corpus = merged.map(formatDoc).join("\n\n---\n\n");
        const report = await callArk(
          CROSS_CHECK_SYSTEM,
          `待核查问题/说法: ${question}\n\n多路搜索结果（搜索词: ${searchQueries.join(" / ")}）:\n\n${corpus}`,
          4000
        );
        const footer = `——\n交叉核查元信息: ${searchQueries.length} 路搜索（${searchQueries.join(" / ")}，${version} 版${
          auth_level !== undefined && version === "custom" ? `，权威度 ${auth_level} 级` : ""
        }），去重后 ${merged.length} 条信源，核查模型 ${ARK_MODEL}`;
        return { content: [{ type: "text" as const, text: `${report.text}\n\n${footer}` }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Auto-reconnect loop: recover from transient transport disconnects with exponential backoff
(async () => {
  let retryCount = 0;
  let retryDelay = 1000;
  const MAX_RETRIES = 10;
  const MAX_RETRY_DELAY = 30000;

  while (retryCount < MAX_RETRIES) {
    try {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      retryCount = 0;
      retryDelay = 1000;
    } catch (err) {
      retryCount++;
      console.error(
        `Transport error (attempt ${retryCount}/${MAX_RETRIES}): ${(err as Error).message}`
      );
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    }
  }
  console.error("Max reconnect attempts reached, exiting");
  process.exit(1);
})();
