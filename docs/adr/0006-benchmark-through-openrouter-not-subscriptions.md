# Measure the benchmark through OpenRouter, and use subscriptions only for compatibility checks

pinfold is designed for developers running Claude Code, Codex CLI, and Antigravity CLI on everyday consumer subscriptions. However, our automated benchmark drives Claude Code and Codex CLI through an OpenRouter API key (a documented configuration for both CLIs), alongside a minimal OpenRouter agent loop for additional models. Consumer subscription logins are used only for a small number of manual compatibility runs at ordinary interactive scale.

This separation is required by vendor terms of service:
- **Anthropic's Consumer Terms** prohibit access *"through automated or non-human means … except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it"*.
- **OpenAI's Codex CI guide** advises against using ChatGPT-managed logins *"for public or open-source repositories"*.
- **Google** treats automated third-party harnessing of Antigravity subscriptions as grounds for account suspension.

Running hundreds of scripted benchmark sessions against consumer subscriptions would violate—or at best sit in a grey area of—these terms.

## Consequences

- Every benchmark measurement reports exact token counts and dollar costs (from OpenRouter's `cost` and usage fields) against pinned model snapshots under a hard budget cap.
- Because token consumption depends on the model and agent loop rather than the authentication method, these token figures directly reflect what a subscriber's usage quota would be charged. Accordingly, subscriber-facing comparisons are stated in tokens rather than "tasks per usage window".
- Because Antigravity CLI has no documented OpenRouter integration, it is verified in the client compatibility matrix rather than the automated benchmark.

