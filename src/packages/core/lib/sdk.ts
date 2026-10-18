// The TypeScript face of the SDK: one signature per Tool for search_sdk, and
// the declarations that explore code is type-checked against.
import type { JsonSchema } from "./schema.ts";
import { search } from "./search.ts";

/** What the SDK knows of a Tool: its Baseline once pinned, else its listing. */
export type SdkTool = {
  server: string;
  tool: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
};

function signature(tool: SdkTool): string {
  return `${doc(tool)}sdk.${tool.server}${access(tool.tool)}${method(tool)}`;
}

/** The signatures of the Tools that match a keyword query, best first. */
export function searchTools(tools: SdkTool[], query: string): string[] {
  return search(
    tools.map((tool) => ({ item: signature(tool), text: searchText(tool) })),
    query
  );
}

// The words a Tool is found by; its name counts twice.
function searchText(tool: SdkTool): string {
  const properties = Object.entries(
    (tool.inputSchema.properties as Record<string, JsonSchema> | undefined) ??
      {}
  ).map(([name, field]) => `${name} ${String(field.description ?? "")}`);
  return [
    tool.server,
    tool.tool,
    tool.tool,
    tool.description ?? "",
    ...properties,
  ].join(" ");
}

export function declarations(tools: SdkTool[]): string {
  const servers = new Map<string, SdkTool[]>();
  for (const tool of tools) {
    servers.set(tool.server, [...(servers.get(tool.server) ?? []), tool]);
  }
  const members = [...servers].map(([server, tools]) => {
    const methods = tools.map(
      (tool) => `    ${doc(tool)}${propertyKey(tool.tool)}${method(tool)};`
    );
    return `  ${server}: {\n${methods.join("\n")}\n  };`;
  });
  return `declare const sdk: {\n${members.join("\n")}\n};\n`;
}

function method(tool: SdkTool): string {
  const required = tool.inputSchema.required;
  const optional = !Array.isArray(required) || required.length === 0;
  const args = `args${optional ? "?" : ""}: ${typeOf(tool.inputSchema)}`;
  return `(${args}): Promise<${typeOf(tool.outputSchema)}>`;
}

function doc(tool: SdkTool): string {
  if (!tool.description) return "";
  const text = tool.description.replace(/\s+/g, " ").replaceAll("*/", "*\\/");
  return `/** ${text.trim()} */\n`;
}

/** The TypeScript type a JSON Schema describes; `unknown` where it says nothing. */
function typeOf(schema: JsonSchema | boolean | undefined): string {
  if (schema === undefined || schema === true) return "unknown";
  if (schema === false) return "never";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) return union.map(typeOf).join(" | ");
  if (Array.isArray(schema.allOf)) return schema.allOf.map(typeOf).join(" & ");
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => typeOf({ ...schema, type })).join(" | ");
  }
  switch (schema.type) {
    case "string":
    case "boolean":
    case "null":
      return schema.type;
    case "number":
    case "integer":
      return "number";
    case "array":
      return `${parenthesize(typeOf(schema.items as JsonSchema))}[]`;
    case "object":
      return objectType(schema);
    default:
      return "properties" in schema ? objectType(schema) : "unknown";
  }
}

function objectType(schema: JsonSchema): string {
  const properties = schema.properties as
    Record<string, JsonSchema> | undefined;
  if (properties === undefined) {
    const values = schema.additionalProperties as
      JsonSchema | boolean | undefined;
    return `Record<string, ${values === undefined ? "unknown" : typeOf(values)}>`;
  }
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const fields = Object.entries(properties).map(
    ([name, field]) =>
      `${propertyKey(name)}${required.has(name) ? "" : "?"}: ${typeOf(field)}`
  );
  return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
}

// Wraps a union or intersection so `[]` applies to all of it.
function parenthesize(type: string): string {
  let depth = 0;
  for (const char of type) {
    if ("{[(<".includes(char)) depth++;
    else if ("}])>".includes(char)) depth--;
    else if (depth === 0 && (char === "|" || char === "&")) return `(${type})`;
  }
  return type;
}

const identifier = /^[A-Za-z_$][\w$]*$/;

function propertyKey(name: string): string {
  return identifier.test(name) ? name : JSON.stringify(name);
}

function access(name: string): string {
  return identifier.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}
