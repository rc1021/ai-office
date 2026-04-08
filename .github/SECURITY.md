# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x (latest) | ✅ |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately via [GitHub Security Advisories](https://github.com/rc1021/ai-office/security/advisories/new).

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact (data exposure, auth bypass, prompt injection, etc.)
- Suggested fix (optional)

### Response timeline

- **Acknowledgement**: within 48 hours
- **Status update**: within 7 days
- **Patch**: within 14 days for critical issues

## Scope

Issues in scope:
- Authentication bypass (identity tokens, agent scoping)
- Output gate bypass (data classification, clearance level enforcement)
- Audit trail manipulation (hash chain, tamper-evidence)
- Prompt injection via role templates or user messages
- Privilege escalation between agents (clearance levels)

Out of scope:
- Issues in third-party dependencies (report upstream)
- Self-XSS in the Pixel Office dashboard
- Rate limiting of Discord API calls
