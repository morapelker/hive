<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Desktop app for managing git worktrees with integrated AI coding sessions</strong></p>

  <p>
    <a href="#"><img src="https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="#"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React" /></a>
    <a href="#"><img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" /></a>
    <a href="#"><img src="https://img.shields.io/badge/SQLite-WAL-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" /></a>
    <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  </p>
</div>

---

## Features

- **Git Worktree Management** -- Create, switch, and archive worktrees with city-themed naming (tokyo, paris, helsinki...)
- **AI Coding Sessions** -- Integrated [OpenCode](https://opencode.ai) sessions with streaming responses, tool calls, and permission prompts
- **File Explorer** -- File tree with real-time git status indicators and diff viewing
- **Git Operations** -- Commit, push, pull, and branch management built in
- **Themes** -- 10 presets (6 dark, 4 light) with instant switching
- **Command Palette** -- Fast navigation and actions via keyboard shortcuts
- **Spaces** -- Organize projects and worktrees into logical groups

<!-- ## Screenshots

> Screenshots coming soon. Run `pnpm dev` to see Hive in action.

-->

## Architecture

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

All cross-process communication uses typed IPC through the preload layer. The renderer is fully sandboxed with `contextIsolation: true`.

## Getting Started

### Prerequisites

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree support)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/anomalyco/hive.git
cd hive

# Install dependencies
pnpm install

# Start development
pnpm dev
```

## Development

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

## Project Structure

```
src/
├── main/                  # Electron main process (Node.js)
│   ├── db/                # SQLite database + schema + migrations
│   ├── ipc/               # IPC handler modules
│   └── services/          # Git, OpenCode, logger, file services
├── preload/               # Bridge layer (typed window.* APIs)
└── renderer/src/          # React SPA
    ├── components/        # UI organized by domain
    │   ├── command-palette/
    │   ├── diff/
    │   ├── file-tree/
    │   ├── git/
    │   ├── layout/
    │   ├── projects/
    │   ├── sessions/
    │   ├── settings/
    │   ├── spaces/
    │   ├── ui/            # shadcn/ui primitives
    │   └── worktrees/
    ├── hooks/             # Custom React hooks
    ├── lib/               # Utilities, themes, helpers
    └── stores/            # Zustand state management (21 stores)
```

## Tech Stack

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
| Icons     | [Lucide](https://lucide.dev/)                                                    |

## Documentation

Detailed documentation lives in [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Product requirements for all 17 development phases
- **[Implementation](docs/implementation/)** -- Technical implementation guides per phase
- **[Specs](docs/specs/)** -- Feature specifications (context calculation, title generation, permissions)
- **[Plans](docs/plans/)** -- Active implementation plans

## License

[MIT](LICENSE)
