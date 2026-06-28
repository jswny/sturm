import type { ModelMessage } from "ai";
import type { DiscordChatRequest } from "./types";
import type { ResponseArtifact, StoredResponseArtifact } from "../artifacts";

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
export function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

export function formatDiscordUserMessage(request: DiscordChatRequest) {
  const lines = ["Discord user:"];
  if (request.user?.id) lines.push(`id: ${request.user.id}`);
  if (request.user?.displayName) {
    lines.push(`display_name: ${request.user.displayName}`);
  }

  const artifacts = formatArtifactReferences(request.artifacts);
  const attachments = formatUnstoredDiscordAttachments(request);

  return `${lines.join("\n")}
User message:
${request.text}${artifacts ? `\n\n${artifacts}` : ""}${attachments ? `\n\n${attachments}` : ""}`;
}

export function formatAssistantMessageText(
  text: string,
  artifacts: ResponseArtifact[]
) {
  const artifactMessage = formatArtifactMessage(artifacts);
  const trimmed = text.trim();

  if (trimmed && artifactMessage) return `${trimmed}\n\n${artifactMessage}`;
  return trimmed || artifactMessage || "I did not get a text response.";
}

export function formatDiscordResponseText(
  text: string,
  artifacts: ResponseArtifact[]
) {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (artifacts.length === 1) {
    return artifacts[0].mimeType.startsWith("image/")
      ? "Generated image."
      : `Attached ${artifacts[0].filename}.`;
  }
  if (artifacts.length > 1) return `Attached ${artifacts.length} files.`;
  return "I did not get a text response.";
}

function formatArtifactMessage(artifacts: ResponseArtifact[]) {
  if (artifacts.length === 0) return "";

  return artifacts
    .map((artifact) => {
      const lines = [
        `${formatArtifactKind(artifact)} artifact:`,
        `artifactId: ${artifact.id}`,
        `source: ${artifact.source}`,
        `filename: ${artifact.filename}`,
        `mimeType: ${artifact.mimeType}`,
        artifact.visualSummary ? `visualSummary: ${artifact.visualSummary}` : ""
      ];

      lines.push(...formatArtifactMetadata(artifact));
      lines.push(`sha256: ${artifact.sha256}`);
      lines.push("status: sent as attachment");
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatArtifactKind(artifact: StoredResponseArtifact) {
  if (artifact.source === "discord_attachment") return "Discord input";
  if (artifact.source === "image_generation") return "Generated image";
  if (artifact.source === "workspace_export") return "Exported workspace file";
  return "Response";
}

function formatArtifactMetadata(artifact: StoredResponseArtifact) {
  switch (artifact.source) {
    case "discord_attachment":
      return [
        `sourceTurnCorrelationId: ${artifact.metadata.correlationId}`,
        artifact.metadata.width && artifact.metadata.height
          ? `dimensions: ${artifact.metadata.width}x${artifact.metadata.height}`
          : ""
      ].filter(Boolean);
    case "image_generation":
      return [
        `prompt: ${artifact.metadata.prompt}`,
        `model: ${artifact.metadata.model}`,
        `dimensions: ${artifact.metadata.width}x${artifact.metadata.height}`
      ];
    case "workspace_export":
      return [`workspacePath: ${artifact.metadata.workspacePath}`];
  }
}

function formatArtifactReferences(
  artifacts: StoredResponseArtifact[] | undefined
) {
  if (!artifacts?.length) return "";

  return [
    "Artifact references:",
    "Use artifactId for tools that operate on uploaded, generated, or exported files. The source field states where the artifact came from.",
    ...artifacts.map((artifact) =>
      [
        `- artifactId: ${artifact.id}`,
        `source: ${artifact.source}`,
        `filename: ${artifact.filename}`,
        `mimeType: ${artifact.mimeType}`,
        `sha256: ${artifact.sha256}`,
        artifact.visualSummary
          ? `visualSummary: ${artifact.visualSummary}`
          : "",
        ...formatArtifactMetadata(artifact)
      ]
        .filter(Boolean)
        .join("\n  ")
    )
  ].join("\n");
}

function formatUnstoredDiscordAttachments(request: DiscordChatRequest) {
  const attachments = request.attachments?.filter(
    (attachment) => !attachment.artifactKey
  );
  if (!attachments?.length) return "";

  return [
    "Discord attachments not stored as artifacts:",
    "These attachments are unavailable to artifact tools because Sturm could not freeze them into stored artifacts.",
    ...attachments.map((attachment) =>
      [
        `- filename: ${attachment.filename}`,
        `mimeType: ${attachment.mimeType}`,
        `sizeBytes: ${attachment.sizeBytes}`,
        `width: ${attachment.width}`,
        `height: ${attachment.height}`,
        `description: ${attachment.description}`
      ]
        .filter(Boolean)
        .join("\n  ")
    )
  ].join("\n");
}
