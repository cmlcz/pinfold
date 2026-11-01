import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openPlans } from "../../core/index.ts";
import {
  dir,
  client,
  type Answer,
  reconnect,
  textOf,
  writing,
  linearWrites,
  saveWorkflow,
  useGateway,
} from "./gateway.ts";

useGateway();

describe("Approval in the client", () => {
  it("asks in a dialog with the Write Plan and applies the plan once approved", async () => {
    const asked: string[] = [];
    await reconnect({
      answer: (message) => {
        asked.push(message);
        return "accept";
      },
    });

    const result = await client.callTool({
      name: "run_sandbox",
      arguments: { code: writing },
    });

    expect(asked).toEqual([
      expect.stringMatching(
        new RegExp(
          [
            String.raw`^Write Plan [0-9a-f]{12}: 1 write, none sent yet`,
            String.raw`  1\. linear\.createIssue \{"title":"Fix totals"\}`,
            "",
            "Approve to send this write now; decline and no run sends this plan\\.$",
          ].join("\n")
        )
      ),
    ]);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(
      /^\["ENG-\d+"\]\n\nApplied Write Plan [0-9a-f]{12}: 1 write sent\./
    );
    expect(await openPlans(dir).pending()).toEqual([]);
  });

  it("never sends a plan the developer declines in the dialog", async () => {
    await reconnect({ answer: () => "decline" });

    const result = await client.callTool({
      name: "run_sandbox",
      arguments: { code: writing },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(
      /^The developer declined Write Plan [0-9a-f]{12} in the Approval dialog, so nothing was sent\./
    );
    const id = /Write Plan ([0-9a-f]{12})/.exec(textOf(result))![1]!;
    await expect(openPlans(dir).approve(id)).rejects.toThrow(
      `Write Plan ${id} is declined, not pending`
    );
    expect(await linearWrites()).toEqual([]);
  });

  it("leaves the plan pending when the developer closes the dialog", async () => {
    await reconnect({ answer: () => "cancel" });

    const result = await client.callTool({
      name: "run_sandbox",
      arguments: { code: writing },
    });

    const id = /pinfold approve ([0-9a-f]{12})/.exec(textOf(result))![1]!;
    expect(textOf(result)).toMatch(
      /^The developer closed the Approval dialog without deciding, so nothing was sent\./
    );
    expect((await openPlans(dir).pending()).map((plan) => plan.id)).toEqual([
      id,
    ]);
    expect(await linearWrites()).toEqual([]);
  });

  it("applies a plan the developer approved in a terminal while the dialog was open", async () => {
    await reconnect({
      answer: async (message): Promise<Answer> => {
        const id = /^Write Plan ([0-9a-f]{12})/.exec(message)![1]!;
        await openPlans(dir).approve(id);
        return "accept";
      },
    });

    const result = await client.callTool({
      name: "run_sandbox",
      arguments: { code: writing },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(
      /\n\nApplied Write Plan [0-9a-f]{12}: 1 write sent\./
    );
  });

  it("asks again when the plan changed after the developer approved it", async () => {
    const asked: string[] = [];
    await saveWorkflow("file_issue", { code: writing }, undefined, {
      answer: async (message): Promise<Answer> => {
        asked.push(message);
        if (asked.length > 1) return "decline";
        const file = join(dir, ".workflows", "file_issue.ts");
        const source = await readFile(file, "utf8");
        await writeFile(file, source.replace("Fix totals", "Fix sums"));
        return "accept";
      },
    });

    const result = await client.callTool({
      name: "run_workflow",
      arguments: { name: "file_issue" },
    });

    expect(asked).toEqual([
      expect.stringMatching(/^Paused for Approval: .*Fix totals/s),
      expect.stringMatching(/^Paused for Approval: .*Fix sums/s),
    ]);
    const second = /Write Plan ([0-9a-f]{12})/.exec(asked[1]!)![1]!;
    expect(textOf(result)).toMatch(
      new RegExp(
        `^The developer declined Write Plan ${second} in the Approval dialog`
      )
    );
    expect(await linearWrites()).toEqual([]);
  });

  it("points to the terminal when the client can show no form dialog", async () => {
    await reconnect({
      capabilities: { elicitation: { url: {} } },
      answer: () => {
        throw new Error("asked for a form");
      },
    });

    const result = await client.callTool({
      name: "run_sandbox",
      arguments: { code: writing },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("pinfold approve ");
  });
});
