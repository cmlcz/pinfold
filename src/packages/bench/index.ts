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
  changelogScenarios,
  formatChangelog,
  programFor,
  runChangelog,
  type ChangelogOutcome,
  type ChangelogResult,
  type ChangelogScenario,
} from "./lib/changelog.ts";
export {
  ModelUnavailable,
  openRouterModel,
  runAgent,
  type ChatMessage,
  type ChatModel,
  type ToolSpec,
  type Usage,
} from "./lib/agent.ts";
export {
  parseAnswer,
  runAgentArm,
  runA4,
  type ArmName,
  type RunRecord,
} from "./lib/arms.ts";
export { openSurface, type AgentArm, type Surface } from "./lib/surface.ts";
export {
  antigravityDriver,
  antigravityOutcome,
  claudeCodeDriver,
  claudeCodeOutcome,
  codexDriver,
  codexOutcome,
  loopDriver,
  type Driver,
  type DriverRun,
} from "./lib/drivers.ts";
export {
  readCall,
  servePinProxy,
  type PinProxy,
  type ProxiedCall,
} from "./lib/pin-proxy.ts";
export {
  BudgetExceeded,
  openBudget,
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
