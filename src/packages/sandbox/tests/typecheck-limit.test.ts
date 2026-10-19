// Apart from the other sandbox tests, since it waits out the type check's
// time limit.
import { describe, expect, it } from "vitest";
import { quickJsSandbox } from "../index.ts";

function run(source: string) {
  return quickJsSandbox.run({
    source,
    declarations: "declare const sdk: any;\n",
    input: {},
    sdk: {},
    limits: { timeoutMs: 5000, memoryBytes: 64 * 1024 * 1024, toolCalls: 10 },
  });
}

// Comparing these unions keeps the type checker busy for half a minute.
const slowToCheck = `
type D = "0"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9";
type L = \`\${D}\${D}\${D}\${D}\`;
type M<T extends string> = T extends \`\${infer A}\${infer B}\` ? [A, B] : never;
type X1 = M<L>; type X2 = M<\`a\${L}\`>; type X3 = M<\`b\${L}\`>; type X4 = M<\`c\${L}\`>;
declare const a: X1 | X2; declare let b: X3 | X4;
b = a as any as Exclude<X1 | X2 | X3 | X4, X1>;
export function main() { return 1; }`;

describe("The type check", () => {
  it("stops at its time limit without blocking the host", async () => {
    let longestGap = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      longestGap = Math.max(longestGap, Date.now() - last);
      last = Date.now();
    }, 50);

    const result = await run(slowToCheck);
    clearInterval(ticker);

    expect(result).toEqual({
      ok: false,
      error:
        "TypeCheckError: the type check exceeded its time limit of 10000 ms",
    });
    expect(longestGap).toBeLessThan(1000);
    expect(await run(`export function main() { return 2; }`)).toMatchObject({
      ok: true,
      value: 2,
    });
  });
});
