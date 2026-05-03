/**
 * /system-prompt — Display the full system prompt in a full-screen scrollable overlay.
 */
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("system-prompt", {
    description: "Show the current system prompt with all injected content",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const prompt = ctx.getSystemPrompt();
      const lines = prompt.split("\n");
      const charCount = prompt.length;
      const lineCount = lines.length;

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new SystemPromptView(tui, lines, lineCount, charCount, theme, done),
        {
          overlay: true,
          overlayOptions: {
            width: "95%",
            height: "92%",
            anchor: "center",
            margin: 0,
          },
        },
      );
    },
  });
}

class SystemPromptView {
  private scrollOffset = 0;
  private copiedAt = 0;
  private fullText: string;

  constructor(
    private tui: { height: number },
    private lines: string[],
    private lineCount: number,
    private charCount: number,
    private theme: Theme,
    private done: () => void,
  ) {
    this.fullText = lines.join("\n");
  }

  handleInput(data: string): void {
    const visible = this.visibleLines();
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.scrollOffset > 0) this.scrollOffset--;
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (this.scrollOffset < this.lineCount - visible) this.scrollOffset++;
      return;
    }
    if (matchesKey(data, "pageup")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - visible);
      return;
    }
    if (matchesKey(data, "pagedown")) {
      this.scrollOffset = Math.min(
        Math.max(0, this.lineCount - visible),
        this.scrollOffset + visible,
      );
      return;
    }
    if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, "end")) {
      this.scrollOffset = Math.max(0, this.lineCount - visible);
      return;
    }
    if (matchesKey(data, "c")) {
      this.copyToClipboard();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
    }
  }

  private visibleLines(): number {
    // Overlay height is 92% of terminal, minus 4 for borders/header/footer
    const h = this.tui.height;
    if (!h || h <= 0) return 30; // fallback
    return Math.max(1, Math.floor(h * 0.92) - 4);
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2; // account for border chars
    const visible = this.visibleLines();
    const border = th.fg("border", "");

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const row = (content: string) =>
      th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    const out: string[] = [];

    // Top border + header
    out.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    out.push(
      row(
        ` ${th.fg("accent", th.bold("System Prompt"))}  ${th.fg("dim", `— ${this.lineCount} lines, ${this.charCount.toLocaleString()} chars`)}`,
      ),
    );
    out.push(row(""));

    // Content area
    const end = Math.min(this.scrollOffset + visible, this.lineCount);
    for (let i = this.scrollOffset; i < end; i++) {
      const line = this.lines[i];
      let styled: string;
      if (line.startsWith("Available tools:")) {
        styled = th.fg("success", th.bold(line));
      } else if (line.startsWith("Guidelines:")) {
        styled = th.fg("accent", th.bold(line));
      } else if (/^#+\s/.test(line)) {
        styled = th.fg("accent", th.bold(line));
      } else if (line.startsWith("- ")) {
        styled = th.fg("muted", line);
      } else {
        styled = line;
      }
      out.push(row(` ${styled}`));
    }

    // Pad empty rows if content is shorter than visible area
    for (let i = end - this.scrollOffset; i < visible; i++) {
      out.push(row(""));
    }

    // Footer
    const pct =
      this.lineCount > 0
        ? Math.round((this.scrollOffset / this.lineCount) * 100)
        : 0;
    const footerLeft = `${this.scrollOffset + 1}-${end}/${this.lineCount} (${pct}%)`;
    const copyLabel = Date.now() - this.copiedAt < 2000
      ? th.fg("success", "copied")
      : "copy";
    const footerRight = `c ${copyLabel}  ↑↓/jk pgup/pgdn home/end  Esc/q`;
    const leftVis = visibleWidth(footerLeft);
    const rightVis = visibleWidth(footerRight);
    const gap = Math.max(1, innerW - 1 - leftVis - rightVis);
    const footer = ` ${th.fg("dim", footerLeft)}${" ".repeat(gap)}${th.fg("dim", footerRight)}`;
    out.push(row(""));
    out.push(row(footer));

    // Bottom border
    out.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return out;
  }

  private copyToClipboard(): void {
    // OSC 52 — works with kitty, wezterm, ghostty, iTerm2, etc.
    const base64 = Buffer.from(this.fullText, "utf-8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    this.copiedAt = Date.now();
  }

  invalidate(): void {}
  dispose(): void {}
}
