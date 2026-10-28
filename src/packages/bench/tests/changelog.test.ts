import { describe, expect, it } from "vitest";
import { changelogScenarios, programFor, runChangelog } from "../index.ts";

const pick = (read: string, scenario: string) =>
  changelogScenarios.find(
    (entry) => entry.read === read && entry.scenario === scenario
  )!;

describe("H2's changelog set", () => {
  it("reads the scenario's field from every call, mapping over arrays", () => {
    expect(programFor(pick("tags[].commit.sha", "minimal-tag"))).toContain(
      "out.push(r.tags.map((e) => e.commit.sha));"
    );
    expect(programFor(pick("user.html_url", "minimal-issue"))).toContain(
      'for (const args of [{"number":1},{"number":2},{"number":3},{"number":4}])'
    );
  });

  it("repairs a real rename, stops on a dropped field and leaves a kept one alone", async () => {
    const results = await runChangelog([
      pick("user.html_url", "minimal-issue"),
      pick("id", "minimal-issue"),
      pick("user.login", "minimal-issue"),
    ]);

    expect(results.map(({ read, outcome }) => [read, outcome])).toEqual([
      ["user.html_url", "repaired"],
      ["id", "unrepaired"],
      ["user.login", "unaffected"],
    ]);
    expect(results[0]!.detail).toBe(
      '+ {"op":"rename","from":"user.profile_url","to":"user.html_url"}'
    );
  });
});
