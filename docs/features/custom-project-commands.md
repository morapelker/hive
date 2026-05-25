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
