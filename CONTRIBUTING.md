# Contributing to Hive

First off, thank you for considering contributing to Hive! 🎉

Hive is built by developers, for developers, and contributions from the community are what make open source amazing. Whether you're fixing a bug, adding a feature, improving documentation, or sharing feedback, your input is valued and appreciated.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)
- [Feature Requests](#feature-requests)
- [Community](#community)

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md). We are committed to providing a welcoming and inclusive environment for all contributors.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/hive.git
   cd hive
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/morapelker/hive.git
   ```

## Development Setup

### Prerequisites

- **Node.js** 20.0.0 or higher
- **pnpm** 9.0.0 or higher
- **Git** 2.20.0 or higher (for worktree support)
- **macOS** (currently the only supported platform)

### Installation

```bash
# Install dependencies
pnpm install

# Start development mode with hot reload
pnpm dev
```

### Optional: Ghostty Terminal Setup

Hive includes an optional native terminal integration powered by Ghostty's `libghostty`. This is only needed if you want to work on the embedded terminal feature.

<details>
<summary>Click for Ghostty setup instructions</summary>

1. **Build libghostty from source**:
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```

2. **Set the library path** (if not at default location):
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. **Rebuild the native addon**:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

If `libghostty` is not available, Hive will still build and run normally — the Ghostty terminal feature will simply be disabled.

</details>

## How to Contribute

### Finding Something to Work On

- Check our [issue tracker](https://github.com/morapelker/hive/issues) for bugs and feature requests
- Look for issues labeled `good first issue` or `help wanted`
- Join our [discussions](https://github.com/morapelker/hive/discussions) to talk about ideas
- Feel free to create an issue for bugs or features before starting work

### Types of Contributions

We welcome all types of contributions:

- **🐛 Bug Fixes**: Found a bug? Fix it!
- **✨ Features**: Add new functionality
- **📝 Documentation**: Improve docs, add examples, fix typos
- **🎨 UI/UX**: Enhance the user interface or experience
- **⚡ Performance**: Optimize slow code paths
- **🧪 Tests**: Increase test coverage
- **♿ Accessibility**: Make Hive usable for everyone
- **🌐 Localization**: Translate Hive to other languages

## Development Workflow

### Architecture Overview

Hive uses Electron's three-process architecture:

- **Main Process** (`src/main/`): Node.js backend, handles IPC, database, git operations
- **Preload** (`src/preload/`): Secure bridge between main and renderer
- **Renderer** (`src/renderer/`): React frontend with Tailwind CSS

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

### Key Technologies

- **Electron 33** — Desktop app framework
- **React 19** — UI framework
- **TypeScript 5.7** — Type safety
- **Tailwind CSS 4** — Styling
- **Zustand** — State management
- **better-sqlite3** — Database
- **simple-git** — Git operations

### Project Structure

```
src/
├── main/                # Electron main process
│   ├── db/              # SQLite database
│   ├── ipc/             # IPC handlers
│   └── services/        # Core services
├── preload/             # Preload scripts
├── renderer/            # React app
│   └── src/
│       ├── components/  # UI components
│       ├── hooks/       # Custom hooks
│       ├── stores/      # Zustand stores
│       └── lib/         # Utilities
└── shared/              # Shared types
```

### Common Tasks

```bash
# Development
pnpm dev              # Start dev server with hot reload
pnpm build            # Build for production
pnpm preview          # Preview production build

# Testing
pnpm test             # Run all tests
pnpm test:watch       # Run tests in watch mode
pnpm test:e2e         # Run E2E tests

# Code Quality
pnpm lint             # Check for linting errors
pnpm lint:fix         # Auto-fix linting errors
pnpm format           # Format code with Prettier

# Build & Package
pnpm build:mac        # Build for macOS
pnpm build:win        # Build for Windows
pnpm build:linux      # Build for Linux
```

## Code Style

We use ESLint and Prettier to maintain consistent code style:

- **No semicolons** (except where required)
- **Single quotes** for strings
- **2 spaces** for indentation
- **100 character** line length
- **No trailing commas**

Run `pnpm format` before committing to ensure your code follows our style guide.

### TypeScript Guidelines

- Use explicit types for function parameters and return values
- Prefer interfaces over type aliases for object types
- Use enums for fixed sets of values
- Avoid `any` — use `unknown` if type is truly unknown

### React Guidelines

- Use functional components with hooks
- Keep components small and focused
- Extract custom hooks for reusable logic
- Use proper TypeScript types for props
- Wrap components in ErrorBoundary where appropriate

## Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run specific test file
pnpm vitest run src/renderer/src/components/Button.test.tsx

# Run E2E tests
pnpm test:e2e
```

### Writing Tests

- Place test files next to the code they test (e.g., `Button.tsx` → `Button.test.tsx`)
- Use descriptive test names that explain what is being tested
- Follow the AAA pattern: Arrange, Act, Assert
- Mock external dependencies appropriately
- Aim for high coverage but prioritize critical paths

## Pull Request Process

### Before Submitting

1. **Update your fork**:
   ```bash
   git fetch upstream
   git checkout main
   git merge upstream/main
   ```

2. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes** following our code style

4. **Write/update tests** for your changes

5. **Run tests and linting**:
   ```bash
   pnpm test
   pnpm lint
   pnpm format
   ```

6. **Commit your changes** with a descriptive message:
   ```bash
   git commit -m "feat: add amazing new feature"
   ```

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, semicolons, etc.)
- `refactor:` Code refactoring
- `perf:` Performance improvements
- `test:` Test additions or fixes
- `chore:` Maintenance tasks

Examples:
```
feat: add dark mode toggle to settings
fix: resolve worktree creation error on Windows
docs: update README with new installation steps
```

### Submitting the PR

1. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request** on GitHub

3. **Fill out the PR template** completely:
   - Describe what changes you made
   - Explain why the changes are needed
   - List any breaking changes
   - Include screenshots for UI changes
   - Reference related issues

4. **Wait for review** — maintainers will review your PR and provide feedback

5. **Address feedback** if requested

6. **Celebrate** when your PR is merged! 🎉

### PR Review Criteria

PRs are evaluated based on:

- **Code quality** — Clean, readable, maintainable
- **Tests** — Adequate test coverage
- **Documentation** — Updated docs if needed
- **Performance** — No significant performance regressions
- **Security** — No security vulnerabilities introduced
- **UI/UX** — Consistent with existing design patterns

## Reporting Issues

### Before Creating an Issue

- Search existing issues to avoid duplicates
- Try the latest version to see if it's already fixed
- Gather relevant information about your environment

### Creating a Bug Report

Use our [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include:

- Clear, descriptive title
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable
- System information (OS, Node version, etc.)
- Error messages and logs

### Security Issues

For security vulnerabilities, please read our [Security Policy](SECURITY.md) and report them privately.

## Feature Requests

We love hearing your ideas! To request a feature:

1. Check if it's already requested in [issues](https://github.com/morapelker/hive/issues) or [discussions](https://github.com/morapelker/hive/discussions)
2. Use our [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
3. Explain the problem it solves
4. Describe your proposed solution
5. Consider alternatives
6. Add mockups or examples if applicable

## Community

### Getting Help

- 📖 [Documentation](docs/) — Comprehensive guides
- 💬 [Discussions](https://github.com/morapelker/hive/discussions) — Ask questions, share ideas
- 🐛 [Issues](https://github.com/morapelker/hive/issues) — Report bugs, request features

### Staying Updated

- Watch the repository for updates
- Star the project if you find it useful
- Follow [@morapelker](https://github.com/morapelker) for announcements

## Recognition

Contributors are recognized in multiple ways:

- Listed in our [Contributors](https://github.com/morapelker/hive/graphs/contributors) page
- Mentioned in release notes for significant contributions
- Special badges for regular contributors

## Questions?

If you have questions about contributing, feel free to:

- Open a [discussion](https://github.com/morapelker/hive/discussions/new?category=q-a)
- Ask in an existing issue
- Reach out to maintainers

---

Thank you for contributing to Hive! Your efforts help make git worktree management better for everyone. 🚀