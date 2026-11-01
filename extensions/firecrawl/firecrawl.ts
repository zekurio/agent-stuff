/**
 * Firecrawl v2 client for the web tools.
 *
 * It calls the REST API with fetch instead of the firecrawl SDK. The
 * extension then has no runtime dependencies, and Pi's Bun runtime never
 * meets the SDK's axios error handling, which needed patching under Bun.
 */

export const HOSTED_URL = "https://api.firecrawl.dev";

export interface FirecrawlConfig {
  /** The hosted API unless FIRECRAWL_URL names another endpoint. */
  baseUrl: string;
  /** Only a self-hosted instance without authentication may omit it. */
  apiKey: string | undefined;
}

export type ConfigResult =
  | { ok: true; config: FirecrawlConfig }
  | { ok: false; reason: string };

export function readConfig(
  env: Record<string, string | undefined>,
): ConfigResult {
  const apiKey = env.FIRECRAWL_API_KEY?.trim() || undefined;
  const customUrl = env.FIRECRAWL_URL?.trim() || undefined;
  if (customUrl && !isHttpUrl(customUrl)) {
    return {
      ok: false,
      reason: `FIRECRAWL_URL must be an http(s) URL, got "${customUrl}"`,
    };
  }
  if (!apiKey && !customUrl) {
    return { ok: false, reason: "FIRECRAWL_API_KEY is not set" };
  }
  return { ok: true, config: { baseUrl: customUrl ?? HOSTED_URL, apiKey } };
}

export type Fetch = typeof fetch;

export const RECENCY = ["hour", "day", "week", "month", "year"] as const;
export type Recency = (typeof RECENCY)[number];

const RECENCY_TBS: Record<Recency, string> = {
  hour: "qdr:h",
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

export interface SearchParams {
  query: string;
  limit?: number | undefined;
  includeDomains?: string[] | undefined;
  excludeDomains?: string[] | undefined;
  recency?: Recency | undefined;
}

export interface SearchHit {
  title?: string;
  url: string;
  description?: string;
}

export interface SearchResult {
  results: SearchHit[];
  warning?: string;
  creditsUsed?: number;
}

interface SearchResponse {
  success?: boolean;
  data?: {
    web?: { title?: unknown; description?: unknown; url?: unknown }[];
  };
  warning?: unknown;
  creditsUsed?: unknown;
}

/** Keeps a search result to a snippet even if Firecrawl sends more. */
const SNIPPET_CHARS = 300;

export async function search(
  config: FirecrawlConfig,
  params: SearchParams,
  signal?: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<SearchResult> {
  const includeDomains = hostnames(params.includeDomains);
  const excludeDomains = hostnames(params.excludeDomains);
  if (includeDomains && excludeDomains) {
    throw new Error("includeDomains and excludeDomains cannot be combined");
  }

  const response = await post<SearchResponse>(
    config,
    "/v2/search",
    {
      query: params.query,
      limit: params.limit ?? 5,
      sources: [{ type: "web" }],
      // Drops URLs that Firecrawl itself could not scrape afterwards.
      ignoreInvalidURLs: true,
      // Highlights replace the snippet with the top of the page, often
      // over a thousand characters that ignore the query.
      highlights: false,
      timeout: 30_000,
      ...(includeDomains ? { includeDomains } : {}),
      ...(excludeDomains ? { excludeDomains } : {}),
      ...(params.recency ? { tbs: RECENCY_TBS[params.recency] } : {}),
    },
    { operation: "search", timeoutMs: 40_000, signal, fetchImpl },
  );

  const results: SearchHit[] = [];
  for (const hit of response.data?.web ?? []) {
    if (typeof hit.url !== "string") continue;
    const title = text(hit.title);
    const description = clip(text(hit.description), SNIPPET_CHARS);
    results.push({
      ...(title ? { title } : {}),
      url: hit.url,
      ...(description ? { description } : {}),
    });
  }
  const warning = text(response.warning);
  return {
    results,
    ...(warning ? { warning } : {}),
    ...(typeof response.creditsUsed === "number"
      ? { creditsUsed: response.creditsUsed }
      : {}),
  };
}

export interface ScrapeParams {
  url: string;
  onlyMainContent?: boolean | undefined;
  /** Skip Firecrawl's cache, which serves copies up to two days old. */
  fresh?: boolean | undefined;
}

export interface ScrapedPage {
  /** Final URL after redirects. */
  url: string;
  statusCode?: number;
  title?: string;
  description?: string;
  markdown: string;
  warning?: string;
  creditsUsed?: number;
}

interface ScrapeResponse {
  success?: boolean;
  data?: {
    markdown?: unknown;
    warning?: unknown;
    metadata?: {
      title?: unknown;
      description?: unknown;
      url?: unknown;
      statusCode?: unknown;
      creditsUsed?: unknown;
    };
  };
  warning?: unknown;
  creditsUsed?: unknown;
}

export async function scrape(
  config: FirecrawlConfig,
  params: ScrapeParams,
  signal?: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<ScrapedPage> {
  const url = httpUrl(params.url);
  const response = await post<ScrapeResponse>(
    config,
    "/v2/scrape",
    {
      url,
      formats: [{ type: "markdown" }],
      onlyMainContent: params.onlyMainContent ?? true,
      // Below the client timeout, so Firecrawl answers with its own error
      // for a slow page before the request is cut off.
      timeout: 45_000,
      ...(params.fresh ? { maxAge: 0 } : {}),
    },
    { operation: "scrape", timeoutMs: 60_000, signal, fetchImpl },
  );

  const data = response.data;
  const metadata = data?.metadata;
  const finalUrl =
    typeof metadata?.url === "string" && isHttpUrl(metadata.url)
      ? metadata.url
      : url;
  const title = text(metadata?.title)?.slice(0, 300);
  const description = text(metadata?.description)?.slice(0, 300);
  const warning = text(data?.warning) ?? text(response.warning);
  const creditsUsed = response.creditsUsed ?? metadata?.creditsUsed;
  return {
    url: finalUrl,
    ...(typeof metadata?.statusCode === "number"
      ? { statusCode: metadata.statusCode }
      : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    markdown: typeof data?.markdown === "string" ? data.markdown : "",
    ...(warning ? { warning: warning.slice(0, 300) } : {}),
    ...(typeof creditsUsed === "number" ? { creditsUsed } : {}),
  };
}

export interface PageRequest {
  query?: string | undefined;
  offset?: number | undefined;
  limit: number;
}

export interface PageWindow {
  totalChars: number;
  /** Characters available to page through: the passages when query is set. */
  selectedChars: number;
  query?: string;
  matches?: number;
  offset: number;
  end: number;
  text: string;
  nextOffset?: number;
}

/** Characters kept on each side of a query match. */
const PASSAGE_CONTEXT = 400;
/** How far a passage edge may move to land on a line break. */
const LINE_SNAP = 200;

/**
 * Picks one bounded window of a page. With a query, the window runs over
 * the passages around case-insensitive literal matches instead of the
 * whole page.
 */
export function selectPage(markdown: string, request: PageRequest): PageWindow {
  const query = request.query?.trim();
  if (request.query !== undefined && !query) {
    throw new Error("query must contain text");
  }

  let selected = markdown;
  let matches: number | undefined;
  if (query) {
    const passages: { start: number; end: number }[] = [];
    matches = 0;
    const pattern = new RegExp(escapeRegExp(query), "giu");
    for (const match of markdown.matchAll(pattern)) {
      matches += 1;
      const start = lineStart(markdown, match.index - PASSAGE_CONTEXT);
      const end = lineEnd(
        markdown,
        match.index + match[0].length + PASSAGE_CONTEXT,
      );
      const previous = passages.at(-1);
      if (previous && start <= previous.end) previous.end = end;
      else passages.push({ start, end });
    }
    selected = passages
      .map((passage) => markdown.slice(passage.start, passage.end))
      .join("\n\n[...]\n\n");
  }

  const offset = boundary(selected, request.offset ?? 0);
  let end = boundary(selected, offset + request.limit);
  // A one-character window on a surrogate pair would otherwise be empty.
  if (end === offset && offset < selected.length) end = offset + 2;

  return {
    totalChars: markdown.length,
    selectedChars: selected.length,
    ...(query ? { query, matches } : {}),
    offset,
    end,
    text: selected.slice(offset, end),
    ...(end < selected.length ? { nextOffset: end } : {}),
  };
}

/** Firecrawl scrapes only http(s) URLs. */
export function httpUrl(raw: string): string {
  if (!URL.canParse(raw)) throw new Error(`Invalid URL: "${raw}"`);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs can be read, got ${url.protocol}`);
  }
  return url.href;
}

interface PostOptions {
  operation: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  fetchImpl: Fetch;
}

/** One POST without retries, since a repeated call spends credits again. */
async function post<T>(
  config: FirecrawlConfig,
  path: string,
  body: unknown,
  options: PostOptions,
): Promise<T> {
  const { operation, timeoutMs } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  // Keeps any path prefix of a self-hosted base URL.
  const url = new URL(
    path.replace(/^\//, ""),
    config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`,
  );
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  let response: Response;
  let raw: string;
  try {
    response = await options.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    raw = await response.text();
  } catch (cause) {
    if (options.signal?.aborted) {
      throw new Error(`Firecrawl ${operation} was cancelled`, { cause });
    }
    if (timeout.aborted) {
      throw new Error(
        `Firecrawl ${operation} timed out after ${timeoutMs / 1000}s`,
        { cause },
      );
    }
    throw new Error(`Firecrawl ${operation} failed: ${errorMessage(cause)}`, {
      cause,
    });
  }

  const json = parseJson(raw);
  if (!response.ok || (isRecord(json) && json.success === false)) {
    const status = response.ok ? "" : `HTTP ${response.status}`;
    const code = isRecord(json) ? text(json.code) : undefined;
    const detail =
      (isRecord(json) && (text(json.error) ?? text(json.message))) ||
      raw.trim().slice(0, 300) ||
      "no details";
    const label = [status, code].filter(Boolean).join(" ");
    throw new Error(
      `Firecrawl ${operation} failed${label ? ` (${label})` : ""}: ${detail}`,
    );
  }
  if (!isRecord(json)) {
    throw new Error(`Firecrawl ${operation} returned a response that is not JSON`);
  }
  return json as T;
}

/** Firecrawl wants bare hostnames, but a model often passes full URLs. */
function hostnames(values: string[] | undefined): string[] | undefined {
  const hosts = (values ?? [])
    .map((value) => {
      const trimmed = value.trim();
      const host = URL.canParse(trimmed)
        ? new URL(trimmed).hostname
        : (trimmed.split("/")[0] ?? "");
      return host.toLowerCase();
    })
    .filter((host) => host !== "");
  return hosts.length > 0 ? [...new Set(hosts)] : undefined;
}

/** Moves a passage start back to the line it falls in, if that is close. */
function lineStart(value: string, index: number): number {
  const start = boundary(value, index);
  if (start === 0) return 0;
  const lineBreak = value.lastIndexOf("\n", start - 1);
  return lineBreak !== -1 && start - lineBreak <= LINE_SNAP ? lineBreak + 1 : start;
}

/** Moves a passage end forward to the end of its line, if that is close. */
function lineEnd(value: string, index: number): number {
  const end = boundary(value, index);
  if (end >= value.length) return value.length;
  const lineBreak = value.indexOf("\n", end);
  return lineBreak !== -1 && lineBreak - end <= LINE_SNAP ? lineBreak : end;
}

/** Moves an index off the low half of a surrogate pair and into range. */
function boundary(value: string, index: number): number {
  const clamped = Math.max(0, Math.min(index, value.length));
  const code = value.charCodeAt(clamped);
  return clamped > 0 && clamped < value.length && code >= 0xdc00 && code <= 0xdfff
    ? clamped - 1
    : clamped;
}

/** Metadata fields may repeat, such as several og:title tags. */
function text(value: unknown): string | undefined {
  const joined = Array.isArray(value)
    ? value.filter((item) => typeof item === "string").join("; ")
    : typeof value === "string"
      ? value
      : "";
  return joined.trim() || undefined;
}

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length <= max) return value;
  const cut = boundary(value, max - 3);
  // Ends on a word when one ends nearby.
  const space = value.lastIndexOf(" ", cut);
  const end = space > cut - 40 ? space : cut;
  return `${value.slice(0, end).trimEnd()}...`;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
