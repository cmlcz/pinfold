# Run Workflow code in QuickJS compiled to WebAssembly

Workflow and Exploration Run code executes inside QuickJS compiled to WebAssembly (`quickjs-emscripten`), transpiled from TypeScript with `esbuild`, behind a promise-based `sdk.*` bridge with per-run memory, time, and tool-call limits. We chose QuickJS/Wasm over a permission-less Deno subprocess and V8 isolates (`isolated-vm`) for two reasons: it is isolated by construction (guest code has no host access except the bridge functions we inject, which matters when untrusted Tool outputs can prompt-inject the agent), and it installs as pure JavaScript/Wasm via `npm` on any OS, Node version, or CI runner. The trade-off is an interpreter that is much slower than V8 on CPU-bound workloads, which we accept because Workflows spend virtually all of their wall time waiting on Downstream Server I/O.

## Considered Options

- **Deno subprocess with no permissions:** Offers native TypeScript execution and strong debugging ergonomics, but requires an external binary, relies on CLI flags for isolation, and is not recommended by Deno's own documentation as a standalone boundary for untrusted code. It remains our first fallback if CPU-heavy Workflows emerge; the `sdk.*` bridge sits behind an interface so the sandbox runtime can be swapped.
- **`isolated-vm`:** Fast and strongly isolated, but currently in maintenance mode per its README and distributed as a native C++ addon that frequently breaks across major Node upgrades.
- **Node `node:vm`:** Explicitly documented by Node.js as not being a security boundary for untrusted code.

