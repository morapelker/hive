# Custom Project Commands

Custom project commands allow you to define reusable prompts that appear in the project context menu. These commands support template variables for dynamic content.

## Configuration

Custom commands are stored in your settings. To add commands, you can manually edit your settings file or use the settings UI (if available).

### Settings Location

The settings are stored in your user settings database. To manually add commands, you'll need to access the settings through the Hive settings interface.

### Command Structure

Each custom command has three fields:

- `id`: A unique identifier (UUID)
- `name`: The display name shown in the context menu
- `prompt`: The prompt template with optional variables

### Example Configuration

```json
{
  "customProjectCommands": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Analyze Architecture",
      "prompt": "Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements."
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "Review Dependencies",
      "prompt": "Review all dependencies in the {{project.language}} project at {{project.path}}. Check for outdated packages and security issues."
    }
  ]
}
```

## Template Variables

The following template variables are supported:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{project.name}}` | Project name | "MyApp" |
| `{{project.path}}` | Full project path | "/Users/me/myapp" |
| `{{project.id}}` | Project UUID | "abc-123..." |
| `{{project.language}}` | Detected language | "TypeScript" |
| `{{project.description}}` | Project description | "My application" |
| `{{project.tags}}` | Project tags | "react,typescript" |

### Fallback Values

- `{{project.language}}`: "unknown" if not set
- `{{project.description}}`: "" (empty string) if not set
- `{{project.tags}}`: "" (empty string) if not set

## Usage

1. Right-click on a project in the sidebar
2. Custom commands appear above "Remove from Hive"
3. Click a custom command
4. The prompt is sent to the active session with variables replaced

## Validation

Commands are validated when settings load:

- `id` must be a non-empty string
- `name` must be a non-empty string
- `prompt` must be a non-empty string

Invalid commands are skipped with a console warning.

## Examples

### Architecture Analysis
```json
{
  "id": "arch-analysis",
  "name": "Analyze Architecture",
  "prompt": "Analyze the architecture of {{project.name}} ({{project.language}}). Focus on: 1) Code organization, 2) Design patterns, 3) Potential improvements."
}
```

### Dependency Review
```json
{
  "id": "dep-review",
  "name": "Review Dependencies",
  "prompt": "Review dependencies in {{project.path}}. Check for: 1) Outdated packages, 2) Security vulnerabilities, 3) Unused dependencies."
}
```

### Generate Tests
```json
{
  "id": "gen-tests",
  "name": "Generate Tests",
  "prompt": "Generate comprehensive test coverage for {{project.name}}. Description: {{project.description}}. Use {{project.language}} testing best practices."
}
```

## File-Based Configuration

### Overview

Custom commands can be managed via a JSON file instead of editing the database directly. This provides an easier way to add, edit, and share commands.

### File Location

Commands are stored in: `~/.hive/custom-commands.json`

### File Format

The file contains a JSON array of command objects:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Analyze Architecture",
    "prompt": "Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements."
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "Review Dependencies",
    "prompt": "Review all dependencies in {{project.path}}. Check for outdated packages and security issues."
  }
]
```

**Field Requirements:**
- `id` (string, required): Unique identifier (UUID format)
- `name` (string, required): Display name in context menu
- `prompt` (string, required): Prompt template with optional `{{project.*}}` variables

### Template File

On first launch, Hive creates a template file with example commands at `~/.hive/custom-commands.json`. You can edit this file with any text editor.

### How It Works

1. **Editing:** Edit `~/.hive/custom-commands.json` with your favorite text editor
2. **Auto-reload:** Switch back to Hive and changes are automatically detected
3. **Instant update:** Commands appear in project menu immediately

### Manual Reload

If automatic reload doesn't work, you can manually reload by calling:

```typescript
useSettingsStore.getState().reloadCustomCommands()
```

Or restart the app.

### Error Handling

| Error | Behavior |
|-------|----------|
| Invalid JSON | Error toast, previous commands still work |
| Missing required fields | Invalid commands skipped, valid ones loaded |
| File too large (>1MB) | Error toast, not loaded |
| File doesn't exist | No error, uses database commands |

### Troubleshooting

**Q: My changes aren't showing up**
- Switch to another app and back to Hive to trigger reload
- Check file path is correct: `~/.hive/custom-commands.json`
- Verify JSON syntax is valid (use a JSON validator)

**Q: I get "Invalid JSON" error**
- Check for syntax errors (missing commas, brackets)
- Use a JSON formatter to validate
- Restore from template if needed

**Q: Where is the template file?**
- macOS/Linux: `~/.hive/custom-commands.json`
- Windows: `C:\Users\<username>\.hive\custom-commands.json`

**Q: Can I use both file and database?**
- Yes, but file takes precedence when it exists
- File is automatically synced to database on load

### FAQ

**File vs Database: Which takes precedence?**
The file is always the source of truth when it exists. If `~/.hive/custom-commands.json` exists, Hive loads commands from it and syncs to the database. If the file doesn't exist, Hive uses commands from the database.

**Can I share commands between computers?**
Yes! Copy your `~/.hive/custom-commands.json` file to another computer. The file will be automatically loaded on app startup.

**How do I backup my commands?**
Copy the `~/.hive/custom-commands.json` file to a safe location. You can version control it with git if desired.
