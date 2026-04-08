<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>An open-source AI agent orchestrator for parallel coding across projects.</strong></p>
  <p>Run Claude Code, OpenCode, and Codex sessions in parallel. One window. Isolated branches. Zero tab chaos.</p>
  <p>
    <a href="README.md"><strong>English</strong></a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Latest Release" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Downloads" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Build Status" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" /></a>
  </p>
</div>

---

## Table of Contents

- [Installation](#installation)
- [What is Hive?](#what-is-hive)
- [Features](#features)
- [Why Hive?](#why-hive)
- [Quick Start](#quick-start)
- [Connections - The Game Changer](#-connections---the-game-changer)
- [Screenshots](#screenshots)
- [Community & Support](#community--support)
- [Roadmap](#roadmap)
- [Development](#development)
  - [Prerequisites](#prerequisites)
  - [Setup](#setup)
  - [Commands](#commands)
  - [Architecture](#architecture)
  - [Project Structure](#project-structure)
  - [Tech Stack](#tech-stack)
  - [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Installation

> 🍎 **macOS only** — Windows and Linux support coming soon.

### Via Homebrew (Recommended)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Direct Download

Download the latest `.dmg` from [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

That's it! Open Hive from your Applications folder and point it at a git repo.

## What is Hive?

If you run multiple AI coding agents across different projects and branches, you know the pain -- six terminal tabs open, you can't remember which agent is working on what, and you're worried two of them are editing the same files.

Hive is an AI agent orchestrator. See all your running agents in one sidebar, click to switch between them, and each one runs on an isolated git worktree branch so they can't conflict. Connect multiple repositories together so a single agent session has context across your entire stack.

## Features

### 🌳 **Worktree-First Workflow**
Work on multiple branches simultaneously without stashing or switching. Create, archive, and organize worktrees with one click. Each worktree gets a unique city-based name for easy identification.

### 🤖 **Built-in AI Coding Sessions**
Run AI coding agents directly inside Hive with **OpenCode**, **Claude Code**, and **Codex** support. Stream responses in real-time, watch tool calls execute, and approve permissions as needed. Full undo/redo support keeps you in control.

### 📁 **Smart File Explorer**
See what changed at a glance with live git status indicators. View diffs inline, browse file history, and navigate your codebase without leaving the app. Integrated Monaco editor provides a full VS Code experience.

### 🔧 **Complete Git Integration**
Commit, push, pull, and manage branches visually. No terminal needed for common git operations. See pending changes, staged files, and commit history all in one place.

### 📦 **Spaces for Organization**
Group related projects and worktrees into logical workspaces. Pin your favorites for quick access. Keep your development environment organized as you scale.

### ⚡ **Command Palette**
Navigate and act fast with keyboard shortcuts. Press `Cmd+K` to access any feature instantly. Search sessions, switch worktrees, or run commands without touching the mouse.

### 🎨 **Beautiful Themes**
Choose from 10 carefully crafted themes — 6 dark and 4 light. Switch instantly to match your preference or time of day. Follows system theme automatically if desired.

### 🔌 **Worktree Connections**
Connect two worktrees together to share context, compare implementations, or collaborate in real-time. Perfect for reviewing changes between branches, sharing AI sessions across worktrees, or maintaining consistency when working on related features. See live updates as connected worktrees change.

## Why Hive?

See how Hive transforms your git workflow:

| Task | Traditional Workflow | With Hive |
|------|---------------------|-----------|
| **Switch branches** | `git stash` → `git checkout` → `git stash pop` | Click on worktree → Done |
| **Work on multiple features** | Constant stashing and context switching | Open multiple worktrees side-by-side |
| **Create worktree** | `git worktree add ../project-feature origin/feature` | Click "New Worktree" → Select branch |
| **AI coding assistance** | Terminal + separate AI tool + copy/paste | Integrated AI sessions with full context |
| **View file changes** | `git status` → `git diff file.ts` | Visual tree with inline diffs |
| **Compare branches** | Multiple terminal tabs, copy/paste between | Connect worktrees to share context |
| **Find a worktree** | `cd ~/projects/...` → remember directory names | All worktrees in one sidebar |
| **Clean up worktrees** | `git worktree remove` → `rm -rf directory` | Click "Archive" → Handles everything |

## Quick Start

Get up and running in under 2 minutes:

### 1️⃣ **Add Your First Project**
Open Hive → Click **"Add Project"** → Select any git repository on your machine

### 2️⃣ **Create a Worktree**
Select your project → Click **"New Worktree"** → Choose a branch (or create a new one)

### 3️⃣ **Start Coding with AI**
Open a worktree → Click **"New Session"** → Start coding with OpenCode, Claude, or Codex

> 💡 **Pro tip**: Press `Cmd+K` anytime to open the command palette and navigate quickly!

📖 [Read the full guide](docs/GUIDE.md) | ⌨️ [Keyboard shortcuts](docs/SHORTCUTS.md)

## 🔌 Worktree Connections - The Game Changer

Hive's **Worktree Connections** feature lets you link two worktrees together, creating a bridge between different branches or features. This is incredibly powerful for development workflows that require cross-branch awareness.

### What Are Worktree Connections?

Connect any two worktrees to:
- **🔄 Share Context** - Access files and changes from another branch instantly
- **🤝 Collaborate** - Work on related features with live updates between worktrees
- **📊 Compare** - See differences between implementations side-by-side
- **🎯 Reference** - Keep your main branch visible while working on features
- **🔗 Link Features** - Connect frontend and backend branches for full-stack development
- **💬 Share AI Sessions** - Continue AI conversations across different worktrees

### How It Works

1. **Select Source Worktree** - Choose the worktree you're working in
2. **Connect to Target** - Click the connection icon and select another worktree
3. **Bidirectional Link** - Both worktrees become aware of each other
4. **Real-time Updates** - See changes in connected worktrees as they happen

### Connection Features

- ✅ **Live Sync** - File changes in one worktree appear in the connection panel
- ✅ **Quick Switch** - Jump between connected worktrees with one click
- ✅ **Diff View** - Compare files between connected worktrees
- ✅ **Shared Terminal** - Run commands that affect both worktrees
- ✅ **AI Context Sharing** - AI sessions can reference connected worktree code
- ✅ **Status Indicators** - See build status, tests, and changes in connected worktrees
- ✅ **Connection History** - Track which worktrees were connected and when
- ✅ **Smart Suggestions** - Hive suggests relevant worktrees to connect based on your workflow

### Example Use Cases

**Feature Development**: Connect your feature branch to main to ensure compatibility and see how your changes integrate.

**Bug Fixes**: Connect the bug fix worktree to the production branch to verify the fix works in context.

**Code Reviews**: Connect reviewer and author worktrees to discuss changes with full context on both sides.

**Full-Stack Development**: Connect frontend and backend worktrees to work on API and UI simultaneously with perfect coordination.

**Refactoring**: Connect old and new implementations to ensure feature parity during large refactors.

## See It In Action

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive demo — orchestrate AI agents across projects" width="900" />
</div>

<details>
<summary><strong>More Screenshots</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — AI coding session with git worktrees" width="900" />
  <sub>AI-powered coding sessions with integrated git worktree management</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Creating a new worktree" width="900" />
  <sub>Create and manage worktrees visually</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="File tree with git status" width="900" />
  <sub>File explorer with live git status indicators</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Theme showcase" width="900" />
  <sub>Beautiful themes for every preference</sub>
</div>

</details>

## Community & Support

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_Documentation-Read-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Report-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Discussions-Join-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_Contributing-Guidelines-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_Security-Policy-orange?style=for-the-badge)](SECURITY.md)

</div>

### Get Help

- 📖 Read the [documentation](docs/) for detailed guides
- 🐛 [Report bugs](https://github.com/morapelker/hive/issues/new?template=bug_report.md) with reproduction steps
- 💡 [Request features](https://github.com/morapelker/hive/issues/new?template=feature_request.md) you'd like to see
- 💬 [Join discussions](https://github.com/morapelker/hive/discussions) to connect with the community
- 🔒 [Report security vulnerabilities](SECURITY.md) responsibly

### Resources

- [User Guide](docs/GUIDE.md) — Getting started and tutorials
- [FAQ](docs/FAQ.md) — Common questions and troubleshooting
- [Keyboard Shortcuts](docs/SHORTCUTS.md) — Complete shortcuts reference

## Roadmap

### 🚀 Coming Soon

- **Cross-platform support** — Windows and Linux builds
- **Plugin system** — Extend Hive with custom integrations
- **Cloud sync** — Sync settings, sessions, and connection templates across devices
- **Team features** — Share worktrees and collaborate in real-time
- **Git graph visualization** — Visual branch history and merges
- **Performance profiling** — Built-in tools for optimization

### 🎯 Future Vision

- **Remote development** — SSH and container-based development
- **Three-way connections** — Connect and merge multiple branches visually
- **CI/CD integration** — GitHub Actions, GitLab CI, Jenkins monitoring
- **Connection automation** — Auto-connect related branches based on patterns
- **Code review mode** — Special connection type optimized for reviews
- **Time tracking** — Per-worktree and per-connection activity analytics

Want to influence the roadmap? [Join the discussion](https://github.com/morapelker/hive/discussions/categories/ideas) or [contribute](CONTRIBUTING.md)!

---

<details>
<summary><strong>Development</strong></summary>

### Prerequisites

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree support)

### Setup

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty Terminal (Optional)

Hive includes an optional native terminal powered by [Ghostty](https://ghostty.org/)'s `libghostty`. This is only needed if you want to work on the embedded terminal feature.

**Setup:**

1. Build `libghostty` from the Ghostty source ([build instructions](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   This produces `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. If your Ghostty repo is at `~/Documents/dev/ghostty/`, the build will find it automatically. Otherwise, set the path:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Rebuild the native addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

If `libghostty` is not available, Hive still builds and runs -- the Ghostty terminal feature will just be disabled.

### Commands

| Command           | Description           |
| ----------------- | --------------------- |
| `pnpm dev`        | Start with hot reload |
| `pnpm build`      | Production build      |
| `pnpm lint`       | ESLint check          |
| `pnpm lint:fix`   | ESLint auto-fix       |
| `pnpm format`     | Prettier format       |
| `pnpm test`       | Run all tests         |
| `pnpm test:watch` | Watch mode            |
| `pnpm test:e2e`   | Playwright E2E tests  |
| `pnpm build:mac`  | Package for macOS     |

### Architecture

Hive uses Electron's three-process model with strict sandboxing:

```
┌─────────────────────────────────────────────────────┐
│                    Main Process                      │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (AI Sessions)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  IPC Handlers │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ Typed IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │   (Bridge)    │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ window.* APIs
┌──────────────────────┼──────────────────────────────┐
│                 Renderer Process                     │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │    Components     │   │
│  │ Stores    │ │ ui       │ │  (14 domains)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Project Structure

```
src/
├── main/                  # Electron main process (Node.js)
│   ├── db/                # SQLite database + schema + migrations
│   ├── ipc/               # IPC handler modules
│   └── services/          # Git, AI agents, logger, file services
├── preload/               # Bridge layer (typed window.* APIs)
└── renderer/src/          # React SPA
    ├── components/        # UI organized by domain
    ├── hooks/             # Custom React hooks
    ├── lib/               # Utilities, themes, helpers
    └── stores/            # Zustand state management
```

### Tech Stack

| Layer     | Technology                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Language  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| State     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Database  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL mode)          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex) |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Documentation

Detailed docs live in [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Product requirements
- **[Implementation](docs/implementation/)** -- Technical guides
- **[Specs](docs/specs/)** -- Feature specifications
- **[Plans](docs/plans/)** -- Active implementation plans

</details>

## Contributing

We love contributions! Hive is built by developers, for developers, and we welcome improvements of all kinds.

### Ways to Contribute

- 🐛 **Report bugs** with clear reproduction steps
- 💡 **Suggest features** that would improve your workflow
- 📝 **Improve documentation** to help others get started
- 🎨 **Submit UI/UX improvements** for better usability
- 🔧 **Fix bugs** from our issue tracker
- ⚡ **Optimize performance** in critical paths
- 🧪 **Add tests** to improve coverage
- 🌐 **Translate** the app to your language

Before contributing, please read our [Contributing Guidelines](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

### Quick Contribution Guide

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`pnpm test`) and linting (`pnpm lint`)
5. Commit with a descriptive message
6. Push to your fork
7. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## License

[MIT](LICENSE) © 2024 morapelker

Hive is open source software licensed under the MIT License. See the [LICENSE](LICENSE) file for full details.
