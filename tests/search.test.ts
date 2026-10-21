import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWeb, type SearchEnv } from "../src/search";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web search", () => {
  it("returns Exa source excerpts for the model without generating an answer", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        requestId: "exa-request-1",
        results: Array.from({ length: 7 }, (_, index) => ({
          title: `Source ${index + 1}`,
          url: `https://example.com/${index + 1}`,
          highlights: [`Relevant passage ${index + 1}`],
          publishedDate: "2026-10-20T12:00:00Z"
        })),
        notices: [{ message: "A source filter was relaxed." }],
        costDollars: { total: 0.007 }
      })
    );

    vi.stubGlobal("fetch", fetchMock);

    const output = await searchWeb(
      { EXA_API_KEY: "test-key" } as SearchEnv,
      "Cloudflare Workers release",
      ["developers.cloudflare.com"]
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init?.headers).toMatchObject({ "x-api-key": "test-key" });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "Cloudflare Workers release",
      type: "auto",
      numResults: 6,
      contents: { highlights: true },
      includeDomains: ["developers.cloudflare.com"]
    });
    expect(output.results).toHaveLength(6);
    expect(output.results[0]).toEqual({
      title: "Source 1",
      url: "https://example.com/1",
      highlights: ["Relevant passage 1"],
      published_at_utc: "2026-10-20T12:00:00.000Z"
    });
    expect(output.notices).toEqual(["A source filter was relaxed."]);
    expect(output).not.toHaveProperty("answer");
    expect(output.retrieved_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("reports a missing Exa key without calling search", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const output = await searchWeb({} as SearchEnv, "example");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      query: "example",
      results: [],
      error: "EXA_API_KEY is not configured."
    });
  });
});
