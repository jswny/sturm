import type { StoredResponseArtifact } from "../artifacts";

const MAX_ARTIFACT_REFERENCE_TEXT_LENGTH = 300;

export type FormatModelArtifactReferencesOptions = {
  heading: string;
  includeUsageGuidance?: boolean;
};

export function formatModelArtifactReferences(
  artifacts: readonly StoredResponseArtifact[] | undefined,
  options: FormatModelArtifactReferencesOptions
) {
  if (!artifacts?.length) return "";

  const lines = [options.heading];
  if (options.includeUsageGuidance ?? true) {
    lines.push(
      "Use artifactId for tool calls only. Do not repeat artifact IDs or internal references in final responses unless the user asks for diagnostics."
    );
  }
  lines.push(...artifacts.map(formatArtifactReference));
  return lines.join("\n");
}

function formatArtifactReference(artifact: StoredResponseArtifact) {
  return [
    `- artifactId: ${artifact.id}`,
    `source: ${artifact.source}`,
    `filename: ${artifact.filename}`,
    `mimeType: ${artifact.mimeType}`,
    formatArtifactDescription(artifact),
    ...formatUsefulArtifactMetadata(artifact)
  ]
    .filter(Boolean)
    .join("\n  ");
}

function formatArtifactDescription(artifact: StoredResponseArtifact) {
  if (artifact.visualSummary) {
    return `visualSummary: ${truncateArtifactReferenceText(artifact.visualSummary)}`;
  }
  if (artifact.description) {
    return `description: ${truncateArtifactReferenceText(artifact.description)}`;
  }
  if (artifact.source === "image_generation") {
    return `description: ${truncateArtifactReferenceText(
      `Generated image for: ${artifact.metadata.prompt}`
    )}`;
  }
  return "";
}

function formatUsefulArtifactMetadata(artifact: StoredResponseArtifact) {
  switch (artifact.source) {
    case "discord_attachment":
      return [
        formatDimensions(artifact.metadata.width, artifact.metadata.height)
      ];
    case "image_generation":
      return [
        formatDimensions(artifact.metadata.width, artifact.metadata.height),
        artifact.metadata.aspectRatio
          ? `aspectRatio: ${artifact.metadata.aspectRatio}`
          : ""
      ];
    case "workspace_export":
      return [`workspacePath: ${artifact.metadata.workspacePath}`];
  }
}

function formatDimensions(
  width: number | undefined,
  height: number | undefined
) {
  return width && height ? `dimensions: ${width}x${height}` : "";
}

function truncateArtifactReferenceText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ARTIFACT_REFERENCE_TEXT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ARTIFACT_REFERENCE_TEXT_LENGTH - 3)}...`;
}
