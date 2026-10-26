// Runs the CLI as a developer at an interactive terminal would: `script`
// gives it a pseudo-terminal, and its confirmation is answered once asked.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));

export async function pinfoldInTerminal(
  args: string[],
  answer = "yes"
): Promise<{ code: number; output: string }> {
  const command = [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    bin,
    ...args,
  ];
  // BSD script takes the command as arguments, util-linux script as a
  // string. It needs a pipe for input, not the socket Node gives a child on
  // macOS, so cat passes the input on.
  const script =
    process.platform === "darwin"
      ? `script -q /dev/null ${command.map(quote).join(" ")}`
      : `script -qec ${quote(command.map(quote).join(" "))} /dev/null`;
  const child = spawn("sh", ["-c", `cat | ${script}`]);
  let output = "";
  let asked = false;
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    // Answered only once asked: input that arrives earlier is lost.
    if (!asked && output.includes("Type yes to confirm")) {
      asked = true;
      // Ending the input also ends cat, which sh waits for.
      child.stdin.end(`${answer}\n`);
    }
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  const [code] = (await once(child, "exit")) as [number | null];
  clearTimeout(timer);
  return {
    code: code ?? 1,
    output: stripVTControlCharacters(output).replaceAll("\r", ""),
  };
}

function quote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
