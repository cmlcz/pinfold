// Reading and writing the project's files: the committed .workflows/ and
// the git-ignored state directory .pinfold/.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as z from "zod";

/** A file's text, or undefined when it does not exist. */
export async function readOrNone(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A JSON file's value; an error names the file. */
export async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * A JSON file's value, read by a schema; undefined when the file does not
 * exist, is not JSON or does not fit, so a damaged file reads as none.
 */
export async function readParsed<T>(
  path: string,
  schema: z.ZodType<T>
): Promise<T | undefined> {
  const text = await readOrNone(path);
  const parsed = schema.safeParse(text && safeJson(text));
  return parsed.success ? parsed.data : undefined;
}

/** A text's JSON value, or undefined when it is not JSON. */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The files of a directory; none when it does not exist. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** The JSON files of a directory; none when it does not exist. */
export async function listJson(dir: string): Promise<string[]> {
  return (await listFiles(dir)).filter((file) => file.endsWith(".json"));
}

/**
 * Creates the state directory, and a directory in it, if they do not exist.
 * Returns the directory's path.
 */
export async function prepareState(root: string, dir = ""): Promise<string> {
  const state = join(root, ".pinfold");
  await mkdir(join(state, dir), { recursive: true });
  // Nothing in the state directory belongs in version control.
  await writeFile(join(state, ".gitignore"), "*\n");
  return join(state, dir);
}
