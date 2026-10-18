# pinfold

Design: `idea-codemode-mcp-workflow-compiler.md`. Vocabulary: `GLOSSARY.md`. Decisions: `docs/adr/`.

Packages are deep modules: see [src/packages/README.md](./src/packages/README.md) before adding or importing one.

## Checks

`npm run check` (type check, lint, module boundaries) and `npm test`. Source runs directly on Node's type stripping, so relative imports carry the `.ts` extension and only erasable TypeScript syntax is allowed.

## Commits

- Use Conventional Commits: `type(scope): subject`, where `type` is one of `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`. The scope is optional.
- Subject: imperative mood, lower case, no trailing period, at most 72 characters.
- Body (after a blank line): what changed and why, wrapped at 72 characters. Reference tickets as `Refs #N` or `Closes #N`.
- Never add a `Co-Authored-By` line or any other AI attribution trailer.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on cmlcz/pinfold, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, each label named after its role (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
