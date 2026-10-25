import { defineConfig } from "vitest/config";

// Many tests start Downstream Servers or the CLI as processes of their own,
// and CI runners are slower than a developer's machine. No test may reach
// a Repair Model through the developer's own key.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    env: { OPENROUTER_API_KEY: "", PINFOLD_REPAIR_MODEL: "" },
  },
});
