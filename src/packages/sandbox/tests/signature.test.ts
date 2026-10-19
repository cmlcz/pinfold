import { describe, expect, it } from "vitest";
import { mainInputSchema } from "../index.ts";

const declarations = "declare const sdk: any;\n";

function schemaOf(source: string) {
  return mainInputSchema(source, declarations);
}

describe("mainInputSchema", () => {
  it("stops where a recursive type refers back to itself", async () => {
    const result = await schemaOf(`type T = { a: T; b: T; c: T; name: string };
      export function main(input: T) {}`);

    expect(result).toEqual({
      ok: true,
      schema: {
        type: "object",
        properties: { a: {}, b: {}, c: {}, name: { type: "string" } },
        required: ["a", "b", "c", "name"],
        additionalProperties: false,
      },
    });
  });

  it("refuses a type too large to check instead of building it", async () => {
    const levels = Array.from(
      { length: 20 },
      (_, n) => `type L${n} = { a: L${n + 1}; b: L${n + 1} };`
    ).join("\n");
    const result = await schemaOf(`${levels}
      type L20 = string;
      export function main(input: L0) {}`);

    expect(result).toEqual({
      ok: false,
      error: "main's input type is too large to check",
    });
  });

  it("describes intersections, template literals and object", async () => {
    const result = await schemaOf(`type Base = { a: string };
      export function main(input: Base & { b: number; id: \`\${string}-x\`; meta: object }) {}`);

    expect(result).toEqual({
      ok: true,
      schema: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "number" },
          id: { type: "string" },
          meta: { type: "object" },
        },
        required: ["a", "b", "id", "meta"],
        additionalProperties: false,
      },
    });
  });

  it("describes tuples, with optional and rest elements", async () => {
    const result = await schemaOf(`export function main(input: {
      pair: [string, number];
      some: [string, number?];
      many: [string, ...number[]];
    }) {}`);

    expect(result.ok && result.schema.properties).toEqual({
      pair: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
        minItems: 2,
        maxItems: 2,
      },
      some: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
        minItems: 1,
        maxItems: 2,
      },
      many: {
        type: "array",
        prefixItems: [{ type: "string" }],
        items: { type: "number" },
        minItems: 1,
      },
    });
  });

  it("refuses types it cannot check rather than accepting any value", async () => {
    expect(
      await schemaOf(`export function main<T>(input: { value: T }) {}`)
    ).toEqual({
      ok: false,
      error: "main's input uses the type T, which cannot be checked",
    });
    expect(
      await schemaOf(`export function main(input: { done: () => void }) {}`)
    ).toEqual({
      ok: false,
      error:
        "main's input uses the function type () => void, which JSON cannot hold",
    });
  });
});
