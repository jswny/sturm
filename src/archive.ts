export type ArchiveUrlResponse = {
  originalUrl: string;
  preparedUrl?: string;
  archiveUrl?: string;
  queryParamsPreserved: boolean;
  error?: string;
};

const ARCHIVE_LATEST_BASE_URL = "https://archive.today/latest/";

export function archiveUrl(
  url: string,
  preserveQueryParams = false
): ArchiveUrlResponse {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      originalUrl: url,
      queryParamsPreserved: preserveQueryParams,
      error: "Invalid URL."
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      originalUrl: url,
      queryParamsPreserved: preserveQueryParams,
      error: "Only http and https URLs can be archived."
    };
  }

  if (!preserveQueryParams) {
    parsedUrl.search = "";
  }

  const preparedUrl = parsedUrl.toString();

  return {
    originalUrl: url,
    preparedUrl,
    archiveUrl: `${ARCHIVE_LATEST_BASE_URL}${preparedUrl}`,
    queryParamsPreserved: preserveQueryParams
  };
}
