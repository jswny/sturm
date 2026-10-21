import { logError, logInfo, logWarn } from "./logging";
import { readResponseTextWithLimit } from "./http";

export type SearchEnv = Env & {
  EXA_API_KEY?: string;
  KAGI_API_KEY?: string;
};

export type SearchResult = {
  title: string;
  url: string;
  highlights: string[];
  published_at_utc?: string;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
  retrieved_at_utc: string;
  notices?: string[];
  error?: string;
};

export type UrlSummaryResponse = {
  url: string;
  summary?: string;
  error?: string;
};

type KagiSummaryResponse = {
  data?: {
    output?: string;
  };
};

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const KAGI_SUMMARIZE_URL = "https://kagi.com/api/v0/summarize";
const SEARCH_RESULT_COUNT = 6;
const SEARCH_HIGHLIGHT_MAX_CHARACTERS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

type ExaSearchResponse = {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    highlights?: unknown;
    publishedDate?: unknown;
  }>;
  requestId?: string;
  costDollars?: { total?: number };
  notices?: Array<{ message?: string }>;
};

function normalizePublishedDate(value: unknown) {
  if (typeof value !== "string") return undefined;

  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime())
    ? undefined
    : timestamp.toISOString();
}

function normalizeSearchResults(results: ExaSearchResponse["results"]) {
  let remainingCharacters = SEARCH_HIGHLIGHT_MAX_CHARACTERS;

  return (results ?? []).slice(0, SEARCH_RESULT_COUNT).flatMap((item) => {
    if (
      !item ||
      typeof item.title !== "string" ||
      typeof item.url !== "string"
    ) {
      return [];
    }

    const highlights: string[] = [];

    if (Array.isArray(item.highlights)) {
      for (const value of item.highlights) {
        if (typeof value !== "string") continue;

        const highlight = value.trim();

        if (!highlight || highlight.length > remainingCharacters) continue;

        highlights.push(highlight);
        remainingCharacters -= highlight.length;
      }
    }

    return [
      {
        title: item.title,
        url: item.url,
        highlights,
        published_at_utc: normalizePublishedDate(item.publishedDate)
      }
    ];
  });
}

export async function searchWeb(
  env: SearchEnv,
  query: string,
  domains?: string[]
): Promise<SearchResponse> {
  const retrieved_at_utc = new Date().toISOString();
  const apiKey = env.EXA_API_KEY?.trim();

  if (!apiKey) {
    logWarn("Exa search skipped because API key is not configured", {
      provider: "exa",
      endpoint: "search"
    });

    return {
      query,
      results: [],
      retrieved_at_utc,
      error: "EXA_API_KEY is not configured."
    };
  }

  let response: Response;

  try {
    response = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: SEARCH_RESULT_COUNT,
        contents: { highlights: true },
        ...(domains?.length ? { includeDomains: domains } : {})
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    logError("Exa search request failed", error, {
      provider: "exa",
      endpoint: "search"
    });

    return {
      query,
      results: [],
      retrieved_at_utc,
      error: "Exa search request failed."
    };
  }

  if (!response.ok) {
    logWarn("Exa search returned an error", {
      provider: "exa",
      endpoint: "search",
      status: response.status,
      statusText: response.statusText
    });

    return {
      query,
      results: [],
      retrieved_at_utc,
      error: `Exa search failed with ${response.status} ${response.statusText}.`
    };
  }

  let payload: ExaSearchResponse;

  try {
    payload = JSON.parse(
      await readResponseTextWithLimit(response, RESPONSE_MAX_BYTES)
    ) as ExaSearchResponse;
  } catch (error) {
    logError("Exa search returned invalid JSON", error, {
      provider: "exa",
      endpoint: "search"
    });

    return {
      query,
      results: [],
      retrieved_at_utc,
      error: "Exa search returned invalid JSON."
    };
  }

  if (!Array.isArray(payload?.results)) {
    logWarn("Exa search returned no results array", {
      provider: "exa",
      endpoint: "search",
      requestId: payload?.requestId
    });

    return {
      query,
      results: [],
      retrieved_at_utc,
      error: "Exa search returned an unexpected response."
    };
  }

  const results = normalizeSearchResults(payload.results);
  logInfo("Exa search completed", {
    provider: "exa",
    endpoint: "search",
    requestId: payload.requestId,
    resultCount: results.length,
    costDollars: payload.costDollars?.total
  });

  return {
    query,
    results,
    retrieved_at_utc,
    notices: Array.isArray(payload.notices)
      ? payload.notices.flatMap((notice) =>
          typeof notice?.message === "string" ? [notice.message] : []
        )
      : undefined
  };
}

export async function summarizeUrl(
  env: SearchEnv,
  url: string
): Promise<UrlSummaryResponse> {
  const apiKey = env.KAGI_API_KEY?.trim();

  if (!apiKey) {
    logWarn("Kagi summarize skipped because API key is not configured", {
      provider: "kagi",
      endpoint: "summarize"
    });

    return {
      url,
      error: "KAGI_API_KEY is not configured."
    };
  }

  let response: Response;

  try {
    response = await fetch(KAGI_SUMMARIZE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bot ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    logError("Kagi summarize request failed", error, {
      provider: "kagi",
      endpoint: "summarize"
    });

    return {
      url,
      error: "Kagi summarize request failed."
    };
  }

  if (!response.ok) {
    const body = await readResponseTextWithLimit(
      response,
      RESPONSE_MAX_BYTES
    ).catch(() => "");

    logWarn("Kagi summarize returned an error", {
      provider: "kagi",
      endpoint: "summarize",
      status: response.status,
      statusText: response.statusText,
      body: body.slice(0, 500)
    });

    return {
      url,
      error: `Kagi summarize failed with ${response.status} ${response.statusText}.`
    };
  }

  let payload: KagiSummaryResponse;

  try {
    payload = JSON.parse(
      await readResponseTextWithLimit(response, RESPONSE_MAX_BYTES)
    ) as KagiSummaryResponse;
  } catch (error) {
    logError("Kagi summarize returned invalid JSON", error, {
      provider: "kagi",
      endpoint: "summarize"
    });

    return {
      url,
      error: "Kagi summarize returned invalid JSON."
    };
  }

  return {
    url,
    summary: payload.data?.output
  };
}
