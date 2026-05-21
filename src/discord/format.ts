import type { ModelMessage } from "ai";
import type { DiscordChatRequest } from "./types";
import type { GeneratedImage } from "../images";

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

  return `${lines.join("\n")}

User message:
${request.text}`;
}

export function formatAssistantMessageText(
  text: string,
  artifacts: GeneratedImage[]
) {
  const artifactMessage = formatImageArtifactMessage(artifacts);
  const trimmed = text.trim();

  if (trimmed && artifactMessage) return `${trimmed}\n\n${artifactMessage}`;
  return trimmed || artifactMessage || "I did not get a text response.";
}

export function formatDiscordResponseText(
  text: string,
  artifacts: GeneratedImage[]
) {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (artifacts.length === 1) return "Generated image.";
  if (artifacts.length > 1) return `Generated ${artifacts.length} images.`;
  return "I did not get a text response.";
}

function formatImageArtifactMessage(artifacts: GeneratedImage[]) {
  if (artifacts.length === 0) return "";

  return artifacts
    .map(
      (artifact) =>
        `Generated image:\nprompt: ${artifact.prompt}\nmodel: ${artifact.model}\nsize: ${artifact.width}x${artifact.height}\nr2_key: ${artifact.r2Key}\nstatus: sent as attachment`
    )
    .join("\n\n");
}
