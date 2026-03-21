# Frequently Asked Questions (FAQ)

## General Questions

### What is Hive?
Hive is a native macOS application that combines git worktree management with AI-powered coding assistance. It allows you to work on multiple branches simultaneously without the hassle of stashing and switching.

### Is Hive free?
Yes, Hive is free and open source under the MIT license.

### Which platforms does Hive support?
Currently, Hive is macOS-only. Windows and Linux support are planned for future releases.

### Do I need to know git worktrees to use Hive?
No! Hive handles all the worktree complexity for you. If you can use git branches, you can use Hive.

## Installation & Setup

### What are the system requirements?
- macOS 12.0 (Monterey) or later
- Node.js 20+ (for development only)
- Git 2.20+ (for worktree support)
- At least 4GB RAM
- 500MB free disk space

### How do I install Hive?
The easiest way is via Homebrew:
```bash
brew tap morapelker/hive
brew install --cask hive
```

Alternatively, download the `.dmg` file from [GitHub Releases](https://github.com/morapelker/hive/releases).

### Why does macOS say "Hive can't be opened"?
This is macOS's Gatekeeper protection. To fix:
1. Right-click on Hive in Applications
2. Select "Open"
3. Click "Open" in the dialog
4. This only needs to be done once

### How do I update Hive?
If installed via Homebrew:
```bash
brew upgrade hive
```

Otherwise, download the latest version from GitHub Releases.

## Git & Worktrees

### What is a git worktree?
A worktree is a linked working copy of your repository. Think of it as having multiple copies of your repo, each on different branches, without duplicating the entire `.git` history.

### Where does Hive store worktrees?
By default, worktrees are stored in:
```
~/.hive-worktrees/{project-name}/{worktree-name}
```

### Can I use existing worktrees?
Yes, if you have existing git worktrees, Hive will detect and manage them.

### What happens when I archive a worktree?
Archiving a worktree:
- Removes it from the active list
- Preserves the branch
- Moves files to `~/.hive-archive`
- Keeps session history searchable

### Can I delete branches through Hive?
Yes, use the "Unbranch" option to remove both the worktree and its associated branch.

### Why do worktrees have city names?
Hive uses city names (Tokyo, Paris, London, etc.) to make worktrees memorable and fun. It's easier to remember "the Tokyo worktree" than "feature/user-auth-refactor-v2".

### What if I run out of city names?
Hive has 200+ city names. If all are used, it adds version suffixes (tokyo-v1, tokyo-v2). You can also rename worktrees.

## Connections

### What is the Connections feature?
Hive's Connections feature allows you to link two worktrees together, creating a bridge between different branches. This enables you to reference code from one branch while working in another, share AI session context, and maintain awareness of related changes across your project.

### Why would I connect two worktrees?
Common scenarios include:
- Keeping your main branch visible while working on features
- Comparing different implementations side-by-side
- Working on related frontend and backend branches simultaneously
- Sharing AI session context between branches
- Reviewing changes with full context from both branches
- Ensuring compatibility between branches during development

### How do I connect two worktrees?
1. Open the first worktree
2. Click the Connections icon (🔌) in the toolbar
3. Select "Connect to Worktree"
4. Choose the worktree you want to connect to
5. The connection is established immediately

### Can I connect more than two worktrees?
Yes! A single worktree can connect to up to 3 other worktrees simultaneously. Each connection appears in its own tab in the connections panel.

### What information is shared between connected worktrees?
Connected worktrees can share:
- File references (read-only by default)
- AI session context (when enabled in settings)
- Git status and change information
- Terminal output (optional)
- Build and test status

### Are changes synchronized between connected worktrees?
No, connections don't synchronize changes. Each worktree remains independent. Connections provide visibility and context, not synchronization. You can view and reference files from connected worktrees but changes stay in their respective branches.

### Do connections persist after closing Hive?
Yes! Connections are saved and will be restored when you reopen Hive. You can also save connection patterns as templates for quick reuse.

### Can AI sessions access connected worktrees?
Yes, when AI session sharing is enabled, you can reference code from connected worktrees. For example: "Apply the same pattern used in the connected worktree's authentication system."

### What happens if I archive a connected worktree?
The connection becomes "broken" and shows a red indicator. You can either disconnect or wait until the worktree is restored. The connection configuration is preserved in case you want to restore it later.

### How do I disconnect worktrees?
Three ways:
1. Click the connection icon and select "Disconnect"
2. Use the keyboard shortcut `Cmd+Shift+D`
3. Right-click on the connection in the panel and choose "Disconnect"

### Can I create connection templates?
Yes! After setting up a connection pattern you use frequently (like "feature branch + main"), you can save it as a template. Then quickly apply that template to new worktrees.

### What are the performance implications?
Connections are lightweight and don't impact performance significantly. File references are loaded on-demand, and only metadata is kept in memory. With 3 or fewer connections per worktree, there's negligible overhead.

### How do I know which worktrees are connected?
Look for these indicators:
- 🔗 icon in the worktree sidebar
- Badge showing number of connections
- Green highlight when actively connected
- Connection panel showing all linked worktrees

## AI Coding Sessions

### Which AI providers does Hive support?
- **OpenCode SDK** - Default provider with full features
- **Claude Code SDK** - Anthropic's Claude assistant

### Do I need API keys?
It depends on your configuration:
- OpenCode: May require API key depending on setup
- Claude Code: Requires Anthropic API key

### How do I set up API keys?
1. Open Settings (`Cmd+,`)
2. Navigate to AI Providers
3. Enter your API keys
4. Keys are stored locally and encrypted

### What can AI sessions do?
AI sessions can:
- Read and write files
- Run terminal commands (with permission)
- Search your codebase
- Refactor code
- Generate tests
- Debug issues
- Answer questions about your code

### Are my code and conversations private?
Yes. All AI interactions happen directly between your machine and the AI provider's API. Hive doesn't store or transmit your code to any intermediary servers.

### Can I undo AI changes?
- **OpenCode**: Full undo/redo support
- **Claude Code**: Undo only (rewind functionality)

### Why did my AI session disconnect?
Common reasons:
- Internet connection issues
- API rate limits reached
- Invalid or expired API key
- Session timeout (usually after 30 minutes of inactivity)

## Performance & Troubleshooting

### Hive is running slowly. What can I do?
1. Limit open worktrees to 10-15
2. Close unused file tabs
3. Disable unused language servers in settings
4. Check Activity Monitor for memory usage
5. Restart Hive if it's been running for days

### The file tree isn't showing all files
Hive respects `.gitignore` by default. To show ignored files:
1. Open Settings
2. Toggle "Show ignored files"

### Language features (autocomplete, etc.) aren't working
1. Ensure the language server is installed
2. Check Settings → Language Servers
3. Restart the language server from the command palette
4. Some languages require additional setup (see documentation)

### How do I reset Hive to defaults?
To completely reset Hive:
1. Quit Hive
2. Delete `~/.hive` directory
3. Delete `~/Library/Application Support/hive`
4. Restart Hive

**Warning**: This will remove all projects, settings, and session history.

### Where are Hive's logs?
Logs are stored in:
```
~/Library/Logs/hive/
```

Use Console.app or `tail -f ~/Library/Logs/hive/main.log` to view them.

## Data & Privacy

### Where does Hive store its data?
- Database: `~/.hive/hive.db` (SQLite)
- Worktrees: `~/.hive-worktrees/`
- Archives: `~/.hive-archive/`
- Logs: `~/Library/Logs/hive/`
- Settings: `~/Library/Application Support/hive/`

### Is my data backed up?
Hive doesn't automatically backup data. We recommend:
- Using Time Machine for system backups
- Backing up `~/.hive` for settings and history
- Your git repositories are already backed up via git

### Can I sync settings across machines?
Not yet, but this feature is on our roadmap. For now, you can manually copy the `~/.hive` directory.

### Does Hive collect telemetry?
Hive includes optional, anonymous usage analytics via PostHog. You can disable this in Settings → Privacy.

## Common Issues

### "Permission denied" when creating worktrees
Ensure you have write permissions to:
- The repository directory
- `~/.hive-worktrees/`

### Git operations fail with "not a git repository"
This usually means:
- The repository is corrupted
- The `.git` directory is missing
- You're in a subdirectory without git initialized

### Can't commit: "Please tell me who you are"
Set your git identity:
```bash
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
```

### Worktree creation fails immediately
Check:
- Disk space (need at least 100MB free)
- Git version (`git --version` should be 2.20+)
- Repository isn't bare or corrupted

## Advanced Usage

### Can I use Hive with monorepos?
Yes! Hive works great with monorepos. Each worktree can focus on different parts of your monorepo.

### Does Hive support git submodules?
Yes, with limitations. Submodules are supported but may require manual initialization in each worktree.

### Can I use custom git hooks?
Yes, place hooks in your repository's `.git/hooks/` directory. They'll apply to all worktrees.

### How do I use Hive with CI/CD?
Worktrees are regular git checkouts, so they work with any CI/CD system. Push from a worktree and your CI/CD will trigger normally.

### Can I script Hive operations?
Not directly, but you can:
- Use git commands on worktree directories
- Access the SQLite database at `~/.hive/hive.db`
- Use the command palette for common operations

## Getting Help

### Where can I report bugs?
[Create an issue](https://github.com/morapelker/hive/issues) on GitHub with:
- Steps to reproduce
- Expected vs actual behavior
- System information
- Screenshots if applicable

### How can I request features?
[Open a discussion](https://github.com/morapelker/hive/discussions) or [create a feature request](https://github.com/morapelker/hive/issues/new?template=feature_request.md).

### Where can I find more documentation?
- [User Guide](GUIDE.md) - Detailed usage instructions
- [Contributing](../CONTRIBUTING.md) - How to contribute
- [Architecture](../CLAUDE.md) - Technical deep dive

### How can I contribute?
See our [Contributing Guidelines](../CONTRIBUTING.md). We welcome:
- Bug fixes
- Feature additions
- Documentation improvements
- Translations

### Is there a community Discord/Slack?
Not yet, but join our [GitHub Discussions](https://github.com/morapelker/hive/discussions) to connect with other users.

---

Still have questions? [Open a discussion](https://github.com/morapelker/hive/discussions/new?category=q-a) and we'll help!