export const TOOL_CALL_PATTERNS = [
  /```[a-z]*\s*\n?\{\s*"tool"[\s\S]*?\}\s*\n?```/g,
  /^TOOL_CALL:\s*\{[\s\S]*?\}\s*$/m,
  /^\s*\{\s*"tool"\s*:\s*"[a-z_-]+"[\s\S]*?\}\s*$/im,
];

/**
 * Apply the fleet message tool-call policy.
 * A caller must explicitly opt in for a trusted write; all other paths strip.
 */
export function applyFleetToolCallPolicy(message, { allowToolCall = false, stripToolCalls = true } = {}) {
  if (typeof message !== 'string') return message;
  let value = message;
  if (stripToolCalls && allowToolCall !== true) {
    for (const pattern of TOOL_CALL_PATTERNS) value = value.replace(pattern, '');
  }
  return value.replace(/\n{3,}/g, '\n\n').trim();
}
