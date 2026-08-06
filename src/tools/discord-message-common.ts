import { z } from "zod";
import type { DiscordRetrievedMessage } from "../discord/message-format";

export const discordRetrievedMessageSchema = z.object({
  id: z.string(),
  formattedText: z.string(),
  url: z.string()
});

export function formatDiscordRetrievedMessageOutput(
  message: DiscordRetrievedMessage
) {
  return `${message.formattedText}\n  message_url: ${message.url}`;
}
