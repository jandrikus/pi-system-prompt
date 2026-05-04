/**
 * /system-prompt — Display the full system prompt and tool definitions
 * in a full-screen scrollable overlay.
 */
import type { ExtensionAPI, Theme, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("system-prompt", {
    description: "Show the current system prompt and tool definitions",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const prompt = ctx.getSystemPrompt();
      const promptLines = prompt.split("\n");
      const charCount = prompt.length;
      const lineCount = promptLines.length;

      // Gather tool definitions
      const allTools = pi.getAllTools();

      // Build tool definition text lines
      const toolLines = buildToolLines(allTools);

      // Combine: system prompt + separator + tool definitions
      const allLines = [
        ...promptLines,
        "",
        "────────────────────────────────────────",
        "",
        ...toolLines,
      ];

      const totalLineCount = allLines.length;

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new SystemPromptView(
            tui,
            allLines,
            promptLines,
            allTools,
            lineCount,
            charCount,
            totalLineCount,
            theme,
            done,
          ),
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

function buildToolLines(tools: ToolDefinition[]): string[] {
  const lines: string[] = [];
  if (tools.length === 0) {
    lines.push("No tools registered.");
    return lines;
  }

  lines.push(`Tool Definitions (${tools.length} tools)`);
  lines.push("");

  for (const tool of tools) {
    const source = tool.sourceInfo?.source ?? "unknown";
    const sourceText =
      source === "builtin"
        ? "built-in"
        : source === "sdk"
          ? "SDK"
          : source;

    lines.push(`name: ${tool.name}`);
    lines.push(`  description: ${tool.description}`);
    lines.push(`  source: ${sourceText}`);
    lines.push("  parameters:");

    const paramStr = JSON.stringify(tool.parameters, null, 2);
    const paramLines = paramStr.split("\n");
    for (const pl of paramLines) {
      lines.push(`    ${pl}`);
    }

    lines.push("");
  }

  return lines;
}

interface DisplayLine {
  text: string;
  originalIndex: number;
  continuation: boolean;
}

type LineStyle = "tools" | "guidelines" | "heading" | "bullet" | "toolLine" | "plain";

function lineStyle(originalLine: string): LineStyle {
  if (originalLine.startsWith("Available tools:")) return "tools";
  if (originalLine.startsWith("Guidelines:")) return "guidelines";
  if (/^#+\s/.test(originalLine)) return "heading";
  if (originalLine.startsWith("- ")) return "bullet";
  if (originalLine.startsWith("  ") || originalLine.startsWith("    ")) return "toolLine";
  return "plain";
}

/** Apply styling for a non-continuation (first) line based on line style. */
function styleFirstLine(th: Theme, text: string, style: LineStyle): string {
  switch (style) {
    case "tools":
      return th.fg("success", th.bold(text));
    case "guidelines":
      return th.fg("accent", th.bold(text));
    case "heading":
      return th.fg("accent", th.bold(text));
    case "bullet":
      return th.fg("muted", text);
    default:
      return text;
  }
}

/** Apply styling for a continuation (wrapped) line based on line style. */
function styleContinuation(th: Theme, text: string, style: LineStyle): string {
  switch (style) {
    case "bullet":
      // Continuation of a bullet item: keep the muted color
      return th.fg("muted", text);
    case "heading":
      // Continuation of a heading: use dimmed accent
      return th.fg("dim", text);
    default:
      // For tools, guidelines, and plain lines: just dim
      return th.fg("dim", text);
  }
}

/** Enable SGR mouse mode (button events + extended coordinates). */
function enableMouse(): void {
  process.stdout.write("\x1b[?1000h");  // basic button tracking
  process.stdout.write("\x1b[?1006h");  // SGR extended coordinates
}

/** Disable SGR mouse mode. */
function disableMouse(): void {
  process.stdout.write("\x1b[?1006l");
  process.stdout.write("\x1b[?1000l");
}

/**
 * Parse an SGR mouse escape sequence. Returns { wheelUp, wheelDown }
 * with the number of scroll steps, or null if it's not a mouse event.
 */
function parseSgrMouse(data: string): { wheelUp: number; wheelDown: number } | null {
  // SGR mouse press format: ESC[<btn;col;rowM
  // Wheel up   = button 64
  // Wheel down = button 65
  if (!data.startsWith("\x1b[<") || !data.endsWith("M")) return null;
  const inner = data.slice(3, -1); // strip ESC[< and trailing M
  const parts = inner.split(";");
  if (parts.length !== 3) return null;
  const btn = parseInt(parts[0], 10);
  if (isNaN(btn)) return null;
  if (btn === 64) return { wheelUp: 3, wheelDown: 0 }; // scroll up 3 lines
  if (btn === 65) return { wheelUp: 0, wheelDown: 3 }; // scroll down 3 lines
  return null;
}

class SystemPromptView {
  private scrollOffset = 0;
  private copiedAt = 0;
  private fullText: string;
  private totalDisplayLines = 0;

  constructor(
    private tui: { height: number },
    private allLines: string[],
    private promptLines: string[],
    private allTools: ToolDefinition[],
    private promptLineCount: number,
    private promptCharCount: number,
    private combinedLineCount: number,
    private theme: Theme,
    private done: () => void,
  ) {
    this.fullText = allLines.join("\n");
    enableMouse();
  }

  handleInput(data: string): void {
    const visible = this.visibleLines();
    const total = this.totalDisplayLines || this.combinedLineCount;

    // Handle mouse wheel via SGR sequences
    const mouse = parseSgrMouse(data);
    if (mouse) {
      if (mouse.wheelUp > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - mouse.wheelUp);
      }
      if (mouse.wheelDown > 0) {
        this.scrollOffset = Math.min(
          Math.max(0, total - visible),
          this.scrollOffset + mouse.wheelDown,
        );
      }
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.scrollOffset > 0) this.scrollOffset--;
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (this.scrollOffset < total - visible) this.scrollOffset++;
      return;
    }
    if (matchesKey(data, "pageup")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - visible);
      return;
    }
    if (matchesKey(data, "pagedown")) {
      this.scrollOffset = Math.min(
        Math.max(0, total - visible),
        this.scrollOffset + visible,
      );
      return;
    }
    if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, "end")) {
      this.scrollOffset = Math.max(0, total - visible);
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
    const h = this.tui.height;
    if (!h || h <= 0) return 30;
    return Math.max(1, Math.floor(h * 0.92) - 4);
  }

  private buildDisplayLines(contentW: number): DisplayLine[] {
    const displayLines: DisplayLine[] = [];
    for (let i = 0; i < this.allLines.length; i++) {
      const wrapped = wrapTextWithAnsi(this.allLines[i], contentW);
      for (let w = 0; w < wrapped.length; w++) {
        displayLines.push({
          text: wrapped[w],
          originalIndex: i,
          continuation: w > 0,
        });
      }
    }
    return displayLines;
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const contentW = innerW - 1;
    const visible = this.visibleLines();

    const displayLines = this.buildDisplayLines(contentW);
    this.totalDisplayLines = displayLines.length;

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
        ` ${th.fg("accent", th.bold("System Prompt"))}  ${th.fg("dim", `— ${this.promptLineCount} lines, ${this.promptCharCount.toLocaleString()} chars`)}  ${th.fg("dim", `|  ${this.allTools.length} tools`)}`,
      ),
    );
    out.push(row(""));

    // Content area
    const end = Math.min(this.scrollOffset + visible, displayLines.length);
    for (let i = this.scrollOffset; i < end; i++) {
      const dl = displayLines[i];
      const originalLine = this.allLines[dl.originalIndex];
      const style = lineStyle(originalLine);
      const styled = dl.continuation
        ? styleContinuation(th, dl.text, style)
        : styleFirstLine(th, dl.text, style);

      out.push(row(` ${styled}`));
    }

    // Pad empty rows if content is shorter than visible area
    for (let i = end - this.scrollOffset; i < visible; i++) {
      out.push(row(""));
    }

    // Footer
    const pct =
      displayLines.length > 0
        ? Math.round((this.scrollOffset / displayLines.length) * 100)
        : 0;
    const footerLeft = `${this.scrollOffset + 1}-${end}/${displayLines.length} (${pct}%)`;
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
    const base64 = Buffer.from(this.fullText, "utf-8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    this.copiedAt = Date.now();
  }

  invalidate(): void {}

  dispose(): void {
    disableMouse();
  }
}
