// Core of the plugin: builds the native helper, manages the recording process,
// and reads the transcript files it produces. No UI in here.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = (import.meta as { dir?: string }).dir ?? dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

export const ROOT = join(homedir(), ".config", "opencode", "voice-like-claude");
const LEGACY_ROOT = join(homedir(), ".config", "opencode", "voice-dictation");
export const NATIVE = join(ROOT, "native");
export const BIN = join(ROOT, "bin", "dictate");
export const SETTINGS = join(ROOT, "settings.json");
export const STATE = join(process.env.TMPDIR ?? tmpdir(), "opencode-voice-like-claude");
export const OUT = join(STATE, "out");
export const LIVE = join(STATE, "live");
export const LEVEL = join(STATE, "level");
export const ERR = join(STATE, "err");
export const PID = join(STATE, "pid");
const DEBUG = join(STATE, "debug.log");

export type SpeakSettings = {
  enabled: boolean;
  engine: "say" | "kokoro";
  voice: string;
  maxChars: number;
};

export type Settings = {
  locale: string;
  holdMs: number;
  silenceStop: number;
  maxSeconds: number;
  chord: string;
  spaceHold: boolean;
  speak: SpeakSettings;
};

export const DEFAULT_SETTINGS: Settings = {
  locale: "en-US",
  holdMs: 700,
  silenceStop: 2.5,
  maxSeconds: 600,
  chord: "ctrl+shift+v",
  spaceHold: true,
  speak: {
    enabled: false,
    engine: "say",
    voice: "Samantha",
    maxChars: 700,
  },
};

export function ensureDirs(): void {
  for (const dir of [ROOT, NATIVE, join(ROOT, "bin"), STATE]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Carry settings over from the pre-rename install location so an upgrade does
 * not silently drop the user's language, chord and voice choices.
 */
export function migrateLegacySettings(): void {
  try {
    if (existsSync(SETTINGS)) return;
    const previous = join(LEGACY_ROOT, "settings.json");
    if (!existsSync(previous)) return;
    ensureDirs();
    copyFileSync(previous, SETTINGS);
  } catch {
    // a lost migration is recoverable by re-running /voice setup
  }
}

export function debug(message: string): void {
  try {
    ensureDirs();
    appendFileSync(DEBUG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break dictation
  }
}

export function loadSettings(): Settings {
  migrateLegacySettings();
  try {
    const raw = JSON.parse(readFileSync(SETTINGS, "utf8")) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      speak: { ...DEFAULT_SETTINGS.speak, ...(raw.speak ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  ensureDirs();
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

export function readTrim(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function truncate(path: string): void {
  try {
    writeFileSync(path, "");
  } catch {
    // ignore
  }
}

export function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runningPid(): number | undefined {
  const pid = Number.parseInt(readTrim(PID), 10);
  if (!Number.isFinite(pid) || pid <= 1) return undefined;
  return isAlive(pid) ? pid : undefined;
}

function run(bin: string, args: string[], options: { timeout?: number } = {}) {
  return spawnSync(bin, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 240_000,
  });
}

/** macOS version, e.g. "26.6.2"; undefined when not on macOS. */
export function macOSVersion(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = run("sw_vers", ["-productVersion"], { timeout: 10_000 });
  const version = (result.stdout ?? "").trim();
  return version === "" ? undefined : version;
}

export function majorOf(version: string | undefined): number {
  const major = Number.parseInt((version ?? "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

export function findSwiftc(): string | undefined {
  const result = run("xcrun", ["--find", "swiftc"], { timeout: 30_000 });
  if (result.status !== 0) return undefined;
  const path = (result.stdout ?? "").trim();
  return path === "" ? undefined : path;
}

function stageSources(): void {
  ensureDirs();
  for (const name of ["dictate.swift", "Info.plist"]) {
    const from = join(PACKAGE_ROOT, "assets", name);
    const to = join(NATIVE, name);
    if (!existsSync(from)) throw new Error(`missing packaged asset: ${from}`);
    if (!existsSync(to) || readTrim(from).length !== readTrim(to).length) {
      copyFileSync(from, to);
    }
  }
}

export type BuildResult = { ok: boolean; output: string };

export function binaryIsStale(): boolean {
  if (!existsSync(BIN)) return true;
  try {
    const built = statSync(BIN).mtimeMs;
    const source = statSync(join(PACKAGE_ROOT, "assets", "dictate.swift")).mtimeMs;
    return source > built;
  } catch {
    return true;
  }
}

/** Compile the Swift helper. Safe to call repeatedly; a no-op when up to date. */
export function build(force = false): BuildResult {
  if (!force && !binaryIsStale()) return { ok: true, output: "up to date" };

  let swiftc: string | undefined;
  try {
    swiftc = findSwiftc();
  } catch (error) {
    return { ok: false, output: String(error) };
  }
  if (swiftc === undefined) {
    return {
      ok: false,
      output:
        "Xcode command line tools not found. Install them with `xcode-select --install` and try again.",
    };
  }

  try {
    stageSources();
  } catch (error) {
    return { ok: false, output: String(error) };
  }

  const sdk = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { timeout: 30_000 });
  const sdkPath = (sdk.stdout ?? "").trim();
  if (sdk.status !== 0 || sdkPath === "") {
    return {
      ok: false,
      output:
        "No macOS SDK found. Install the command line tools with `xcode-select --install` and try again.",
    };
  }

  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const result = run(swiftc, [
    "-O",
    "-sdk",
    sdkPath,
    "-target",
    `${arch}-apple-macosx26.0`,
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    join(NATIVE, "Info.plist"),
    join(NATIVE, "dictate.swift"),
    "-o",
    BIN,
  ]);

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || !existsSync(BIN)) {
    debug(`build failed: ${output}`);
    return { ok: false, output: output === "" ? "swiftc failed" : output };
  }
  debug("build ok");
  return { ok: true, output: output === "" ? "compiled" : output };
}

export type LocaleInfo = { supported: string[]; installed: string[] };

export function locales(): LocaleInfo {
  if (!existsSync(BIN)) return { supported: [], installed: [] };
  const result = run(BIN, ["locales", "--json"], { timeout: 60_000 });
  try {
    const parsed = JSON.parse((result.stdout ?? "").trim()) as LocaleInfo;
    return {
      supported: parsed.supported ?? [],
      installed: parsed.installed ?? [],
    };
  } catch {
    debug(`locales parse failed: ${(result.stdout ?? "").slice(0, 200)}`);
    return { supported: [], installed: [] };
  }
}

/** Download the on-device model for a locale. Blocks until finished. */
export function installLocale(locale: string): BuildResult {
  const result = run(BIN, ["install", "--locale", locale], { timeout: 900_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

export type ListenOptions = { locale: string; silenceStop: number; maxSeconds: number };

export async function start(options: ListenOptions): Promise<{ ok: boolean; error?: string }> {
  ensureDirs();
  truncate(OUT);
  truncate(ERR);
  truncate(LIVE);
  truncate(LEVEL);

  const child = spawn(
    BIN,
    [
      "listen",
      "--locale",
      options.locale,
      "--stream",
      LIVE,
      "--silence-stop",
      String(options.silenceStop),
      "--max-seconds",
      String(options.maxSeconds),
      "--level",
      LEVEL,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const out = [];
  let stderr = "";
  child.stdout?.on("data", (chunk) => out.push(String(chunk)));
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("close", () => {
    try {
      writeFileSync(OUT, out.join(""));
    } catch {
      // the transcript is also mirrored into LIVE while streaming
    }
  });
  child.on("error", (error) => {
    stderr += String(error);
  });

  if (child.pid === undefined) return { ok: false, error: "failed to spawn dictate" };
  writeFileSync(PID, String(child.pid));
  live.children.set(child.pid, child);

  const failure = await waitForStartupFailure(child.pid);
  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true };
}

/** Give the helper a moment to fail (bad locale, denied microphone). */
function waitForStartupFailure(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (isAlive(pid)) {
        resolve(undefined);
        return;
      }
      const error = readTrim(ERR);
      resolve(error === "" ? "dictate exited immediately" : error);
    }, 900);
  });
}

export function stop(): Promise<string> {
  const pid = runningPid();
  if (pid === undefined) {
    truncate(PID);
    return Promise.resolve(readTrim(OUT) || readTrim(LIVE));
  }

  return new Promise((resolve) => {
    const child = live.children.get(pid);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      live.children.delete(pid);
      try {
        writeFileSync(PID, "");
      } catch {
        // ignore
      }
      resolve(readTrim(OUT) || readTrim(LIVE));
    };

    const timer = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      setTimeout(finish, 200);
    }, 15_000);

    if (child !== undefined) {
      child.once("close", () => {
        clearTimeout(timer);
        setTimeout(finish, 60);
      });
    } else {
      const poll = setInterval(() => {
        if (!isAlive(pid)) {
          clearInterval(poll);
          clearTimeout(timer);
          finish();
        }
      }, 60);
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/** Children by pid — keeps the pipe alive so stdout is captured reliably. */
const live = { children: new Map<number, ReturnType<typeof spawn>>() };

export function level(): number {
  const value = Number.parseFloat(readTrim(LEVEL));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function reconcileEnvironment(): { ready: boolean; problems: string[] } {
  const problems: string[] = [];
  const version = macOSVersion();
  if (version === undefined) {
    problems.push("macOS only — SpeechAnalyzer is an Apple framework");
  } else if (majorOf(version) < 26) {
    problems.push(`macOS 26 or newer required (found ${version})`);
  }
  if (findSwiftcSafe() === undefined) {
    problems.push("Xcode command line tools missing (xcode-select --install)");
  }
  return { ready: problems.length === 0, problems };
}

function findSwiftcSafe(): string | undefined {
  try {
    return findSwiftc();
  } catch {
    return undefined;
  }
}
