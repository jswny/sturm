const THINK_TAG_PATTERN = /<\/?think\b[^>]*>/i;
const COMPLETE_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const LEADING_STRAY_THINK_CLOSE_PATTERN = /^[\s\S]*<\/think\s*>/i;
const UNCLOSED_LEADING_THINK_PATTERN = /^\s*<think\b[^>]*>[\s\S]*$/i;
const STRAY_THINK_TAG_PATTERN = /<\/?think\b[^>]*>/gi;

export function stripModelThinkingTraces(value: string) {
  if (!THINK_TAG_PATTERN.test(value)) return value;

  return value
    .replace(COMPLETE_THINK_BLOCK_PATTERN, "")
    .replace(LEADING_STRAY_THINK_CLOSE_PATTERN, "")
    .replace(UNCLOSED_LEADING_THINK_PATTERN, "")
    .replace(STRAY_THINK_TAG_PATTERN, "")
    .trim();
}
