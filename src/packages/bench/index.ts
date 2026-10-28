// The benchmark's tasks, run against the Drift Kit.
export {
  benchClassification,
  tasks,
  type Task,
  type TaskInput,
} from "./lib/tasks.ts";
export type { Outcome, Verdict } from "./lib/state.ts";
export {
  formatResults,
  generateGrid,
  runGrid,
  type GridScenario,
  type H2Outcome,
  type H2Result,
} from "./lib/h2.ts";
export { startBench, type Bench } from "./lib/bench.ts";
export {
  openRouterModel,
  runAgent,
  type ChatMessage,
  type ChatModel,
  type ToolSpec,
  type Usage,
} from "./lib/agent.ts";
export {
  parseAnswer,
  runA2,
  runA4,
  type ArmName,
  type RunRecord,
} from "./lib/arms.ts";
export {
  BudgetExceeded,
  budgeted,
  formatSummary,
  runBenchmark,
  type HarnessOptions,
} from "./lib/harness.ts";
export {
  formatLifecycle,
  lifecycleDrift,
  runLifecycle,
  type LifecycleResult,
  type LifecycleRun,
  type ScheduledDrift,
} from "./lib/lifecycle.ts";
