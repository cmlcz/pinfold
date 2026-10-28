# Pin the CLI drivers' provider through a local proxy, and price calls from OpenRouter's answers

ADR 0006 requires every benchmark run to pin the model and the provider, with fallbacks off. The minimal agent loop sends OpenRouter's `provider` preferences itself, but neither Claude Code nor Codex CLI can add a field to its request body. So the CLI drivers point their base URL at a local proxy (`src/packages/bench/lib/pin-proxy.ts`). The proxy adds `provider: { order: [<provider>], allow_fallbacks: false, require_parameters: true }` to every model call and forwards it to OpenRouter unchanged otherwise.

The proxy also reads each answer as it streams through. OpenRouter ends every answer, from the Messages API and the Responses API alike, with a usage that carries the call's `cost`, and the Messages API names the provider that served it. The driver sums those costs per run. Tokens still come from each CLI's own JSON events, normalized into the harness's `Usage`.

The proxy drops one field: Codex always sends `parallel_tool_calls`. With `require_parameters`, OpenRouter filters out every endpoint that cannot honour it, the pinned DeepInfra endpoint among them. Without `require_parameters`, the endpoint would ignore it silently, along with any other unsupported parameter.

## Considered Options

- **Each CLI's own cost figure.** Rejected: Claude Code prices tokens with Anthropic's price table, whatever model served them, and Codex reports no cost.
- **OpenRouter's generation lookup (`/api/v1/generation?id=`).** Rejected after trying it: some calls that Claude Code made and got a 200 for were never recorded there, so a run's cost could not be completed.
- **A price table times tokens.** Rejected as the source of cost: cached-token discounts and reasoning tokens are priced per provider, and the answer's `cost` already applies them.
- **Turning off `require_parameters` for Codex.** Rejected: it would let the endpoint drop any parameter silently, not only the one known to be unsupported.

## Consequences

- A refused call (4xx) is not charged and is not counted. Claude Code makes some on purpose: it first asks for deferred tool loading, which the endpoint does not support, then falls back.
- A call whose answer carries no cost, such as a stream the CLI broke off, counts as a round trip but adds nothing to the cost. Each run's transcript records how many there were (`unpriced`).
- The Responses API does not name the provider, so Codex runs record only the model that served them. The pin still guarantees the provider, since fallbacks are off.
- Each CLI runs with a fresh configuration directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and with the developer's Claude, Anthropic, Codex and OpenAI variables taken out of its environment, so that no subscription login, setting, plugin or hook takes part in a measured run.
