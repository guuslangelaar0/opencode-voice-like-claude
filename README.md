# opencode-voice-like-claude

Voice in the OpenCode TUI the way Claude does it: **hold space, talk, release — the text is in the prompt.** Fully on-device, no API key, no audio ever leaves the machine. It can also read replies back to you in a voice you choose during setup.

Built on **SpeechAnalyzer** / `DictationTranscriber`, the on-device speech stack Apple shipped in macOS 26.

```
hold space ──▶ ● listening… ▁▃▅▇▅▃▁ ──▶ release ──▶ transcript in the prompt
```

## What you get

- **Hold-to-talk**, exactly like the Claude CLI — hold `space` 700 ms, speak, release. A shorter tap still types a space.
- **Live feedback** — the prompt footer streams what the transcriber currently hears, with a 7-bar level meter while you talk.
- **No paste step** — the finished transcript goes into the prompt via the TUI's own paste command.
- **54 languages** — anything macOS 26 supports, downloaded on demand and cached offline.
- **Silence auto-stop** — stop talking and it ends by itself after 2.5 s; no second keypress needed.
- **Spoken replies, locally** — Apple system voices (`say`, instant) or Kokoro-82M (`uvx`, ~300 MB, most natural), picked and previewed in the wizard.
- **No cloud, no keys** — the only network use is macOS downloading its own speech model.
- **Nothing to patch** — ships its own Swift helper and compiles it on first run.

Readback is off until you ask for it: the wizard offers it, and `/voice speak` toggles it afterwards.

## Requirements

- macOS 26 (Tahoe) or newer — `SpeechAnalyzer` does not exist before it
- Xcode Command Line Tools (`xcode-select --install`), used once to compile the ~12 KB Swift helper
- A terminal that reports key *release* events (Kitty keyboard protocol) if you want hold-to-talk. iTerm2, Terminal.app, Ghostty, WezTerm and Kitty all do. Without it the plugin still works via `ctrl+shift+v`, and recording stops on silence.

The speech model itself is downloaded by macOS on first use, per language (a few hundred MB, free, offline afterwards).

## Install

Add the plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-voice-like-claude"]
}
```

Or from a checkout, before it is published:

```jsonc
"plugins": ["file:/absolute/path/to/opencode-voice-like-claude"]
```

Restart the TUI (plugins load per process), then start dictating and the setup wizard opens by itself. You can also run it any time:

```
/voice setup
```

The wizard:

1. Checks macOS version and that a Swift toolchain is available
2. Compiles the helper into `~/.config/opencode/voice-like-claude/bin/dictate` (once; rebuilt automatically when the bundled source changes)
3. Lets you pick from the 54 languages the OS supports, and downloads the model if it is not installed yet
4. Asks whether you want hold-to-talk or a custom chord
5. Asks whether replies should be read aloud, then picks the engine (Apple system voice or Kokoro-82M) and the exact voice — Apple voices speak a sample **as you move through the list**, so you hear each one before choosing
6. Probes the microphone, pointing at **System Settings › Privacy & Security › Microphone** if access was denied

## Usage

| Action | Key |
|---|---|
| Start dictating (hold, then release to stop) | press and hold `space` |
| Start / stop without holding | `ctrl+shift+v` |
| Setup wizard | `/voice setup` |
| Current configuration | `/voice status` |
| Toggle reading replies aloud | `/voice speak` |

A normal space press (shorter than the hold threshold, 700 ms by default) is passed through untouched, so typing is unaffected. While recording, spaces are swallowed.

Recording also stops on its own after 2.5 s of silence, or when it hits the 10-minute cap. If nothing was recognised you get a "No speech detected" toast instead of an empty paste.

## Configuration

`~/.config/opencode/voice-like-claude/settings.json` (written by the wizard):

```json
{
  "locale": "en-US",
  "holdMs": 700,
  "silenceStop": 2.5,
  "maxSeconds": 600,
  "chord": "ctrl+shift+v",
  "spaceHold": true,
  "speak": {
    "enabled": true,
    "engine": "say",
    "voice": "Samantha",
    "maxChars": 700
  }
}
```

- `locale` — any BCP-47 tag from `dictate locales`
- `holdMs` — how long space must be held before recording starts
- `silenceStop` — seconds of silence that end a recording
- `spaceHold` — set `false` to stop intercepting space entirely and use `chord`
- `speak.engine` — `say` (macOS voices) or `kokoro` (Kokoro-82M via `uvx`)
- `speak.voice` — a voice name from `say -v '?'`, or a Kokoro voice such as `af_heart`
- `speak.maxChars` — replies are truncated to this before being spoken

## How it works

`assets/dictate.swift` is compiled on first run into a self-contained binary. It captures the default input device with `AVAudioEngine`, converts to the format the analyzer asks for, and streams `AnalyzerInput` buffers into `SpeechAnalyzer` running `DictationTranscriber` with volatile results, frequent finalization, punctuation and short-form content hints.

The plugin drives it through files in `$TMPDIR/opencode-voice-like-claude`: the transcript-so-far (`live`), the final transcript (`out`), an RMS level (`level`) and a pid file. A 90 ms poll mirrors those into the footer and pushes the finished text into the composer.

Insertion uses the TUI's own `prompt.paste` command after placing the text on the clipboard — the closest thing to typing into the prompt that a plugin is allowed to do.

For readback the plugin listens for `session.next.text.ended` to collect a reply and `session.idle` to speak it once. Markdown, code fences and URLs are stripped first, and a short-lived lock in `$TMPDIR/opencode-voice-like-claude/speak.lock` stops a second OpenCode process from repeating the same lines — the cause of "double voice" symptoms.

## Troubleshooting

**Nothing happens on ctrl+shift+v / hold space** — the plugin loads per TUI process; fully restart OpenCode. Check `$TMPDIR/opencode-voice-like-claude/debug.log`.

**Hold space types spaces instead of recording** — your terminal does not report key releases. Use `ctrl+shift+v`, or `/voice setup` and choose a chord.

**"No speech detected" instantly** — the microphone is muted, the wrong input device is selected, or macOS has not granted microphone access to the terminal.

**"helper: not compiled" in /voice status** — run `/voice setup` and read the compiler output; usually the Command Line Tools are missing.

**Text lands under the prompt instead of inside it** — a plugin cannot write into the composer's text area; it pastes via the prompt's own paste command. If that command is unavailable in your OpenCode version the transcript is left on the clipboard with a toast.

**The voice sounds robotic** — that is a compact system voice. Premium and Enhanced voices are free: **System Settings › Accessibility › Spoken Content › System Voice › Manage Voices**, download one, then `/voice setup` again. For the most natural result choose the Kokoro-82M engine instead (requires `uvx`; `brew install uv`).

## Uninstall

Remove the plugin entry, then delete `~/.config/opencode/voice-like-claude`. The TUI needs a restart.

## License

MIT
