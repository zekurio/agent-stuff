import assert from "node:assert/strict";
import test from "node:test";
import {
  HOSTED_URL,
  readConfig,
  scrape,
  search,
  selectPage,
  type Fetch,
  type FirecrawlConfig,
} from "./firecrawl.ts";

const config: FirecrawlConfig = { baseUrl: HOSTED_URL, apiKey: "fc-test" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetchImpl: Fetch = async (input, init = {}) => {
    calls.push({
      url: String(input),
      init,
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  };
  return { calls, fetchImpl };
}

test("readConfig needs a key unless a self-hosted URL is set", () => {
  assert.deepEqual(readConfig({}), {
    ok: false,
    reason: "FIRECRAWL_API_KEY is not set",
  });
  assert.deepEqual(readConfig({ FIRECRAWL_API_KEY: " fc-1 " }), {
    ok: true,
    config: { baseUrl: HOSTED_URL, apiKey: "fc-1" },
  });
  assert.deepEqual(readConfig({ FIRECRAWL_URL: "http://localhost:3002" }), {
    ok: true,
    config: { baseUrl: "http://localhost:3002", apiKey: undefined },
  });
  assert.equal(readConfig({ FIRECRAWL_URL: "file:///tmp" }).ok, false);
});

test("search sends filters and returns titles, URLs, and snippets", async () => {
  const { calls, fetchImpl } = fakeFetch(200, {
    success: true,
    data: {
      web: [
        { title: "Docs", url: "https://docs.example.com/a", description: "A" },
        { title: "No URL" },
      ],
    },
    creditsUsed: 2,
  });

  const result = await search(
    config,
    {
      query: "example",
      includeDomains: ["https://Docs.Example.com/path", "github.com/foo"],
      recency: "week",
    },
    undefined,
    fetchImpl,
  );

  assert.equal(calls[0]?.url, "https://api.firecrawl.dev/v2/search");
  assert.equal(
    new Headers(calls[0]?.init.headers).get("authorization"),
    "Bearer fc-test",
  );
  assert.deepEqual(calls[0]?.body, {
    query: "example",
    limit: 5,
    sources: [{ type: "web" }],
    ignoreInvalidURLs: true,
    highlights: false,
    timeout: 30_000,
    includeDomains: ["docs.example.com", "github.com"],
    tbs: "qdr:w",
  });
  assert.deepEqual(result, {
    results: [
      { title: "Docs", url: "https://docs.example.com/a", description: "A" },
    ],
    creditsUsed: 2,
  });
});

test("search cuts long descriptions down to a snippet", async () => {
  const { fetchImpl } = fakeFetch(200, {
    success: true,
    data: { web: [{ url: "https://a.com", description: "word ".repeat(200) }] },
  });
  const result = await search(config, { query: "x" }, undefined, fetchImpl);
  const description = result.results[0]?.description ?? "";
  assert.ok(description.length <= 300);
  assert.ok(description.endsWith("word..."));
});

test("search rejects include and exclude domains together", async () => {
  const { calls, fetchImpl } = fakeFetch(200, {});
  await assert.rejects(
    search(
      config,
      { query: "x", includeDomains: ["a.com"], excludeDomains: ["b.com"] },
      undefined,
      fetchImpl,
    ),
    /cannot be combined/,
  );
  assert.equal(calls.length, 0);
});

test("a self-hosted base URL keeps its path prefix", async () => {
  const { calls, fetchImpl } = fakeFetch(200, { success: true, data: {} });
  await search(
    { baseUrl: "https://example.com/firecrawl", apiKey: undefined },
    { query: "x" },
    undefined,
    fetchImpl,
  );
  assert.equal(calls[0]?.url, "https://example.com/firecrawl/v2/search");
  assert.equal(new Headers(calls[0]?.init.headers).has("authorization"), false);
});

test("API errors carry the status, code, and Firecrawl's message", async () => {
  const { fetchImpl } = fakeFetch(402, {
    success: false,
    code: "insufficient_credits",
    error: "Payment required to access this resource.",
  });
  await assert.rejects(
    scrape(config, { url: "https://example.com" }, undefined, fetchImpl),
    {
      message:
        "Firecrawl scrape failed (HTTP 402 insufficient_credits): Payment required to access this resource.",
    },
  );
});

test("a non-JSON error body is reported as text", async () => {
  const { fetchImpl } = fakeFetch(502, "<html>Bad gateway</html>");
  await assert.rejects(
    search(config, { query: "x" }, undefined, fetchImpl),
    { message: "Firecrawl search failed (HTTP 502): <html>Bad gateway</html>" },
  );
});

test("cancelling the tool call aborts the request", async () => {
  const controller = new AbortController();
  const fetchImpl: Fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      );
    });
  const running = search(config, { query: "x" }, controller.signal, fetchImpl);
  controller.abort();
  await assert.rejects(running, { message: "Firecrawl search was cancelled" });
});

test("scrape returns the final URL and metadata", async () => {
  const { calls, fetchImpl } = fakeFetch(200, {
    success: true,
    data: {
      markdown: "# Hello",
      warning: "Slow page",
      metadata: {
        title: ["One", "Two"],
        url: "https://example.com/final",
        statusCode: 200,
        creditsUsed: 1,
      },
    },
  });

  const page = await scrape(
    config,
    { url: "https://example.com/start", fresh: true },
    undefined,
    fetchImpl,
  );

  assert.equal(calls[0]?.body.maxAge, 0);
  assert.equal(calls[0]?.body.onlyMainContent, true);
  assert.deepEqual(page, {
    url: "https://example.com/final",
    statusCode: 200,
    title: "One; Two",
    markdown: "# Hello",
    warning: "Slow page",
    creditsUsed: 1,
  });
});

test("scrape refuses non-http URLs before calling the API", async () => {
  const { calls, fetchImpl } = fakeFetch(200, {});
  await assert.rejects(
    scrape(config, { url: "file:///etc/passwd" }, undefined, fetchImpl),
    /Only http\(s\) URLs/,
  );
  assert.equal(calls.length, 0);
});

test("selectPage pages through the markdown", () => {
  const markdown = "a".repeat(25);
  const first = selectPage(markdown, { limit: 10 });
  assert.equal(first.text, "a".repeat(10));
  assert.equal(first.nextOffset, 10);

  const last = selectPage(markdown, { offset: 20, limit: 10 });
  assert.equal(last.text, "a".repeat(5));
  assert.equal(last.nextOffset, undefined);

  const past = selectPage(markdown, { offset: 99, limit: 10 });
  assert.equal(past.text, "");
  assert.equal(past.offset, 25);
});

test("selectPage keeps passages around literal matches", () => {
  const filler = "x".repeat(1_000);
  const markdown = `${filler}Needle one${filler}needle (two)${filler}`;
  const window = selectPage(markdown, { query: "NEEDLE", limit: 10_000 });
  assert.equal(window.matches, 2);
  assert.equal(window.text.split("\n\n[...]\n\n").length, 2);
  assert.ok(window.text.includes("Needle one"));
  assert.ok(window.selectedChars < markdown.length);

  // Regex characters in the query are literal.
  assert.equal(selectPage(markdown, { query: "(two)", limit: 100 }).matches, 1);
  assert.equal(selectPage(markdown, { query: "n.edle", limit: 100 }).matches, 0);
  assert.throws(() => selectPage(markdown, { query: "  ", limit: 100 }));
});

test("selectPage snaps passages to nearby line breaks", () => {
  const line = (label: string) => `${label} ${"x".repeat(150)}`;
  const lines = Array.from({ length: 20 }, (_, i) => line(`line${i}`));
  lines[10] = "the needle is here";
  const window = selectPage(lines.join("\n"), { query: "needle", limit: 10_000 });
  assert.ok(window.text.startsWith("line"), window.text.slice(0, 20));
  assert.ok(window.text.endsWith("x"));
  assert.ok(window.text.includes("the needle is here"));
});

test("selectPage never splits a surrogate pair", () => {
  const markdown = "ab😀cd";
  const window = selectPage(markdown, { limit: 3 });
  assert.equal(window.text, "ab");
  assert.equal(window.nextOffset, 2);

  const next = selectPage(markdown, { offset: 2, limit: 1 });
  assert.equal(next.text, "😀");
  assert.equal(next.nextOffset, 4);
});
