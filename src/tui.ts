// On-device dictation for the OpenCode TUI.
//
// Hold space (or ctrl+shift+v) to talk. The transcript is streamed into the
// prompt footer and pasted into the composer when you stop. Everything runs
// locally through macOS 26 SpeechAnalyzer — no API key, no network.
//
// Run `/voice setup` for the wizard; it compiles the helper, downloads the
// locale model, and checks microphone access.

import { spawn } from "node:child_process";
import {
  build,
  debug,
  DEFAULT_SETTINGS,
  installLocale,
  level as readLevel,
  locales,
  loadSettings,
  macOSVersion,
  majorOf,
  OUT,
  readTrim,
  reconcileEnvironment,
  LIVE,
  runningPid,
  saveSettings,
  start,
  stop,
  type Settings,
} from "./dictate";
import {
  kokoroAvailable,
  kokoroVoices,
  listVoices,
  preview,
  speak,
  stopSpeaking,
} from "./speak";
import * as Plugin from "@opencode/plugin/tui/plugin";
import { buildKittyKeyboardFlags } from "@opentui/core";
import { createDynamic, type TextProps } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";

debug("tui module evaluated");

const METER_SEGMENTS = 7;
const METER_COLORS = [
  "#3fb950",
  "#3fb950",
  "#3fb950",
  "#3fb950",
  "#d29922",
  "#d29922",
  "#f85149",
];
const METER_BLOCKS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "darwin" ? "pbcopy" : "xclip";
    const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(text);
  });
}

export default Plugin.define({
  id: "opencode-voice-like-claude.tui",
  setup(ctx) {
    debug("tui setup start");
    const ui = ctx.ui;
    const settingsPath = (): Settings => current;
    let current: Settings = loadSettings();
    let recording = false;
    let busy = false;
    let held = false;
    let poll: ReturnType<typeof setInterval> | undefined;

    const [preview, setPreview] = ctx.storage.memory("preview", { initial: { text: "" } });
    const [meter, setMeter] = ctx.storage.memory("meter", { initial: { level: 0, active: false } });

    function focusedSession(sessionID: string): boolean {
      const route = ctx.ui.router.current();
      const params = (route as { params?: { sessionID?: string } }).params;
      return route.name === "session" && params?.sessionID === sessionID;
    }

    let pendingSpeech: { sessionID: string; text: string } | undefined;

    ctx.event.on("session.next.text.ended", (event) => {
      if (!current.speak.enabled) return;
      const { properties } = event as unknown as {
        properties: { sessionID: string; text: string };
      };
      if (!focusedSession(properties.sessionID)) return;
      pendingSpeech =
        pendingSpeech !== undefined && pendingSpeech.sessionID === properties.sessionID
          ? { sessionID: properties.sessionID, text: `${pendingSpeech.text} ${properties.text}` }
          : { sessionID: properties.sessionID, text: properties.text };
    });

    // Speak once the reply is finished, not at every text segment.
    ctx.event.on("session.idle", (event) => {
      const { properties } = event as unknown as { properties: { sessionID: string } };
      if (pendingSpeech === undefined || pendingSpeech.sessionID !== properties.sessionID) return;
      const text = pendingSpeech.text;
      pendingSpeech = undefined;
      speak(text, current.speak);
    });

    function notify(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
      ui.toast.show({ message, variant });
    }

    // ---- live feedback -----------------------------------------------------

    ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const props = {
          height: 1,
          minWidth: 0,
          flexShrink: 1,
          wrapMode: "none",
          truncate: true,
          get children() {
            return preview.text;
          },
        } satisfies TextProps;
        return createDynamic(() => (input.mode === "normal" && preview.text ? "text" : undefined), props);
      },
    });

    ui.slot({
      append: "prompt.footer",
      render: (input) => {
        const props = {
          height: 1,
          minWidth: 0,
          flexShrink: 0,
          wrapMode: "none",
          get children() {
            const clamped = Math.max(0, Math.min(1, meter.level));
            const block = METER_BLOCKS[Math.min(METER_BLOCKS.length - 1, Math.round(clamped * 7))];
            return Array.from({ length: METER_SEGMENTS }, (_, index) => {
              const span = jsx("span", { children: block }) as unknown as { fg: string };
              // Solid's spread ignores `fg` on text spans; assigning works.
              span.fg = METER_COLORS[index] ?? METER_COLORS[0];
              return span;
            });
          },
        } satisfies TextProps;
        return createDynamic(() => (input.mode === "normal" && meter.active ? "text" : undefined), props);
      },
    });

    debug("tui slots registered");

    function setLiveText(text: string): void {
      const flat = text.replaceAll(/\s+/gu, " ").trim();
      setPreview((draft) => {
        draft.text = flat.length > 96 ? `…${flat.slice(-96)}` : flat;
      });
    }

    function clearFeedback(): void {
      setPreview((draft) => {
        draft.text = "";
      });
      setMeter((draft) => {
        draft.active = false;
        draft.level = 0;
      });
    }

    function clearTimer(): void {
      if (poll !== undefined) {
        clearInterval(poll);
        poll = undefined;
      }
    }

    // ---- transcription lifecycle ------------------------------------------

    function deliver(text: string): void {
      const value = text.trim();
      if (value === "") {
        notify("No speech detected", "warning");
        return;
      }
      void copyToClipboard(value)
        .catch(() => undefined)
        .then(() => {
          const keymap = ctx.keymap as unknown as {
            dispatch?: (id: string) => unknown;
            dispatchCommand?: (id: string) => unknown;
          };
          const dispatch =
            typeof keymap.dispatch === "function"
              ? keymap.dispatch
              : typeof keymap.dispatchCommand === "function"
                ? keymap.dispatchCommand
                : undefined;
          if (dispatch === undefined) {
            notify("Transcription copied — paste it into the composer", "warning");
            return;
          }
          try {
            dispatch.call(ctx.keymap, "prompt.paste");
          } catch {
            notify("Transcription copied — paste it into the composer", "warning");
          }
        });
    }

    async function finish(): Promise<void> {
      recording = false;
      held = false;
      clearTimer();
      try {
        const text = await stop();
        clearFeedback();
        deliver(text);
      } catch (error) {
        clearFeedback();
        notify(`Voice error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }

    async function begin(): Promise<void> {
      // Don't let the microphone hear the reply being read aloud.
      stopSpeaking();
      const settings = settingsPath();
      const built = build();
      if (!built.ok) {
        notify("Dictation helper not available — run /voice setup", "warning");
        return;
      }
      const started = await start({
        locale: settings.locale,
        silenceStop: settings.silenceStop,
        maxSeconds: settings.maxSeconds,
      });
      if (!started.ok) {
        notify(started.error ?? "Could not start recording", "error");
        return;
      }
      recording = true;
      setLiveText("");
      setMeter((draft) => {
        draft.active = true;
        draft.level = 0;
      });
      poll = setInterval(() => {
        const live = readTrim(LIVE);
        setLiveText(live);
        setMeter((draft) => {
          draft.active = true;
          draft.level = readLevel();
        });
        if (runningPid() === undefined) {
          // the helper stopped itself (silence or max duration)
          const text = readTrim(OUT) || live;
          recording = false;
          held = false;
          clearTimer();
          clearFeedback();
          deliver(text);
        }
      }, 90);
    }

    async function toggle(): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        if (recording) {
          await finish();
          return;
        }
        const environment = reconcileEnvironment();
        if (!environment.ready) {
          notify(environment.problems.join("; "), "warning");
          if (await ui.dialog.confirm({ title: "Dictation setup", message: "Run the setup wizard now?" })) {
            await wizard();
          }
          return;
        }
        await begin();
      } finally {
        busy = false;
      }
    }

    // ---- setup wizard ------------------------------------------------------

    async function pickSystemVoice(): Promise<string | undefined> {
      const voices = listVoices();
      if (voices.length === 0) {
        await ui.dialog.alert({
          title: "No voices",
          message: "macOS reported no system voices. Install one in System Settings.",
        });
        return undefined;
      }
      const options = voices.slice(0, 80).map((voice) => ({
        title: voice.quality === "standard" ? voice.name : `${voice.name} · ${voice.quality}`,
        value: voice.name,
        description: voice.locale,
      }));
      // Put voices in the dictation language first.
      const language = current.locale.slice(0, 2);
      options.sort((a, b) => {
        const left = a.description.startsWith(language) ? 0 : 1;
        const right = b.description.startsWith(language) ? 0 : 1;
        return left - right;
      });
      const picked = await ui.dialog.select({
        title: "Voice",
        options,
        current: current.speak.voice,
        // Live sample while scrolling — `say` starts in ~50 ms and any in-flight
        // sample is killed first, so each row speaks for itself.
        onMove: (option: { value?: unknown }) => {
          if (typeof option?.value === "string") preview(option.value, "say");
        },
      } as Parameters<typeof ui.dialog.select>[0]);
      if (picked !== undefined) {
        const chosen = voices.find((voice) => voice.name === picked);
        if (chosen !== undefined && chosen.quality === "standard") {
          await ui.dialog.alert({
            title: "Better voices are free",
            message:
              "This is a compact system voice. Premium and Enhanced voices sound far better and cost nothing:\n\nSystem Settings › Accessibility › Spoken Content › System Voice › Manage Voices\n\nDownload one, then run /voice setup again to pick it.",
          });
        }
      }
      return picked;
    }

    async function pickKokoro(): Promise<string | undefined> {
      const voices = kokoroVoices();
      return ui.dialog.select({
        title: "Kokoro voice",
        options: voices.map((voice) => ({ title: voice, value: voice })),
        current: current.speak.voice,
      });
    }

    async function wizard(): Promise<void> {
      const version = macOSVersion();
      if (version === undefined || majorOf(version) < 26) {
        await ui.dialog.alert({
          title: "Unsupported system",
          message:
            version === undefined
              ? "Dictation requires macOS 26 or newer."
              : `Dictation requires macOS 26 or newer. This Mac runs ${version}.`,
        });
        return;
      }

      notify("Compiling the speech helper (first run only)…");
      const built = build(true);
      if (!built.ok) {
        await ui.dialog.alert({
          title: "Compile failed",
          message: `${built.output}\n\nInstall the command line tools with:\n  xcode-select --install`,
        });
        return;
      }

      const available = locales();
      if (available.supported.length === 0) {
        await ui.dialog.alert({
          title: "No locales",
          message: "SpeechAnalyzer reported no supported locales on this system.",
        });
        return;
      }

      const options = available.supported.map((locale) => ({
        title: available.installed.includes(locale) ? `${locale}  ✓ installed` : locale,
        value: locale,
      }));
      const picked = await ui.dialog.select({
        title: "Dictation language",
        options,
        current: available.installed.includes(current.locale) ? current.locale : "en-US",
      });
      if (picked === undefined) return;

      if (!available.installed.includes(picked)) {
        notify(`Downloading the ${picked} speech model…`);
        const installed = installLocale(picked);
        if (!installed.ok) {
          await ui.dialog.alert({
            title: "Model download failed",
            message: installed.output === "" ? "Asset installation failed." : installed.output,
          });
          return;
        }
      }
      current = { ...current, locale: picked };

      const wantsSpace = await ui.dialog.confirm({
        title: "Hold to talk",
        message: `Hold space for ${Math.round(current.holdMs / 100) / 10}s to start dictating, release to stop?`,
      });
      current = { ...current, spaceHold: wantsSpace };

      if (!wantsSpace) {
        const chord = await ui.dialog.prompt({
          title: "Shortcut",
          value: current.chord,
          placeholder: "ctrl+shift+v",
        });
        if (chord !== undefined && chord.trim() !== "") current = { ...current, chord: chord.trim() };
      }

      const wantsVoice = await ui.dialog.confirm({
        title: "Read replies aloud",
        message: "Should I speak my replies with a local voice? Nothing leaves this Mac.",
      });
      if (wantsVoice) {
        const engine = await ui.dialog.select<"say" | "kokoro">({
          title: "Voice engine",
          current: current.speak.engine,
          options: [
            { title: "Apple system voice (instant, no download)", value: "say" },
            {
              title: kokoroAvailable()
                ? "Kokoro-82M (most natural, downloads ~300 MB)"
                : "Kokoro-82M (requires uvx — not installed)",
              value: "kokoro",
              disabled: !kokoroAvailable(),
            },
          ],
        });
        if (engine !== undefined) {
          const voice = engine === "kokoro" ? await pickKokoro() : await pickSystemVoice();
          if (voice !== undefined) {
            current = { ...current, speak: { ...current.speak, enabled: true, engine, voice } };
            preview(voice, engine);
          }
        }
      } else {
        current = { ...current, speak: { ...current.speak, enabled: false } };
      }

      saveSettings(current);

      notify("Checking microphone…");
      const probe = await start({ locale: current.locale, silenceStop: 1, maxSeconds: 1 });
      if (!probe.ok) {
        await ui.dialog.alert({
          title: "Microphone not available",
          message: `${probe.error ?? "Unknown error"}\n\nGrant microphone access to your terminal in\nSystem Settings › Privacy & Security › Microphone, then run /voice setup again.`,
        });
        return;
      }
      await stop();

      await ui.dialog.alert({
        title: "Dictation ready",
        message: [
          `Language: ${current.locale}`,
          `Hold: ${current.spaceHold ? "space" : current.chord}`,
          "",
          "Press and hold to talk, release to send the transcript into the prompt.",
          "Silence stops the recording automatically.",
        ].join("\n"),
      });
      notify("Dictation ready — hold space to talk", "success");
    }

    async function status(): Promise<void> {
      const available = locales();
      const environment = reconcileEnvironment();
      const lines = [
        `platform: ${environment.ready ? "ready" : environment.problems.join("; ")}`,
        `language: ${current.locale}${available.installed.includes(current.locale) ? " (installed)" : " (model not downloaded)"}`,
        `hold: ${current.spaceHold ? `space ${current.holdMs}ms` : current.chord}`,
        `silence stop: ${current.silenceStop}s`,
        `installed models: ${available.installed.join(", ") || "none"}`,
        `helper: ${built() ? "compiled" : "not compiled"}`,
        `read aloud: ${
          current.speak.enabled
            ? `${current.speak.voice} (${current.speak.engine})`
            : "off"
        }`,
      ];
      await ui.dialog.alert({ title: "Dictation status", message: lines.join("\n") });
    }

    function built(): boolean {
      return build().ok;
    }

    // ---- key handling ------------------------------------------------------

    type RendererLike = {
      enableKittyKeyboard?: (flags?: number) => void;
      keyInput?: {
        on: (event: string, cb: (key: unknown) => void) => void;
        processParsedKey?: (key: unknown) => void;
      };
    };
    const renderer = ctx.renderer as unknown as RendererLike;
    const keys = renderer?.keyInput;
    let releaseSupported = false;
    let spaceHeld = false;
    let spaceEvent: unknown;
    let spaceTimer: ReturnType<typeof setTimeout> | undefined;
    let reemitting = false;

    function reemit(event: unknown): void {
      if (event === undefined || keys?.processParsedKey === undefined) return;
      reemitting = true;
      try {
        keys.processParsedKey(event);
      } catch {
        // lose one space rather than break typing
      } finally {
        reemitting = false;
      }
    }

    try {
      renderer.enableKittyKeyboard?.(
        buildKittyKeyboardFlags({ disambiguate: true, alternateKeys: true, events: true }),
      );

      keys?.on("keyrelease", (key) => {
        releaseSupported = true;
        const pressed = key as { name?: unknown; ctrl?: boolean; shift?: boolean };
        const name = String(pressed.name ?? "").toLowerCase();

        if (name === "space") {
          if (!spaceHeld) return;
          spaceHeld = false;
          if (spaceTimer !== undefined) {
            clearTimeout(spaceTimer);
            spaceTimer = undefined;
          }
          if (recording) {
            void finish();
          } else {
            reemit(spaceEvent);
          }
          spaceEvent = undefined;
          return;
        }

        if (!held) return;
        const chord = current.chord.toLowerCase();
        const wantsCtrl = chord.includes("ctrl");
        const wantsShift = chord.includes("shift");
        const expected = chord.split("+").at(-1) ?? "";
        if (name !== expected) return;
        if (Boolean(pressed.ctrl) !== wantsCtrl || Boolean(pressed.shift) !== wantsShift) return;
        held = false;
        if (recording) void finish();
      });

      keys?.on("keypress", (key) => {
        if (reemitting || !releaseSupported || !current.spaceHold) return;
        const pressed = key as {
          name?: unknown;
          ctrl?: boolean;
          meta?: boolean;
          option?: boolean;
          super?: boolean;
          preventDefault?: () => void;
          stopPropagation?: () => void;
        };
        if (String(pressed.name ?? "").toLowerCase() !== "space") return;
        if (pressed.ctrl || pressed.meta || pressed.option || pressed.super) return;

        pressed.preventDefault?.();
        pressed.stopPropagation?.();

        if (recording || spaceHeld) return;
        spaceHeld = true;
        spaceEvent = key;
        spaceTimer = setTimeout(() => {
          spaceTimer = undefined;
          if (!spaceHeld) return;
          void toggle();
        }, current.holdMs);
      });
    } catch {
      // no Kitty keyboard support — the keybind and silence stop still work
    }

    // ---- commands ----------------------------------------------------------

    debug("tui registering commands");

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "voice.record",
          title: "Voice: dictate into the prompt",
          description: `Hold ${current.spaceHold ? "space" : current.chord} to talk`,
          group: "Voice",
          bind: current.spaceHold ? "ctrl+shift+v" : current.chord,
          palette: true,
          run: toggle,
        },
        {
          id: "voice",
          title: "Voice: dictate or configure",
          description: "Hold to talk · /voice setup",
          group: "Voice",
          slash: { name: "voice", arguments: true },
          run: async (args = "") => {
            switch (args.trim()) {
              case "":
              case "record":
                await toggle();
                return;
              case "setup":
                await wizard();
                return;
              case "status":
                await status();
                return;
              case "speak": {
                const enabled = !current.speak.enabled;
                current = { ...current, speak: { ...current.speak, enabled } };
                saveSettings(current);
                if (!enabled) stopSpeaking();
                notify(
                  enabled
                    ? `Replies read aloud with ${current.speak.voice} (${current.speak.engine})`
                    : "Read aloud off",
                );
                return;
              }
              default:
                notify(
                  "Commands: /voice · /voice setup · /voice status · /voice speak",
                  "warning",
                );
            }
          },
        },
      ],
    }));

    // First-run nudge: compile in the background so the first hold is instant.
    if (!built()) {
      const result = build();
      if (result.ok) notify("Dictation helper compiled", "success");
    }
    debug("tui setup complete");
  },
});
