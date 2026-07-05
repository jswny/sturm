import { tool } from "ai";
import { z } from "zod";
import {
  MAX_BUTTON_LABEL_LENGTH,
  MAX_PROMPT_OPTIONS,
  MAX_PROMPT_QUESTION_LENGTH,
  MAX_SELECT_DESCRIPTION_LENGTH,
  MAX_SELECT_LABEL_LENGTH,
  MAX_TERMINAL_TEXT_LENGTH,
  type ComponentPromptKind,
  type CreateComponentPromptInput,
  type StoredComponentPrompt
} from "../discord/component-prompts";

const MIN_PROMPT_TEXT_LENGTH = 1;
const MIN_PROMPT_OPTION_COUNT = 2;
const MAX_PENDING_ACTION_LENGTH = 2000;

const QUESTION_DESCRIPTION = `Public question to show in Discord, from ${MIN_PROMPT_TEXT_LENGTH} to ${MAX_PROMPT_QUESTION_LENGTH} characters`;
const PENDING_ACTION_DESCRIPTION = `Durable description of the exact work Sturm should continue after the user responds, from ${MIN_PROMPT_TEXT_LENGTH} to ${MAX_PENDING_ACTION_LENGTH} characters. Include targets, IDs, durations, reasons, user constraints, and other parameters needed to perform the work later.`;

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
    .min(MIN_PROMPT_TEXT_LENGTH)
    .max(MAX_PROMPT_QUESTION_LENGTH)
    .describe(QUESTION_DESCRIPTION),
  confirmLabel: z
    .string()
    .min(MIN_PROMPT_TEXT_LENGTH)
    .max(MAX_BUTTON_LABEL_LENGTH)
    .optional()
    .describe(
      `Confirmation button label, from ${MIN_PROMPT_TEXT_LENGTH} to ${MAX_BUTTON_LABEL_LENGTH} characters. Defaults to Confirm.`
    ),
  cancelLabel: z
    .string()
    .min(MIN_PROMPT_TEXT_LENGTH)
    .max(MAX_BUTTON_LABEL_LENGTH)
    .optional()
    .describe(
      `Cancel button label, from ${MIN_PROMPT_TEXT_LENGTH} to ${MAX_BUTTON_LABEL_LENGTH} characters. Defaults to Cancel.`
    ),
  pendingAction: z
    .string()
    .min(MIN_PROMPT_TEXT_LENGTH)
    .max(MAX_PENDING_ACTION_LENGTH)
    .describe(PENDING_ACTION_DESCRIPTION),
  cancelMessage: z
    .string()
    .min(MIN_PROMPT_TEXT_LENGTH)
    .max(MAX_TERMINAL_TEXT_LENGTH)
    .optional()
    .describe(
      `Message to show on the prompt if the user cancels, from ${MIN_PROMPT_TEXT_LENGTH} to ${MAX_TERMINAL_TEXT_LENGTH} characters`
    )
});

const selectPromptInputSchema = z.object({
  question: z
    .string()
    .min(MIN_PROMPT_TEXT_LENGTH)
    .max(MAX_PROMPT_QUESTION_LENGTH)
    .describe(QUESTION_DESCRIPTION),
  options: z
    .array(
      z.object({
        label: z
          .string()
          .min(MIN_PROMPT_TEXT_LENGTH)
          .max(MAX_SELECT_LABEL_LENGTH)
          .describe(
            `Visible option label, from ${MIN_PROMPT_TEXT_LENGTH} to ${MAX_SELECT_LABEL_LENGTH} characters`
          ),
        description: z
          .string()
          .min(MIN_PROMPT_TEXT_LENGTH)
          .max(MAX_SELECT_DESCRIPTION_LENGTH)
          .optional()
          .describe(
            `Optional short option description, from ${MIN_PROMPT_TEXT_LENGTH} to ${MAX_SELECT_DESCRIPTION_LENGTH} characters`
          ),
        pendingAction: z
          .string()
          .min(MIN_PROMPT_TEXT_LENGTH)
          .max(MAX_PENDING_ACTION_LENGTH)
          .describe(PENDING_ACTION_DESCRIPTION)
      })
    )
    .min(MIN_PROMPT_OPTION_COUNT)
    .max(MAX_PROMPT_OPTIONS)
    .describe(
      `Options the user can choose from, from ${MIN_PROMPT_OPTION_COUNT} to ${MAX_PROMPT_OPTIONS} options`
    )
});

type ConfirmPromptInput = z.infer<typeof confirmPromptInputSchema>;
type SelectPromptInput = z.infer<typeof selectPromptInputSchema>;

export function createUserPromptTools(
  controller: UserPromptController | undefined
) {
  return {
    askUserToConfirm: tool<ConfirmPromptInput, UserPromptToolResponse>({
      description:
        "Ask the current Discord user to confirm or cancel before Sturm continues. Use this instead of guessing when a user must explicitly approve a pending action. The prompt is shown publicly, but only the current requester can answer; other users' clicks are rejected before reaching the model. The Discord component prompt is rendered automatically, so do not expose promptId or other internal identifiers in the final response unless the user explicitly asks for diagnostic details. After calling this tool, end the turn with a short note and do not perform the pending action until the confirmation result comes back in a later turn. If later code needs prompt details, keep or return the structured tool result.",
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
      }
    }),
    askUserToSelect: tool<SelectPromptInput, UserPromptToolResponse>({
      description:
        "Ask the current Discord user to choose one option before Sturm continues. Use for disambiguation, choosing one of several proposed paths, or collecting a missing bounded value. The prompt is shown publicly, but only the current requester can answer; other users' clicks are rejected before reaching the model. The Discord component prompt is rendered automatically, so do not expose promptId or other internal identifiers in the final response unless the user explicitly asks for diagnostic details. Each option's pendingAction is durable task state for the later turn, so include explicit durable IDs needed to continue, such as artifactId and the chosen sticker/emoji name when prompting for an expression name. After calling this tool, end the turn with a short note and do not perform the pending action until the selection result comes back in a later turn. If later code needs prompt details, keep or return the structured tool result.",
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
      }
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
