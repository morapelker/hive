<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>A native macOS app for managing git worktrees and AI-powered coding sessions.</strong></p>
  <p>Work on multiple branches simultaneously. Run AI coding agents inline. Never stash again.</p>

  <p>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  </p>
</div>

---

## What is Hive?

If you work across multiple branches, features, or repos at the same time, you know the pain -- constant stashing, context switching, and losing your place. Git worktrees solve this, but managing them from the terminal is tedious.

Hive gives you a dedicated workspace for worktree-based development. Create, switch, and archive worktrees visually. Run AI coding sessions directly inside each worktree. See file changes, diffs, and git status in real time -- all from one app.

## Features

- **Worktree-first workflow** -- Work on multiple branches at the same time without stashing or switching. Create, archive, and organize worktrees with one click.
- **Built-in AI coding sessions** -- Run AI coding agents directly inside Hive. Stream responses, watch tool calls execute, and approve permissions in real time.
- **File explorer with live git status** -- See what changed at a glance. View diffs inline without leaving the app.
- **Full git operations** -- Commit, push, pull, and branch management. No terminal needed.
- **Spaces** -- Group related projects and worktrees into logical workspaces.
- **Command palette** -- Navigate and act fast with keyboard shortcuts.
- **10 themes** -- 6 dark, 4 light. Switch instantly.

## Install

> macOS only.

```bash
brew tap morapelker/hive
brew install --cask hive
```

That's it. Open Hive from your Applications folder and point it at a git repo.

<!-- ## Screenshots

> Screenshots coming soon.

-->

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
│  │ Database  │ │   Git    │ │ OpenCode Service  │   │
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
│   └── services/          # Git, OpenCode, logger, file services
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
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Documentation

Detailed docs live in [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Product requirements
- **[Implementation](docs/implementation/)** -- Technical guides
- **[Specs](docs/specs/)** -- Feature specifications
- **[Plans](docs/plans/)** -- Active implementation plans

</details>

## License

[MIT](LICENSE)
