/** A Tool result carrying its output both as structured content and as text. */
export function structured<Output extends Record<string, unknown>>(
  output: Output
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}
