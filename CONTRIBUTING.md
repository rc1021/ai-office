# Contributing to AI Office

Thank you for your interest in contributing to AI Office!

## Before You Start

- Read [CLAUDE.md](CLAUDE.md) for project conventions and architecture
- Check existing [Issues](https://github.com/rc1021/ai-office/issues) to avoid duplicate work
- For large features, open an issue first to discuss the approach

## Development Setup

### Prerequisites

- Node.js >= 22
- npm
- Claude Code (for testing agent behavior end-to-end)

### Local Setup

```bash
git clone https://github.com/<your-username>/ai-office.git
cd ai-office
git remote add upstream https://github.com/rc1021/ai-office.git

# Install dependencies per package
for pkg in core coordination discord-bot orchestrator setup; do
  npm install --prefix $pkg
done

# Build (core must build first)
npm run build --prefix core
for pkg in coordination discord-bot orchestrator setup; do
  npm run build --prefix $pkg
done
```

Unit tests run without a Discord bot or ngrok:

```bash
cd coordination && npm test
cd discord-bot && npm test
cd orchestrator && npm test
```

## Contribution Flow

All external PRs must target the `develop` branch — **not** `main`.

```
1. Fork rc1021/ai-office on GitHub
2. Clone your fork and add upstream:
   git remote add upstream https://github.com/rc1021/ai-office.git

3. Sync and create your branch:
   git fetch upstream
   git checkout -b feat/my-feature upstream/develop

4. Make changes, run tests:
   cd coordination && npm test
   cd discord-bot && npm test

5. Commit using Conventional Commits:
   git commit -m "feat(roles): add legal-compliance-officer template"

6. Push and open PR:
   git push origin feat/my-feature
   # Open PR on GitHub: base = develop, compare = your branch

7. Fill in the PR template fully and respond to review feedback
```

## Commit Message Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

| Type | When |
|------|------|
| `feat` | New feature, role template, or MCP tool |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code restructure, no behavior change |
| `test` | Adding or fixing tests |
| `chore` | Build, deps, config changes |
| `security` | Security-related changes (high priority) |
| `perf` | Performance improvements |

Scopes: `(roles)`, `(coordination)`, `(discord-bot)`, `(core)`, `(pixel-office)`, `(ci)`, `(setup)`, `(cli)`

## PR Size Guidelines

- **Small** (preferred): < 400 lines, single concern
- **Medium**: 400–800 lines — describe all changes clearly
- **Large**: > 800 lines — split if possible; if unavoidable, open a design issue first

## Adding a Role Template

1. Create `roles/templates/<role-id>.yaml` (kebab-case)
2. Validate against the schema: `roles/schemas/role-template.schema.json`
3. Add to `roles/role-index.yaml` with `id`, `en`, `zh-TW`, `ja`, `department`, `category`
4. The CI `validate-roles` job will check your template automatically

## What NOT to Contribute

- `.env` files, secrets, or credentials (already in `.gitignore`)
- Changes to security-critical files without explicit discussion:
  - `coordination/src/token-middleware.ts`
  - `core/src/output-gate.ts`
  - The 4 non-overridable security rules in `agents/leader/CLAUDE.md`
- Runtime state files: `config/active-roles.yaml`, `.mcp.json` (user-specific)

## Security Vulnerabilities

Do **not** open a public issue for security vulnerabilities. Instead, use [GitHub Security Advisories](https://github.com/rc1021/ai-office/security/advisories/new) to report privately. See [SECURITY.md](.github/SECURITY.md) for details.

## License

By contributing, you agree that your contributions will be licensed under the same [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) license as the project.
