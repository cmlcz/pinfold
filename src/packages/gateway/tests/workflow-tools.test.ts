import { describe, expect, it } from "vitest";
import { openPlans } from "../../core/index.ts";
import {
  dir,
  client,
  textOf,
  writing,
  saveWorkflow,
  useGateway,
} from "./gateway.ts";

useGateway();

describe("Workflows as their own tools", () => {
  const countIssues = {
    code: `export async function main(input: { project: string }) {
      const { issues } = await sdk.sentry.listIssues(input);
      return issues.length;
    }`,
    input: { project: "web" },
  };

  it("has exactly the fixed tools plus the opted-in Workflows, and none approves a plan", async () => {
    await saveWorkflow(
      "count_issues",
      countIssues,
      'export const settings = { writeBudget: 10, expose: true, description: "Count the issues of a Sentry project" };'
    );
    const pending = await client.callTool({
      name: "run_sandbox",
      arguments: { code: writing },
    });
    const id = /pinfold approve ([0-9a-f]{12})/.exec(textOf(pending))![1]!;

    const { tools } = await client.listTools();
    for (const tool of tools) {
      await client.callTool({
        name: tool.name,
        arguments: { id, plan: id, name: id, approve: true, confirmed: true },
      });
    }

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "count_issues",
      "list_workflows",
      "propose_repair",
      "run_sandbox",
      "run_workflow",
      "save_workflow",
      "search_sdk",
    ]);
    expect((await openPlans(dir).pending()).map((plan) => plan.id)).toEqual([
      id,
    ]);
    expect(tools.find((tool) => tool.name === "count_issues")).toMatchObject({
      description: "Count the issues of a Sentry project",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
      },
    });
  });

  it("runs an opted-in Workflow through its own tool", async () => {
    await saveWorkflow(
      "count_issues",
      countIssues,
      "export const settings = { writeBudget: 10, expose: true };"
    );

    const result = await client.callTool({
      name: "count_issues",
      arguments: { project: "web" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("3");
  });

  it("leaves out a Workflow that did not opt in", async () => {
    await saveWorkflow("count_issues", countIssues);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain("count_issues");
  });

  it("leaves out a Workflow named like a fixed tool, and says so", async () => {
    const stderr: string[] = [];
    await saveWorkflow(
      "search_sdk",
      countIssues,
      "export const settings = { writeBudget: 10, expose: true };",
      { stderr }
    );

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(6);
    expect(stderr.join("")).toContain(
      "pinfold: Workflow search_sdk not exposed as an MCP tool: Tool search_sdk is already registered.\n"
    );
  });
});
