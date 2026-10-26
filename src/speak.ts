// Spoken replies. Everything local: either the macOS `say` binary with a system
// voice (instant, free) or Kokoro-82M through `uvx` (natural, ~300 MB download).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDirs, STATE, type SpeakSettings } from "./dictate";

export type VoiceQuality = "premium" | "enhanced" | "standard";

export type Voice = {
  name: string;
  locale: string;
  quality: VoiceQuality;
};

const LOCK = join(STATE, "speak.lock");
const KOKORO_MODEL = "mlx-community/Kokoro-82M-bf16";
const KOKORO_VOICES = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_nicole",
  "af_nova",
  "af_sarah",
  "am_adam",
  "am_echo",
  "am_michael",
  "bf_emma",
  "bm_george",
];

let current: ChildProcess | undefined;

const RANK: Record<VoiceQuality, number> = { premium: 0, enhanced: 1, standard: 2 };

/** System voices, best quality first. Premium/Enhanced only exist once downloaded. */
export function listVoices(): Voice[] {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
  const voices: Voice[] = [];
  for (const line of String(result.stdout ?? "").split("\n")) {
    const match = /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\b/.exec(line);
    if (match === null) continue;
    const name = match[1].trim();
    const quality: VoiceQuality = /\(premium\)/i.test(name)
      ? "premium"
      : /\(enhanced\)/i.test(name)
        ? "enhanced"
        : "standard";
    voices.push({ name, locale: match[2], quality });
  }
  return voices.sort(
    (a, b) => RANK[a.quality] - RANK[b.quality] || a.name.localeCompare(b.name),
  );
}

export function kokoroVoices(): string[] {
  return [...KOKORO_VOICES];
}

export function kokoroAvailable(): boolean {
  return spawnSync("sh", ["-c", "command -v uvx"], { encoding: "utf8" }).status === 0;
}

/** Turn markdown into something worth hearing. */
export function toSpeech(raw: string, maxChars: number): string {
  let text = raw
    .replaceAll(/```[\s\S]*?```/gu, " ")
    .replaceAll(/`([^`]*)`/gu, "$1")
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/https?:\/\/\S+/gu, " ")
    .replaceAll(/[*_#>|]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).replace(/\s+\S*$/u, "")}…`;
  }
  return text;
}

function recentlySpoken(hash: string): boolean {
  try {
    const [previous, at] = readFileSync(LOCK, "utf8").split(":");
    return previous === hash && Date.now() - Number(at) < 4000;
  } catch {
    return false;
  }
}

function markSpoken(hash: string): void {
  try {
    ensureDirs();
    writeFileSync(LOCK, `${hash}:${Date.now()}`);
  } catch {
    // a missing lock only costs a duplicate line of speech
  }
}

export function stopSpeaking(): void {
  if (current === undefined) return;
  try {
    current.kill("SIGTERM");
  } catch {
    // already gone
  }
  current = undefined;
}

export function speak(raw: string, settings: SpeakSettings): void {
  if (!settings.enabled) return;
  const text = toSpeech(raw, settings.maxChars);
  if (text.length < 2) return;

  // Several OpenCode processes can host this plugin at once; the lock keeps a
  // single reply from being read out two or three times.
  const hash = createHash("sha1").update(text).digest("hex");
  if (recentlySpoken(hash)) return;
  markSpoken(hash);

  stopSpeaking();

  if (settings.engine === "kokoro") {
    const prefix = join(STATE, "speech");
    const generator = spawn(
      "uvx",
      [
        "--from",
        "mlx-audio",
        "mlx_audio.tts.generate",
        "--model",
        KOKORO_MODEL,
        "--voice",
        settings.voice,
        "--text",
        text,
        "--file_prefix",
        prefix,
      ],
      { stdio: "ignore" },
    );
    current = generator;
    generator.on("exit", (code) => {
      current = undefined;
      if (code !== 0) return;
      for (const candidate of [`${prefix}_000.wav`, `${prefix}.wav`]) {
        if (!existsSync(candidate)) continue;
        current = spawn("afplay", [candidate], { stdio: "ignore" });
        current.on("exit", () => {
          current = undefined;
        });
        return;
      }
    });
    generator.on("error", () => {
      current = undefined;
    });
    return;
  }

  const voice = settings.voice.trim() === "" ? "Samantha" : settings.voice;
  const speaker = spawn("say", ["-v", voice, text], { stdio: "ignore" });
  current = speaker;
  speaker.on("exit", () => {
    current = undefined;
  });
  speaker.on("error", () => {
    current = undefined;
  });
}

/** Read a line out loud so the wizard can demonstrate the chosen voice. */
export function preview(voice: string, engine: SpeakSettings["engine"]): void {
  speak(
    "Hi, this is how I will sound when I read replies out loud.",
    { enabled: true, engine, voice, maxChars: 200 },
  );
}
