# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of Hive seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Please DO NOT

- **Do not** create a public GitHub issue for security vulnerabilities
- **Do not** disclose the vulnerability publicly until we've had a chance to address it

### Please DO

- **Email us** at morapelker@gmail.com with details of the vulnerability
- **Include** as much information as possible:
  - Type of vulnerability (e.g., remote code execution, SQL injection, cross-site scripting)
  - Full paths of source file(s) related to the vulnerability
  - Location of the affected source code (tag/branch/commit or direct URL)
  - Step-by-step instructions to reproduce the issue
  - Proof-of-concept or exploit code (if possible)
  - Impact of the issue, including how an attacker might exploit it

### What to Expect

After you submit a vulnerability report:

1. **Acknowledgment**: We'll acknowledge receipt of your report within 48 hours
2. **Assessment**: We'll investigate and validate the issue within 7 days
3. **Resolution**: We'll work on a fix and coordinate a release timeline with you
4. **Credit**: We'll credit you for the discovery (unless you prefer to remain anonymous)

### Disclosure Policy

- We aim to patch confirmed vulnerabilities within 30 days
- We'll coordinate public disclosure with you after a fix is available
- We'll publish a security advisory on GitHub when appropriate

## Security Best Practices for Users

To keep your Hive installation secure:

### Keep Hive Updated
- Always run the latest version of Hive
- Enable automatic updates if available
- Check for updates regularly via `brew upgrade hive`

### Protect Your Data
- Keep your git repositories secure
- Use strong passwords for any integrated services
- Be cautious with AI API keys and tokens
- Review permissions when running AI coding sessions

### System Security
- Keep macOS updated with the latest security patches
- Use full disk encryption (FileVault)
- Enable firewall if working in public networks
- Regularly backup your `~/.hive` directory

### AI Session Security
- Review tool permissions before approving AI actions
- Be cautious with AI agents accessing sensitive files
- Don't share session logs containing sensitive data
- Rotate API keys periodically

## Security Features in Hive

Hive implements several security measures:

### Electron Security
- **Context Isolation**: Enabled to prevent renderer access to Node.js
- **Sandbox Mode**: Renderer processes run in a sandbox
- **Node Integration**: Disabled in renderer for security
- **Content Security Policy**: Restricts resource loading
- **HTTPS Only**: External resources loaded via HTTPS only

### Data Protection
- **Local Storage Only**: All data stored locally in `~/.hive`
- **SQLite Encryption**: Optional database encryption support
- **Secure IPC**: Type-safe IPC communication between processes
- **Permission System**: AI agents require explicit permission for sensitive operations

### Code Signing
- **macOS Notarization**: App is notarized by Apple
- **Hardened Runtime**: Enhanced runtime security on macOS
- **Automatic Updates**: Signed updates via GitHub releases

## Known Security Considerations

### Third-Party Dependencies
- We regularly update dependencies to patch known vulnerabilities
- Run `pnpm audit` to check for known issues in dependencies
- We use Dependabot to monitor and update dependencies

### AI Integration
- AI sessions run with the same permissions as the user
- Always review AI-generated code before executing
- Be cautious with AI agents that request file system access
- API keys are stored locally and never transmitted to our servers

## Security Hall of Fame

We're grateful to the security researchers who have helped make Hive more secure:

- *Your name could be here!*

## Questions?

If you have questions about this security policy, please:
- Open a [discussion](https://github.com/morapelker/hive/discussions/new?category=q-a) (for non-sensitive topics)
- Email us at morapelker@gmail.com (for sensitive topics)

---

Thank you for helping keep Hive and its users safe!