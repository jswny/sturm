export type SearchEnv = Env & {
  KAGI_API_KEY?: string;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type SearchResponse = {
  query: string;
  answer?: string;
  results: SearchResult[];
  error?: string;
};

type KagiFastGptResponse = {
  data?: {
    output?: string;
    references?: SearchResult[];
  };
};

const KAGI_FASTGPT_URL = "https://kagi.com/api/v0/fastgpt";

function decodeSearchSnippetEntities(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function cleanSnippet(snippet: string | undefined) {
  if (!snippet) return undefined;
  return decodeSearchSnippetEntities(snippet.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchWeb(
  env: SearchEnv,
  query: string
): Promise<SearchResponse> {
  const apiKey = env.KAGI_API_KEY?.trim();

  if (!apiKey) {
    return {
      query,
      results: [],
      error: "KAGI_API_KEY is not configured."
    };
  }

  let response: Response;
  try {
    response = await fetch(KAGI_FASTGPT_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bot ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });
  } catch (error) {
    console.error("Kagi search request failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      query,
      results: [],
      error: "Kagi search request failed."
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn("Kagi FastGPT returned an error", {
      status: response.status,
      statusText: response.statusText,
      body: body.slice(0, 500)
    });
    return {
      query,
      results: [],
      error: `Kagi search failed with ${response.status} ${response.statusText}.`
    };
  }

  let payload: KagiFastGptResponse;
  try {
    payload = (await response.json()) as KagiFastGptResponse;
  } catch (error) {
    console.error("Kagi FastGPT returned invalid JSON", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      query,
      results: [],
      error: "Kagi search returned invalid JSON."
    };
  }
  const results = (payload.data?.references ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: cleanSnippet(item.snippet)
  }));

  return {
    query,
    answer: payload.data?.output,
    results
  };
}
