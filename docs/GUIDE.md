# Hive User Guide

Welcome to Hive! This guide will help you get the most out of Hive's powerful features for managing git worktrees and AI-powered coding sessions.

## Table of Contents

- [Getting Started](#getting-started)
- [Core Concepts](#core-concepts)
- [Working with Projects](#working-with-projects)
- [Managing Worktrees](#managing-worktrees)
- [AI Coding Sessions](#ai-coding-sessions)
- [Connections](#connections)
- [File Management](#file-management)
- [Git Operations](#git-operations)
- [Using Spaces](#using-spaces)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Tips and Tricks](#tips-and-tricks)

## Getting Started

### First Launch

When you first open Hive, you'll see an empty project list. Let's add your first project!

1. Click the **"Add Project"** button
2. Navigate to any git repository on your machine
3. Select the repository folder and click "Open"

Hive will analyze your repository and display it in the sidebar.

### Understanding the Interface

Hive's interface is divided into three main areas:

- **Left Sidebar**: Projects and worktrees navigation
- **Main Pane**: Active worktree content, file viewer, or AI session
- **Right Panel**: File tree, git status, and other contextual tools

## Core Concepts

### Projects vs Worktrees

- **Project**: A git repository on your machine
- **Worktree**: An isolated working copy of a specific branch

Think of worktrees as parallel universes for your code — each one can have different branches checked out simultaneously without affecting others.

### Why Worktrees?

Traditional git workflow:
```bash
git stash
git checkout feature-branch
# Work on feature
git stash
git checkout main
git stash pop
```

With Hive worktrees:
- Click on the worktree for `feature-branch`
- Work on feature
- Click on the worktree for `main`
- Both remain exactly as you left them!

## Working with Projects

### Adding Projects

You can add projects in multiple ways:

1. **GUI Method**: Click "Add Project" button
2. **Drag and Drop**: Drag a git repository folder into Hive
3. **Command Palette**: Press `Cmd+K` and type "Add Project"

### Project Actions

Right-click on any project to:
- Open in Finder
- Open in Terminal
- Copy repository path
- Remove from Hive (doesn't delete files)
- View project settings

### Project Organization

Projects can be organized into Spaces (see [Using Spaces](#using-spaces)) and pinned for quick access.

## Managing Worktrees

### Creating a Worktree

1. Select a project
2. Click **"New Worktree"**
3. Choose an existing branch or create a new one
4. Hive automatically assigns a unique city-based name (e.g., "tokyo", "paris")

### Worktree Naming

Hive uses a clever naming system:
- Each worktree gets a city name from a pool of 200+ cities
- If a city is taken, it adds a version suffix (-v1, -v2, etc.)
- You can rename worktrees after creation

### Worktree Actions

- **Open**: Click to open the worktree in the main pane
- **Archive**: Safely remove the worktree while preserving the branch
- **Unbranch**: Remove the worktree and delete the branch
- **Terminal**: Open a terminal in the worktree directory
- **Copy Path**: Copy the worktree's file system path

### Archived Worktrees

Archived worktrees are moved to `~/.hive-archive` and can be:
- Restored later if needed
- Permanently deleted to free up space
- Searched in session history

## AI Coding Sessions

### Starting a Session

1. Open a worktree
2. Click **"New Session"**
3. Choose your AI provider:
   - **OpenCode**: Full-featured with undo/redo support
   - **Claude Code**: Anthropic's coding assistant
   - **Codex**: OpenAI's coding agent

### During a Session

#### Giving Instructions
Type your request in the chat input. Be specific about what you want:
- ✅ "Add a dark mode toggle to the settings page"
- ❌ "Make it better"

#### Tool Permissions
When the AI needs to perform actions, you'll see permission requests:
- **Read files**: Allow the AI to read specific files
- **Write files**: Allow modifications to files
- **Run commands**: Execute terminal commands

Always review what the AI wants to do before approving!

#### Undo/Redo
- **OpenCode**: Full undo/redo support with `Cmd+Z` / `Cmd+Shift+Z`
- **Claude Code**: Undo only (rewind to previous state)
- **Codex**: Undo only (rollback to previous state)

### Session Management

- **Pause**: Temporarily stop the session
- **Resume**: Continue a paused session
- **Archive**: Save the session for later reference
- **Export**: Export chat history as markdown

### Best Practices

1. **Be Specific**: Clear instructions get better results
2. **Review Changes**: Always review AI-generated code
3. **Test Incrementally**: Test changes as you go
4. **Use Undo**: Don't hesitate to undo if something goes wrong
5. **Save Context**: Archive important sessions for reference

## Connections

Hive's Worktree Connections feature allows you to link two worktrees together, creating powerful workflows for development across multiple branches.

### Understanding Worktree Connections

Worktree connections create a bridge between two branches, allowing you to:
- View and reference code from another branch while working
- Share AI session context across branches
- Compare implementations side-by-side
- Maintain awareness of related changes

### Creating Your First Connection

1. Open a worktree (your "source")
2. Click the **Connections** icon (🔌) in the toolbar
3. Select **"Connect to Worktree"**
4. Choose the target worktree from the list
5. The connection is established immediately

### Connection Types

#### Reference Connections
Keep another branch visible for reference:
- Main branch while working on features
- Previous implementation during refactors
- Documentation branch while coding

#### Collaboration Connections
Work on related features simultaneously:
- Frontend and backend branches
- API and client implementations
- Shared library and consumer branches

#### Comparison Connections
Compare different approaches:
- Performance optimizations
- Alternative implementations
- Before/after refactoring

### Using Connected Worktrees

#### The Connection Panel
When worktrees are connected, you'll see:
- **File Browser** - Browse files from the connected worktree
- **Changes View** - See what's different in the connected branch
- **Quick Actions** - Switch, diff, or copy between worktrees
- **Status Bar** - Connection health and sync status

#### Navigating Between Connected Worktrees
- Click the connection indicator to switch
- Use `Cmd+Shift+W` to toggle between connected worktrees
- Drag files from one worktree to another
- Open files from both worktrees side-by-side

#### Sharing Context
Connected worktrees share:
- File references (read-only by default)
- AI session context (when enabled)
- Terminal output (optional)
- Git status information

### Advanced Features

#### Smart Diff View
Compare files between connected worktrees:
1. Select a file in your current worktree
2. Click "Compare with Connected"
3. See a side-by-side diff
4. Apply changes selectively

#### AI Session Sharing
AI sessions can access both worktrees:
```
"Look at the implementation in the connected worktree and apply the same pattern here"
```

#### Connection Persistence
Connections are remembered:
- Survive Hive restarts
- Restore when worktrees are reopened
- Can be saved as connection profiles

#### Connection Templates
Save common connection patterns:
- "Feature + Main" template
- "Frontend + Backend" template
- "Bug Fix + Production" template

### Connection Management

#### Connection States
- 🟢 **Active** - Both worktrees open and synced
- 🟡 **Standby** - One worktree closed but connection saved
- 🔴 **Broken** - Target worktree archived or deleted
- 🔄 **Syncing** - Updating file references

#### Multiple Connections
A worktree can connect to multiple others:
- Maximum of 3 connections per worktree
- Each connection has its own panel
- Switch between connections with tabs

#### Disconnecting
To disconnect worktrees:
1. Click the connection icon
2. Select "Disconnect"
3. Or use `Cmd+Shift+D` shortcut

### Best Practices

1. **Connect Related Work** - Link branches that share context
2. **Use for Reviews** - Connect author and reviewer worktrees
3. **Maintain Main Connection** - Keep main branch connected for reference
4. **Clean Up Stale Connections** - Disconnect archived worktrees
5. **Name Connections** - Give meaningful names to connection profiles

### Tips and Tricks

#### Quick Connection Workflow
1. Press `Cmd+K` then `C` to open connection dialog
2. Type partial worktree name
3. Press Enter to connect
4. Use `Cmd+Option+W` to switch

#### Connection Shortcuts
- `Cmd+K C` - Connect worktrees (Cmd+K then C)
- `Cmd+Option+W` - Switch between connected
- `Cmd+K D` - Disconnect (Cmd+K then D)
- `Cmd+Option+D` - Diff with connected

#### Visual Indicators
Look for these connection indicators:
- 🔗 in the sidebar - Worktree has connections
- Badge number - Shows connection count
- Color coding - Active (green), standby (yellow)
- Animation - Pulsing when syncing

## File Management

### File Tree

The file tree shows:
- 📁 Folders (expandable)
- 📄 Files (click to open)
- 🟢 New files (git status)
- 🟡 Modified files (git status)
- 🔴 Deleted files (git status)

### File Operations

- **Open**: Click any file to view it
- **Edit**: Double-click to open in the integrated editor
- **Search**: `Cmd+P` for quick file search
- **Filter**: Type in the filter box to narrow results

### Integrated Editor

Hive includes a full Monaco editor (VS Code's editor):
- Syntax highlighting
- Code completion
- Go-to-definition
- Find and replace
- Multiple cursors

## Git Operations

### Viewing Changes

The git panel shows:
- Staged changes
- Unstaged changes
- Untracked files

Click any file to see its diff.

### Committing Changes

1. Stage files by clicking the "+" icon
2. Enter a commit message
3. Click "Commit" or press `Cmd+Enter`

### Branch Operations

- **Create Branch**: Right-click on worktree → "New Branch"
- **Switch Branch**: Not needed! Each worktree has its own branch
- **Merge**: Use the git panel or terminal
- **Push/Pull**: Available in the git panel

### Viewing History

- Click "History" to see commit history
- Click any commit to see its changes
- Search history with `Cmd+F`

## Using Spaces

Spaces help organize related projects and worktrees.

### Creating a Space

1. Click "New Space" button
2. Name your space (e.g., "Work", "Personal", "Open Source")
3. Drag projects into the space

### Space Benefits

- **Organization**: Group related work
- **Quick Switching**: `Cmd+1-9` to switch spaces
- **Isolation**: Different spaces for different contexts
- **Pinning**: Pin important items within each space

## Keyboard Shortcuts

### Essential Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Open command palette |
| `Cmd+P` | Quick file search |
| `Cmd+Shift+P` | Quick project search |
| `Cmd+N` | New worktree |
| `Cmd+Shift+N` | New session |
| `Cmd+,` | Open settings |
| `Cmd+1-9` | Switch to space 1-9 |
| `Cmd+0` | Show all spaces |

### Editor Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+S` | Save file |
| `Cmd+Z` | Undo |
| `Cmd+Shift+Z` | Redo |
| `Cmd+F` | Find in file |
| `Cmd+Shift+F` | Find in workspace |
| `Cmd+D` | Select next occurrence |
| `F12` | Go to definition |

### Git Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Enter` | Commit (when in message field) |
| `Cmd+Shift+S` | Stage all changes |
| `Cmd+Shift+U` | Unstage all changes |

## Tips and Tricks

### Productivity Tips

1. **Use City Names**: Remember worktrees by their city names instead of branch names
2. **Pin Favorites**: Pin frequently used worktrees for quick access
3. **Keyboard Navigation**: Master `Cmd+K` for speed
4. **Multiple Sessions**: Run different AI sessions in different worktrees
5. **Quick Switch**: Use `Cmd+Tab` within Hive to switch worktrees

### Advanced Features

#### Custom Scripts
Create setup scripts that run when creating new worktrees:
1. Settings → Scripts
2. Add commands like `npm install`, `bundle install`, etc.
3. Scripts run automatically for new worktrees

#### Terminal Integration
- Each worktree can have its own terminal session
- Terminals persist across Hive restarts
- Use `Cmd+T` to toggle terminal

#### LSP Support
Hive includes Language Server Protocol support:
- TypeScript, Python, Go, Rust, and more
- Automatic language server detection
- Per-worktree isolation

### Troubleshooting

#### Worktree Won't Create
- Ensure you have git 2.20+ installed
- Check available disk space
- Verify repository isn't corrupted

#### AI Session Not Responding
- Check your internet connection
- Verify API keys in settings
- Try switching AI providers

#### Performance Issues
- Limit open worktrees to 10-15
- Close unused file tabs
- Disable unused language servers

## Next Steps

Now that you understand the basics:

1. Set up your first project and create multiple worktrees
2. Try an AI coding session with a simple task
3. Organize your work with Spaces
4. Customize settings to your preference
5. Explore keyboard shortcuts for speed

Happy coding with Hive! 🐝