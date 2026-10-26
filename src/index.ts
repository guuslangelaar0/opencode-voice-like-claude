// Server-side entry point. Dictation is a TUI feature, so this is intentionally
// inert — it only exists because OpenCode loads the package root first.
import * as Plugin from "@opencode/plugin/tui/plugin";

export default Plugin.define({
  id: "opencode-voice-like-claude",
  setup() {},
});
