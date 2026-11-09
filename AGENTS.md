# pinfold

Design: `idea-codemode-mcp-workflow-compiler.md`. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

Packages are deep modules: see [src/packages/README.md](./src/packages/README.md) before adding or importing one.

## Checks

`npm run check` (type check, lint, module boundaries) and `npm test`. Source runs directly on Node's type stripping, so relative imports carry the `.ts` extension and only erasable TypeScript syntax is allowed.

## Commits

Follow [CONTRIBUTING.md](./CONTRIBUTING.md#commit-messages) for every commit
message and pull request squash title. Use `type: short explanation`, without
scopes, with an imperative summary of at most 72 characters.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on cmlcz/pinfold, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, each label named after its role (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
