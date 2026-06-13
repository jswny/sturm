import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIButtonComponent,
  type APIMessageTopLevelComponent,
  type APISelectMenuOption,
  type APIStringSelectComponent
} from "discord-api-types/v10";
import type {
  DiscordChannelContext,
  DiscordPermissionContext,
  DiscordUserContext
} from "./types";

export type ComponentPromptKind = "confirm" | "select";
export type ComponentPromptPresentation = "buttons" | "select";
export type ComponentPromptStatus = "pending" | "consumed" | "expired";

export type ComponentPromptOptionStyle =
  | "primary"
  | "secondary"
  | "success"
  | "danger";

export type ComponentPromptOption = {
  id: string;
  label: string;
  description?: string;
  pendingAction?: string;
  terminalText?: string;
  style?: ComponentPromptOptionStyle;
};

export type StoredComponentPrompt = {
  id: string;
  kind: ComponentPromptKind;
  presentation: ComponentPromptPresentation;
  question: string;
  allowedUserId: string;
  allowedUserDisplayName?: string;
  guildId?: string;
  channelId?: string;
  sourceInteractionId: string;
  messageId?: string;
  options: ComponentPromptOption[];
  status: ComponentPromptStatus;
  selectedOptionId?: string;
  selectedByUserId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type CreateComponentPromptInput = {
  kind: ComponentPromptKind;
  presentation: ComponentPromptPresentation;
  question: string;
  allowedUserId: string;
  allowedUserDisplayName?: string;
  guildId?: string;
  channelId?: string;
  sourceInteractionId: string;
  options: Array<Omit<ComponentPromptOption, "id">>;
  ttlMs?: number;
};

export type ComponentPromptSelectionInput = {
  promptId: string;
  optionId?: string;
  userId?: string;
  user?: DiscordUserContext;
  guildId?: string;
  channelId?: string;
  messageId?: string;
};

export type DiscordComponentPromptInteractionInput =
  ComponentPromptSelectionInput & {
    interactionId: string;
    appPermissions?: DiscordPermissionContext;
    channel?: DiscordChannelContext;
    userPermissions?: string;
  };

export type ComponentPromptSelectionResult =
  | {
      status: "accepted";
      prompt: StoredComponentPrompt;
      option: ComponentPromptOption;
    }
  | { status: "wrong_user"; prompt: StoredComponentPrompt }
  | { status: "wrong_context"; prompt: StoredComponentPrompt }
  | { status: "expired"; prompt: StoredComponentPrompt }
  | { status: "already_handled"; prompt: StoredComponentPrompt }
  | { status: "invalid_option"; prompt: StoredComponentPrompt }
  | { status: "not_found" };

export type ParsedComponentPromptCustomId = {
  promptId: string;
  optionId?: string;
  mode: "button" | "select";
};

const COMPONENT_PROMPT_KEY_PREFIX = "discord:component-prompt:";
const CUSTOM_ID_PREFIX = "sturm:prompt";
const DEFAULT_PROMPT_TTL_MS = 15 * 60 * 1000;
const COMPONENT_PROMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const COMPONENT_PROMPT_PRUNE_BATCH_SIZE = 100;
const MAX_PROMPT_OPTIONS = 10;
const MAX_PROMPT_QUESTION_LENGTH = 1200;
const MAX_BUTTON_LABEL_LENGTH = 80;
const MAX_SELECT_LABEL_LENGTH = 100;
const MAX_SELECT_DESCRIPTION_LENGTH = 100;
const MAX_TERMINAL_TEXT_LENGTH = 300;

export class DiscordComponentPromptStore {
  constructor(private storage: DurableObjectStorage) {}

  async create(input: CreateComponentPromptInput) {
    const now = new Date();
    const nowIso = now.toISOString();
    const prompt: StoredComponentPrompt = {
      id: crypto.randomUUID(),
      kind: input.kind,
      presentation: input.presentation,
      question: truncate(input.question.trim(), MAX_PROMPT_QUESTION_LENGTH),
      allowedUserId: input.allowedUserId,
      allowedUserDisplayName: input.allowedUserDisplayName,
      guildId: input.guildId,
      channelId: input.channelId,
      sourceInteractionId: input.sourceInteractionId,
      options: input.options
        .slice(0, MAX_PROMPT_OPTIONS)
        .map((option, index) => ({
          id: `o${index + 1}`,
          label: truncate(
            option.label.trim(),
            input.presentation === "select"
              ? MAX_SELECT_LABEL_LENGTH
              : MAX_BUTTON_LABEL_LENGTH
          ),
          description: option.description
            ? truncate(option.description.trim(), MAX_SELECT_DESCRIPTION_LENGTH)
            : undefined,
          pendingAction: option.pendingAction?.trim(),
          terminalText: option.terminalText
            ? truncate(option.terminalText.trim(), MAX_TERMINAL_TEXT_LENGTH)
            : undefined,
          style: option.style
        })),
      status: "pending",
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(
        now.getTime() + (input.ttlMs ?? DEFAULT_PROMPT_TTL_MS)
      ).toISOString()
    };

    await this.storage.put(getComponentPromptKey(prompt.id), prompt);
    return prompt;
  }

  async get(promptId: string) {
    return this.storage.get<StoredComponentPrompt>(
      getComponentPromptKey(promptId)
    );
  }

  async markDelivered(promptId: string, messageId: string | undefined) {
    if (!messageId) return;

    await this.storage.transaction(async (txn) => {
      const key = getComponentPromptKey(promptId);
      const prompt = await txn.get<StoredComponentPrompt>(key);
      if (!prompt || prompt.messageId) return;

      await txn.put<StoredComponentPrompt>(key, {
        ...prompt,
        messageId,
        updatedAt: new Date().toISOString()
      });
    });
  }

  async select(
    input: ComponentPromptSelectionInput
  ): Promise<ComponentPromptSelectionResult> {
    return this.storage.transaction(async (txn) => {
      const key = getComponentPromptKey(input.promptId);
      const prompt = await txn.get<StoredComponentPrompt>(key);
      if (!prompt) return { status: "not_found" };

      if (prompt.status !== "pending") {
        return { status: "already_handled", prompt };
      }

      const now = new Date();
      if (Date.parse(prompt.expiresAt) <= now.getTime()) {
        const expired = {
          ...prompt,
          status: "expired",
          updatedAt: now.toISOString()
        } satisfies StoredComponentPrompt;
        await txn.put<StoredComponentPrompt>(key, expired);
        return { status: "expired", prompt: expired };
      }

      if (
        !matchesOptionalField(prompt.guildId, input.guildId) ||
        !matchesOptionalField(prompt.channelId, input.channelId) ||
        !matchesOptionalField(prompt.messageId, input.messageId)
      ) {
        return { status: "wrong_context", prompt };
      }

      if (!input.userId || input.userId !== prompt.allowedUserId) {
        return { status: "wrong_user", prompt };
      }

      const option = prompt.options.find((item) => item.id === input.optionId);
      if (!option) return { status: "invalid_option", prompt };

      const consumed = {
        ...prompt,
        status: "consumed",
        selectedOptionId: option.id,
        selectedByUserId: input.userId,
        updatedAt: now.toISOString()
      } satisfies StoredComponentPrompt;
      await txn.put<StoredComponentPrompt>(key, consumed);

      return { status: "accepted", prompt: consumed, option };
    });
  }

  async pruneStalePrompts(retentionMs = COMPONENT_PROMPT_RETENTION_MS) {
    const cutoffMs = Date.now() - retentionMs;
    const prompts = await this.storage.list<StoredComponentPrompt>({
      prefix: COMPONENT_PROMPT_KEY_PREFIX,
      limit: COMPONENT_PROMPT_PRUNE_BATCH_SIZE
    });
    const keysToDelete: string[] = [];

    for (const [key, prompt] of prompts) {
      if (shouldPruneComponentPrompt(prompt, cutoffMs)) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      await this.storage.delete(keysToDelete);
    }

    return keysToDelete.length;
  }
}

export function createComponentPromptButtonCustomId(
  promptId: string,
  optionId: string
) {
  return `${CUSTOM_ID_PREFIX}:${promptId}:${optionId}`;
}

export function createComponentPromptSelectCustomId(promptId: string) {
  return `${CUSTOM_ID_PREFIX}:${promptId}:select`;
}

export function parseComponentPromptCustomId(
  customId: string
): ParsedComponentPromptCustomId | undefined {
  const parts = customId.split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== CUSTOM_ID_PREFIX) {
    return undefined;
  }

  const [, , promptId, optionOrMode] = parts;
  if (!promptId) return undefined;

  if (optionOrMode === "select") {
    return { promptId, mode: "select" };
  }

  if (!optionOrMode) return undefined;
  return { promptId, optionId: optionOrMode, mode: "button" };
}

export function createComponentPromptResponse(prompt: StoredComponentPrompt) {
  return {
    content: formatComponentPromptText(prompt),
    components: renderComponentPromptComponents(prompt),
    flags: MessageFlags.IsComponentsV2
  };
}

export function renderComponentPromptComponents(
  prompt: StoredComponentPrompt
): APIMessageTopLevelComponent[] {
  return [
    {
      type: ComponentType.TextDisplay,
      content: formatComponentPromptText(prompt)
    },
    {
      type: ComponentType.ActionRow,
      components:
        prompt.presentation === "select"
          ? [renderSelectPrompt(prompt)]
          : renderButtonPrompt(prompt)
    }
  ];
}

export function formatComponentPromptText(prompt: StoredComponentPrompt) {
  const lines = [
    prompt.question,
    "",
    `Only <@${prompt.allowedUserId}> can answer.`
  ];
  const selected = prompt.options.find(
    (option) => option.id === prompt.selectedOptionId
  );

  if (prompt.status === "consumed" && selected) {
    lines.push(
      "",
      selected.terminalText ??
        [`Selected: ${selected.label}`, "Sturm is working on it."].join("\n")
    );
  } else if (prompt.status === "expired") {
    lines.push("", "This prompt has expired.");
  }

  return lines.join("\n");
}

export function formatComponentPromptHistoryText(
  prompt: StoredComponentPrompt
) {
  const lines = [
    `${prompt.kind === "confirm" ? "Confirmation" : "Selection"} prompt sent:`,
    `prompt_id: ${prompt.id}`,
    `allowed_user_id: ${prompt.allowedUserId}`,
    `question: ${prompt.question}`,
    "options:",
    ...prompt.options.map((option) => `- ${option.id}: ${option.label}`)
  ];

  return lines.join("\n");
}

export function formatComponentPromptContinuationText(
  prompt: StoredComponentPrompt,
  option: ComponentPromptOption
) {
  const guidance =
    prompt.kind === "confirm"
      ? [
          "The user confirmed this pending action. Continue from that approval now.",
          "If the approved action can be performed, perform it.",
          "If it cannot be performed, explain why."
        ]
      : [
          "The user selected this option. Continue from that selection now.",
          "Use the selected option as the user's answer and complete the next step.",
          "If you cannot continue, explain why."
        ];
  const lines = [
    "Discord component prompt result:",
    `prompt_id: ${prompt.id}`,
    `prompt_type: ${prompt.kind}`,
    `selected_option_id: ${option.id}`,
    `selected_option_label: ${option.label}`,
    "",
    ...guidance
  ];

  if (option.pendingAction) {
    lines.push(
      "",
      prompt.kind === "confirm"
        ? "Approved pending action:"
        : "Selected pending action:",
      option.pendingAction
    );
  }

  return lines.join("\n");
}

function renderButtonPrompt(prompt: StoredComponentPrompt) {
  const disabled = prompt.status !== "pending";

  return prompt.options.map(
    (option) =>
      ({
        type: ComponentType.Button,
        custom_id: createComponentPromptButtonCustomId(prompt.id, option.id),
        label: option.label,
        style: getButtonStyle(option.style),
        disabled
      }) satisfies APIButtonComponent
  );
}

function renderSelectPrompt(prompt: StoredComponentPrompt) {
  const disabled = prompt.status !== "pending";
  const selected = prompt.options.find(
    (option) => option.id === prompt.selectedOptionId
  );

  return {
    type: ComponentType.StringSelect,
    custom_id: createComponentPromptSelectCustomId(prompt.id),
    placeholder: selected?.label ?? "Choose one",
    min_values: 1,
    max_values: 1,
    disabled,
    options: prompt.options.map(
      (option) =>
        ({
          label: option.label,
          value: option.id,
          description: option.description
        }) satisfies APISelectMenuOption
    )
  } satisfies APIStringSelectComponent;
}

function getButtonStyle(style: ComponentPromptOptionStyle | undefined) {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    case "secondary":
    default:
      return ButtonStyle.Secondary;
  }
}

function matchesOptionalField(
  expected: string | undefined,
  actual: string | undefined
) {
  return expected === undefined || expected === actual;
}

function shouldPruneComponentPrompt(
  prompt: StoredComponentPrompt,
  cutoffMs: number
) {
  const timestamp =
    prompt.status === "pending" ? prompt.expiresAt : prompt.updatedAt;
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) && timestampMs < cutoffMs;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + "...";
}

function getComponentPromptKey(promptId: string) {
  return `${COMPONENT_PROMPT_KEY_PREFIX}${promptId}`;
}
