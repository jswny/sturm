import { tool } from "ai";
import { z } from "zod";
import type {
  ComponentPromptKind,
  CreateComponentPromptInput,
  StoredComponentPrompt
} from "../discord/component-prompts";

export type UserPromptController = {
  create(
    input: Pick<
      CreateComponentPromptInput,
      "kind" | "presentation" | "question" | "options"
    >
  ): Promise<StoredComponentPrompt>;
};

type UserPromptToolResponse = {
  ok: boolean;
  kind?: ComponentPromptKind;
  promptId?: string;
  optionCount?: number;
  error?: string;
};

const userPromptResponseSchema = z.object({
  ok: z.boolean().describe("Whether the prompt was created"),
  kind: z.enum(["confirm", "select"]).optional(),
  promptId: z.string().optional(),
  optionCount: z.number().int().optional(),
  error: z.string().optional()
});

const confirmPromptInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(1200)
    .describe("Public confirmation question to show in Discord"),
  confirmLabel: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Button label for confirming. Defaults to Confirm."),
  cancelLabel: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Button label for cancelling. Defaults to Cancel."),
  pendingAction: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "Durable description of the exact work Sturm should continue after confirmation. Include targets, IDs, durations, reasons, user constraints, and other parameters needed to perform the work later."
    ),
  cancelMessage: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("Message to show on the prompt if the user cancels.")
});

const selectPromptInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(1200)
    .describe("Public selection question to show in Discord"),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(100).describe("Visible option label"),
        description: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Optional short option description"),
        pendingAction: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            "Durable meaning of this option and the exact work Sturm should continue if selected. Include all identifiers, selected values, user constraints, and context needed to perform the work later."
          )
      })
    )
    .min(2)
    .max(10)
    .describe("Options the user can choose from")
});

type ConfirmPromptInput = z.infer<typeof confirmPromptInputSchema>;
type SelectPromptInput = z.infer<typeof selectPromptInputSchema>;

export function createUserPromptTools(
  controller: UserPromptController | undefined
) {
  return {
    askUserToConfirm: tool<ConfirmPromptInput, UserPromptToolResponse>({
      description:
        "Ask the current Discord user to confirm or cancel before Sturm continues. Use this instead of guessing when a user must explicitly approve a pending action. The prompt is shown publicly, but only the current requester can answer; other users' clicks are rejected before reaching the model. After calling this tool, end the turn with a short note and do not perform the pending action until the confirmation result comes back in a later turn.",
      inputSchema: confirmPromptInputSchema,
      outputSchema: userPromptResponseSchema,
      execute: async ({
        question,
        confirmLabel,
        cancelLabel,
        pendingAction,
        cancelMessage
      }) => {
        if (!controller) {
          return {
            ok: false,
            error: "User prompts are not available in this turn."
          } satisfies UserPromptToolResponse;
        }

        const prompt = await controller.create({
          kind: "confirm",
          presentation: "buttons",
          question,
          options: [
            {
              label: confirmLabel ?? "Confirm",
              pendingAction,
              style: "success"
            },
            {
              label: cancelLabel ?? "Cancel",
              terminalText: cancelMessage ?? "Cancelled.",
              style: "secondary"
            }
          ]
        });

        return createPromptResponse(prompt);
      },
      toModelOutput: (options) => ({
        type: "text",
        value: formatPromptToolOutput(options.output as UserPromptToolResponse)
      })
    }),
    askUserToSelect: tool<SelectPromptInput, UserPromptToolResponse>({
      description:
        "Ask the current Discord user to choose one option before Sturm continues. Use for disambiguation, choosing one of several proposed paths, or collecting a missing bounded value. The prompt is shown publicly, but only the current requester can answer; other users' clicks are rejected before reaching the model. Each option's pendingAction is durable task state for the later turn, so include all IDs and context needed to continue.",
      inputSchema: selectPromptInputSchema,
      outputSchema: userPromptResponseSchema,
      execute: async ({ question, options }) => {
        if (!controller) {
          return {
            ok: false,
            error: "User prompts are not available in this turn."
          } satisfies UserPromptToolResponse;
        }

        const prompt = await controller.create({
          kind: "select",
          presentation: "select",
          question,
          options: options.map((option) => ({
            label: option.label,
            description: option.description,
            pendingAction: option.pendingAction
          }))
        });

        return createPromptResponse(prompt);
      },
      toModelOutput: (options) => ({
        type: "text",
        value: formatPromptToolOutput(options.output as UserPromptToolResponse)
      })
    })
  };
}

function createPromptResponse(prompt: StoredComponentPrompt) {
  return {
    ok: true,
    kind: prompt.kind,
    promptId: prompt.id,
    optionCount: prompt.options.length
  } satisfies UserPromptToolResponse;
}

function formatPromptToolOutput(output: UserPromptToolResponse) {
  if (!output.ok) return `User prompt failed: ${output.error}`;

  return [
    `User ${output.kind} prompt created: ${output.promptId}`,
    `Options: ${output.optionCount}`,
    "The prompt will be rendered in Discord. Do not continue the pending action until the user's component selection arrives in a later turn."
  ].join("\n");
}
