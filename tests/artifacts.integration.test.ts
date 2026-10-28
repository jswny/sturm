import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { ToolExecuteFunction, ToolSet } from "ai";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import type { ChatAgent } from "../src/agent";
import {
  base64ToBytes,
  storeResponseArtifact,
  toStoredResponseArtifact
} from "../src/artifacts";
import { getDiscordGuildChannelConversationName } from "../src/discord/conversation";
import { DiscordDeliveryStore } from "../src/discord/delivery";
import {
  createDiscordUserMessage,
  withAssistantText
} from "../src/discord/turn";
import type { DiscordChatRequest } from "../src/discord/types";

const PNG_BYTES = base64ToBytes(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4ICfyH4QZYAwATHAIhVXf2RcAAAAASUVORK5CYII="
);

describe("conversation artifacts", () => {
  it("resolves newly persisted artifacts through existing and reconstructed tools", async () => {
    // These tests exercise local transforms and stop before any Discord request.
    expect(env.DISCORD_TOKEN).toBeUndefined();

    const turn = createTurn();

    const agent = await getAgentByName<Env, ChatAgent>(
      env.ChatAgent,
      getDiscordGuildChannelConversationName({
        guildId: turn.guildId!,
        channelId: turn.channelId!
      })
    );

    const artifactId = await runInDurableObject(
      agent,
      async (instance, state) => {
        const deliveries = new DiscordDeliveryStore(state.storage);
        await deliveries.create({
          request: turn,
          responseTarget: { type: "debug", id: turn.correlationId }
        });

        const tools = await instance["createDiscordThinkTools"](
          turn,
          undefined
        );

        await instance.workspace.writeFileBytes(
          "/reaction.png",
          PNG_BYTES,
          "image/png"
        );

        const exported = await executeTool(tools, "exportWorkspaceFile", {
          path: "/reaction.png"
        });

        expect(exported).toMatchObject({ success: true, attached: true });
        const id = String(exported.artifactId);
        const record = await deliveries.getDelivery(turn.correlationId);
        expect(record?.type).toBe("chat");

        if (record?.type !== "chat") throw new Error("Missing chat delivery");
        expect(record.artifacts?.[0]).toMatchObject({
          id,
          source: "workspace_export"
        });
        expect(record.artifacts?.[0]).not.toHaveProperty("base64");

        expect(
          await executeTool(tools, "createGuildEmojiFromArtifact", {
            artifactId: id,
            name: "reaction"
          })
        ).toMatchObject({
          sourceArtifactId: id,
          sourceArtifactSource: "workspace_export",
          processedMimeType: "image/png",
          width: 128,
          error: "Discord emoji upload failed: DISCORD_TOKEN is not configured."
        });

        // Also cover generated artifacts persisted after the tools were built.
        const generated = await storeResponseArtifact(env, {
          source: "image_generation",
          filename: "generated.png",
          mimeType: "image/png",
          bytes: PNG_BYTES,
          keyPrefix: "tests/generated",
          metadata: { prompt: "Test reaction image", model: "test-model" }
        });

        await deliveries.addArtifact(turn.correlationId, generated);

        expect(
          await executeTool(tools, "createGuildStickerFromArtifact", {
            artifactId: generated.id,
            name: "reaction"
          })
        ).toMatchObject({
          sourceArtifactId: generated.id,
          sourceArtifactSource: "image_generation",
          processedMimeType: "image/png",
          width: 320,
          error:
            "Discord sticker upload failed: DISCORD_TOKEN is not configured."
        });

        return generated.id;
      }
    );

    await runInDurableObject(agent, async (instance, state) => {
      const tools = await instance["createDiscordThinkTools"](turn, undefined);

      expect(
        await executeTool(tools, "createGuildEmojiFromArtifact", {
          artifactId,
          name: "recovered"
        })
      ).toMatchObject({
        sourceArtifactId: artifactId,
        processedMimeType: "image/png",
        error: "Discord emoji upload failed: DISCORD_TOKEN is not configured."
      });

      const unrelatedTurn = {
        ...turn,
        correlationId: `${turn.correlationId}-other`
      };

      const deliveries = new DiscordDeliveryStore(state.storage);
      await deliveries.create({
        request: unrelatedTurn,
        responseTarget: { type: "debug", id: unrelatedTurn.correlationId }
      });

      const unrelated = await storeResponseArtifact(env, {
        source: "workspace_export",
        filename: "unrelated.png",
        mimeType: "image/png",
        bytes: PNG_BYTES,
        keyPrefix: "tests/unrelated",
        metadata: { workspacePath: "/unrelated.png" }
      });

      await deliveries.addArtifact(unrelatedTurn.correlationId, unrelated);

      for (const id of [
        unrelated.id,
        "missing-artifact",
        unrelated.artifactKey
      ]) {
        expect(
          await executeTool(tools, "createGuildEmojiFromArtifact", {
            artifactId: id,
            name: "unavailable"
          })
        ).toMatchObject({
          ok: false,
          error: expect.stringContaining(
            "not available in the current conversation"
          )
        });
      }

      const otherChannelTools = await instance["createDiscordThinkTools"](
        {
          ...turn,
          channelId: "other-channel"
        },
        undefined
      );

      expect(
        await executeTool(otherChannelTools, "createGuildEmojiFromArtifact", {
          artifactId,
          name: "wrong_channel"
        })
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("not available")
      });
    });
  });

  it("resolves retained conversation artifacts and forgets them when history clears", async () => {
    expect(env.DISCORD_TOKEN).toBeUndefined();

    const turn = createTurn();

    const agent = await getAgentByName<Env, ChatAgent>(
      env.ChatAgent,
      getDiscordGuildChannelConversationName({
        guildId: turn.guildId!,
        channelId: turn.channelId!
      })
    );

    await runInDurableObject(agent, async (instance, state) => {
      const deliveries = new DiscordDeliveryStore(state.storage);
      await deliveries.create({
        request: turn,
        responseTarget: { type: "debug", id: turn.correlationId }
      });

      const artifact = await storeResponseArtifact(env, {
        source: "workspace_export",
        filename: "earlier.png",
        mimeType: "image/png",
        bytes: PNG_BYTES,
        keyPrefix: "tests/history",
        metadata: { workspacePath: "/earlier.png" }
      });

      await instance.addMessages([
        createDiscordUserMessage({
          ...turn,
          correlationId: "earlier-turn",
          artifacts: [toStoredResponseArtifact(artifact)]
        }),
        withAssistantText(
          {
            id: "earlier-assistant",
            role: "assistant",
            parts: []
          },
          "Earlier image",
          [artifact]
        )
      ]);

      const tools = await instance["createDiscordThinkTools"](turn, undefined);
      const input = { artifactId: artifact.id, name: "earlier" };
      expect(
        await executeTool(tools, "createGuildEmojiFromArtifact", input)
      ).toMatchObject({
        processedMimeType: "image/png",
        error: "Discord emoji upload failed: DISCORD_TOKEN is not configured."
      });

      await instance["clearMessagesAndStreams"]();
      expect(
        await executeTool(tools, "createGuildEmojiFromArtifact", input)
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "not available in the current conversation"
        )
      });
    });
  });
});

function createTurn() {
  return {
    correlationId: crypto.randomUUID(),
    guildId: "test-guild",
    channelId: `test-channel-${crypto.randomUUID()}`,
    userId: "test-user",
    userPermissions: PermissionFlagsBits.CreateGuildExpressions.toString(),
    text: "Create a reaction image"
  } satisfies DiscordChatRequest;
}

async function executeTool(tools: ToolSet, name: string, input: unknown) {
  const execute = tools[name]?.execute as
    | ToolExecuteFunction<unknown, unknown, unknown>
    | undefined;

  if (!execute) throw new Error(`Missing tool ${name}`);

  const result: unknown = await execute(input, {
    toolCallId: crypto.randomUUID(),
    messages: [],
    context: undefined
  });

  expect(result).toBeTypeOf("object");
  expect(result).not.toBeNull();

  return result as Record<string, unknown>;
}
