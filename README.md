# 🔍 pi-extension-token-checker

> Fast static audit and token footprint analyzer for installed Pi (`pi-coding-agent`) extensions and tools.

Inspect prompt token costs across all installed extensions with zero runtime side-effects. Powered by static AST parsing.

---

## ✨ Features

- 🚀 **Zero Runtime Side Effects**: Inspects code using static AST traversal without executing unknown code or risking runtime crashes.
- 📊 **Fine-Grained Prompt Breakdown**: Separates tool descriptions, prompt guidelines, and TypeBox/JSON parameter schemas with exact character counts and estimated tokens.
- 🏆 **Full Leaderboard**: Scans all packages declared in Pi settings files and produces an organized footprint leaderboard.
- ⚡ **Zero Footprint**: Implemented as pure slash commands; injects **0 Tokens** into the LLM system prompt.
- 💻 **Interactive TUI**: Easy-to-use `/tokencheck` modal with smooth scrolling and granular breakdown.

---

## 📦 Installation

Install into Pi directly via Git:

```bash
pi install git:github.com/llxo/pi-extension-token-checker
```

Or from a local directory:

```bash
pi install ./pi-extension-token-checker
```

---

## 🎮 Usage

In your Pi interactive session:

- `/tokencheck`: Open the interactive leaderboard overlay (use `Up` / `Down` to scroll, `Escape` or `Enter` or `q` to exit).
- `/tokencheck <package-name-or-path>`: Deep-dive audit into a specific extension package or directory.

Examples:
```bash
/tokencheck
/tokencheck @inobit/pi-todo
/tokencheck pi-ask-user-question
```

---

## 📄 License

MIT © llxo
