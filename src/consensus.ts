import { z } from "zod";
import { readResponseTextWithLimit } from "./http";
import { logError, logInfo, logWarn } from "./logging";

export const CONSENSUS_QUERY_MAX_LENGTH = 500;
export const CONSENSUS_RESULT_COUNT = 5;

export type ConsensusEnv = Partial<Pick<Env, "CONSENSUS_API_KEY">>;

const paperSchema = z.object({
  title: z.string(),
  url: z.url(),
  author: z.string().optional(),
  year: z.number().int().optional(),
  journal: z.string().optional(),
  takeaway: z.string().optional(),
  abstract: z.string().optional()
});

export const consensusSearchResponseSchema = z.object({
  ok: z.boolean(),
  query: z.string(),
  retrieved_at_utc: z.string(),
  results: z.array(paperSchema),
  notices: z.array(z.string()).optional(),
  retryAfterSeconds: z.number().optional(),
  error: z.string().optional()
});

export type ConsensusSearchResponse = z.infer<
  typeof consensusSearchResponseSchema
>;

const providerResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.url(),
      authors: z.array(z.string()).nullish(),
      publish_year: z.number().int().nullish(),
      journal_name: z.string().nullish(),
      takeaway: z.string().nullish(),
      abstract: z.string().nullish()
    })
  )
});

const CONSENSUS_SEARCH_URL = "https://api.consensus.app/v1/search";
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const EVIDENCE_MAX_CHARACTERS = 40_000;

export async function searchConsensus(
  env: ConsensusEnv,
  query: string
): Promise<ConsensusSearchResponse> {
  const retrieved_at_utc = new Date().toISOString();

  const failure = (error: string): ConsensusSearchResponse => ({
    ok: false,
    query,
    retrieved_at_utc,
    results: [],
    error
  });

  const apiKey = env.CONSENSUS_API_KEY?.trim();

  if (!apiKey) return failure("CONSENSUS_API_KEY is not configured.");

  const url = new URL(CONSENSUS_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("page", "0");
  url.searchParams.set("page_size", String(CONSENSUS_RESULT_COUNT));
  url.searchParams.set("exclude_preprints", "true");
  url.searchParams.set("include_full_text_chunks", "false");

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      logWarn("Consensus search returned an error", {
        provider: "consensus",
        endpoint: "search",
        status: response.status
      });
      await response.body?.cancel();

      return {
        ...failure(describeSearchError(response.status)),
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"))
      };
    }

    const payload = providerResponseSchema.safeParse(
      JSON.parse(await readResponseTextWithLimit(response, RESPONSE_MAX_BYTES))
    );

    if (!payload.success) {
      logWarn("Consensus search returned an unexpected response", {
        provider: "consensus",
        endpoint: "search"
      });

      return failure("Consensus search returned an unexpected response.");
    }

    let remainingCharacters = EVIDENCE_MAX_CHARACTERS;
    let evidenceTruncated = false;

    const boundEvidence = (text: string | null | undefined) => {
      if (!text) return undefined;

      const excerpt = text.slice(0, remainingCharacters);
      remainingCharacters -= excerpt.length;

      if (excerpt.length < text.length) evidenceTruncated = true;

      return excerpt || undefined;
    };

    const results = payload.data.results
      .slice(0, CONSENSUS_RESULT_COUNT)
      .map((paper) => ({
        title: paper.title,
        url: paper.url,
        author: paper.authors?.[0],
        year: paper.publish_year ?? undefined,
        journal: paper.journal_name ?? undefined,
        takeaway: boundEvidence(paper.takeaway),
        abstract: boundEvidence(paper.abstract)
      }));

    logInfo("Consensus search completed", {
      provider: "consensus",
      endpoint: "search",
      resultCount: results.length
    });

    return {
      ok: true,
      query,
      retrieved_at_utc,
      results,
      notices: evidenceTruncated
        ? [
            "Paper evidence was truncated to fit the response budget. Narrow the query for more detail."
          ]
        : undefined
    };
  } catch (error) {
    // Fetch errors can include the query URL; keep private research queries out of logs.
    logError("Consensus search request failed", undefined, {
      provider: "consensus",
      endpoint: "search",
      errorType: error instanceof Error ? error.name : "UnknownError"
    });

    return failure("Consensus search could not complete. Try again later.");
  }
}

function describeSearchError(status: number) {
  switch (status) {
    case 401:
      return "Consensus rejected the API key. Check CONSENSUS_API_KEY.";
    case 402:
      return "Consensus billing needs attention before searches can continue.";
    case 403:
      return "Consensus denied this search. Check the account's API access and plan permissions.";
    case 429:
      return "Consensus search is rate limited or the account's monthly allowance is exhausted. Respect retryAfterSeconds when present; do not repeatedly retry an exhausted allowance.";
    default:
      return `Consensus search failed with HTTP ${status}.`;
  }
}

function parseRetryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}
