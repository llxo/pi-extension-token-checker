import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildLeaderboard,
  formatLeaderboard,
  analyzePlugin,
  resolvePackageDir,
} from "./analyzer.ts";

/** Interactive modal component for viewing token leaderboard */
class LeaderboardViewComponent {
  private readonly lines: string[];
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private scrollOffset = 0;

  constructor(lines: string[], theme: Theme, onClose: () => void) {
    this.lines = lines;
    this.theme = theme;
    this.onClose = onClose;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "space") ||
      data === "q"
    ) {
      this.onClose();
      return;
    }

    const maxVisibleLines = 25;
    const maxScroll = Math.max(0, this.lines.length - maxVisibleLines);

    if (matchesKey(data, "up") || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    } else if (matchesKey(data, "pageup")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
    } else if (matchesKey(data, "pagedown")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 10);
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const output: string[] = [];

    output.push("");
    const title = th.fg("accent", " 🏆 Pi Extension Token Footprint Leaderboard ");
    output.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 52))),
        width,
      ),
    );
    output.push("");

    const maxVisibleLines = 28;
    const slice = this.lines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);

    for (const line of slice) {
      if (line.startsWith("==") || line.startsWith("--")) {
        output.push(truncateToWidth(th.fg("borderMuted", "─".repeat(width)), width));
      } else if (line.includes("🏆")) {
        output.push(truncateToWidth(th.fg("accent", th.bold(line)), width));
      } else if (line.includes("active-tools")) {
        output.push(truncateToWidth(th.fg("warning", line), width));
      } else if (line.includes("on-demand-tools") || line.includes("prompt-inject")) {
        output.push(truncateToWidth(th.fg("accent", line), width));
      } else if (
        line.includes("0 tk") ||
        line.includes("command-only") ||
        line.includes("theme-or-library") ||
        line.includes("builtin-override")
      ) {
        output.push(truncateToWidth(th.fg("muted", line), width));
      } else {
        output.push(truncateToWidth(th.fg("text", line), width));
      }
    }

    output.push("");
    output.push(
      truncateToWidth(`  ${th.fg("dim", "Press Escape / Enter / q to close (Arrow Up/Down to scroll)")}`, width),
    );
    output.push("");
    return output;
  }
}

export default function (pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: any) => {
    const cleanArg = args.trim();

    // 1. Audit single extension package if target argument provided
    if (cleanArg.length > 0 && cleanArg !== "--all") {
      const dir = resolvePackageDir(cleanArg);
      if (!dir) {
        ctx.ui.notify(`Extension directory not found: ${cleanArg}`, "error");
        return;
      }
      const res = analyzePlugin(cleanArg, dir);
      const estMin = Math.round(res.estTokens * 0.9);
      const estMax = Math.round(res.estTokens * 1.15);

      const msg = [
        `📦 Package: ${cleanArg} (${res.type})`,
        `🛠️ Tools: ${res.tools.length}${res.activeTokens !== res.estTokens ? ` (active: ~${res.activeTokens} tk)` : ""}`,
        res.promptInjections.length > 0 ? `💉 Prompt injections: ${res.promptInjections.length}` : "",
        `📊 Prompt text: ${res.totalChars.toLocaleString()} chars`,
        `💡 Est. Token Footprint: ~${res.estTokens.toLocaleString()} tokens`,
      ].filter(Boolean).join("\n");

      if (ctx.mode === "tui" && ctx.hasUI) {
        await ctx.ui.custom((_tui: any, theme: Theme, _kb: any, done: () => void) => {
          const lines = [
            `Package: ${cleanArg} (${res.type})`,
            `Location: ${dir}`,
            `Tools: ${res.tools.length} | Commands: ${res.commands.length} | Injections: ${res.promptInjections.length}`,
            "----------------------------------------------------------------",
            ...res.tools.map(
              (t) =>
                `[Tool: ${t.name}${t.status !== "active" ? ` (${t.status})` : ""}] ${t.totalChars} chars / ~${t.estTokens} tokens (desc: ${t.description.length}c, rules: ${t.promptGuidelines.join(" ").length}c, schema: ${t.parametersStr.length}c)`,
            ),
            ...res.promptInjections.map(
              (inj) =>
                `[Prompt Injection: ${inj.event}] ${inj.chars} chars / ~${inj.estTokens} tokens ("${inj.content.slice(0, 40)}...")`,
            ),
            "----------------------------------------------------------------",
            `Total: ${res.totalChars.toLocaleString()} chars / ~${res.estTokens.toLocaleString()} tokens${res.activeTokens !== res.estTokens ? ` (active: ~${res.activeTokens.toLocaleString()} tk)` : ""}`,
          ];
          return new LeaderboardViewComponent(lines, theme, () => done());
        });
        return;
      }

      ctx.ui.notify(msg, "info");
      return;
    }

    // 2. Otherwise scan all extensions and display leaderboard
    const leaderboard = buildLeaderboard();
    const tableLines = formatLeaderboard(leaderboard);

    if (ctx.mode === "tui" && ctx.hasUI) {
      await ctx.ui.custom((_tui: any, theme: Theme, _kb: any, done: () => void) => {
        return new LeaderboardViewComponent(tableLines, theme, () => done());
      });
      return;
    }

    const top = leaderboard[0];
    ctx.ui.notify(
      `Audited ${leaderboard.length} extensions. Highest footprint: ${top ? top.pkgName : "none"} (~${top ? top.estTokens : 0} tokens)`,
      "info",
    );
  };

  // Register main command
  pi.registerCommand("tokencheck", {
    description: "Audit prompt token footprints of installed Pi extensions",
    handler,
  });
}
