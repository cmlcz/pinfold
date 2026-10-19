import { defineConfig } from "vitest/config";

// Many tests start Downstream Servers or the CLI as processes of their own,
// and CI runners are slower than a developer's machine.
export default defineConfig({ test: { testTimeout: 30_000 } });
