/** A Tool result carrying its output both as structured content and as text. */
export function structured<Output extends Record<string, unknown>>(
  output: Output
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/** The error result of a write the control channel chose to fail. */
export function failedOnRequest() {
  return {
    content: [
      { type: "text" as const, text: "Drift Kit failed this write on request" },
    ],
    isError: true,
  };
}
