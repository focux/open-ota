import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Platform = "ios" | "android";

/** Runs a command in `cwd` and returns its stdout. Injectable so tests can stub the Expo CLI. */
export type Run = (command: string, args: ReadonlyArray<string>, cwd: string) => Promise<string>;

export const run: Run = async (command, args, cwd) => {
  const { stdout } = await execFileAsync(command, [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

export const exportProject = (run: Run, projectDir: string, distDir: string, platforms: ReadonlyArray<Platform>) =>
  run(
    "npx",
    ["expo", "export", ...platforms.flatMap((platform) => ["--platform", platform]), "--output-dir", distDir],
    projectDir,
  );

export const publicConfig = async (run: Run, projectDir: string): Promise<Record<string, unknown>> => {
  const stdout = await run("npx", ["expo", "config", "--type", "public", "--json"], projectDir);
  // The Expo CLI prints progress lines around the JSON document.
  const json = stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
  if (json === "") {
    throw new Error("expo config --type public --json printed no JSON.");
  }
  return JSON.parse(json) as Record<string, unknown>;
};

export const resolveRuntimeVersion = async (run: Run, projectDir: string, platform: Platform): Promise<string> => {
  const stdout = await run("npx", ["expo-updates", "runtimeversion:resolve", "--platform", platform], projectDir);
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1) ?? "";
  const parsed = JSON.parse(last) as { runtimeVersion?: unknown };
  if (typeof parsed.runtimeVersion !== "string") {
    throw new Error(`Could not resolve the ${platform} runtime version from: ${last}`);
  }
  return parsed.runtimeVersion;
};

export const gitCommit = async (run: Run, projectDir: string): Promise<string | undefined> => {
  try {
    return (await run("git", ["rev-parse", "HEAD"], projectDir)).trim();
  } catch {
    return undefined;
  }
};

// Who to credit the publish to: OTA_ACTOR wins, else the commit author.
export const actor = async (run: Run, projectDir: string): Promise<string | undefined> => {
  const fromEnv = process.env["OTA_ACTOR"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return (await run("git", ["log", "-1", "--format=%ae"], projectDir)).trim() || undefined;
  } catch {
    return undefined;
  }
};
