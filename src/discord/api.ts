import type { DiscordResponseAttachment, DiscordResponseTarget } from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_DISCORD_CONTENT_LENGTH = 2000;

export async function editOriginalInteractionResponse(
  target: DiscordResponseTarget,
  content: string,
  attachments: DiscordResponseAttachment[] = []
) {
  const body = createDiscordResponseBody(content, attachments);
  const response = await fetch(
    `${DISCORD_API_BASE}/webhooks/${target.applicationId}/${target.token}/messages/@original`,
    {
      method: "PATCH",
      headers: body.headers,
      body: body.body
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Discord original response edit failed: ${response.status} ${body}`
    );
  }
}

function createDiscordResponseBody(
  content: string,
  attachments: DiscordResponseAttachment[]
) {
  const payload = {
    content: truncateDiscordContent(content),
    allowed_mentions: { parse: [] },
    attachments: attachments.map((attachment, index) => ({
      id: index,
      filename: attachment.filename,
      description: attachment.description
    }))
  };

  if (attachments.length === 0) {
    return {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    };
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  for (const [index, attachment] of attachments.entries()) {
    form.append(
      `files[${index}]`,
      new File([base64ToBytes(attachment.base64)], attachment.filename, {
        type: attachment.mimeType
      })
    );
  }

  return { headers: undefined, body: form };
}

function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function truncateDiscordContent(content: string) {
  if (content.length <= MAX_DISCORD_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_DISCORD_CONTENT_LENGTH - 3)}...`;
}
