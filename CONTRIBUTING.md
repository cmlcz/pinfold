# Contributing

Shared guidance for coding agents is in [AGENTS.md](./AGENTS.md).

## Commit messages

Use this format for commit subjects and pull request titles that will become
squash commit subjects:

```text
type: short explanation
```

Omit scopes such as `(core)` or `(cli)`. Name the component in the explanation
when it helps the reader understand the change.

| Type       | Use for                                          |
| ---------- | ------------------------------------------------ |
| `feat`     | Add a capability                                 |
| `fix`      | Correct a bug                                    |
| `refactor` | Restructure code without changing behavior       |
| `perf`     | Improve performance                              |
| `docs`     | Change documentation                             |
| `test`     | Add or improve tests                             |
| `build`    | Change packaging, build tooling, or dependencies |
| `ci`       | Change CI automation                             |
| `chore`    | Other maintenance or merge commits               |

### Subject

- Start the explanation with a lower-case imperative verb, such as `add`,
  `prevent`, `remove`, or `clarify`.
- Keep the entire subject, including the type, at most 72 characters.
- Describe the concrete change. Avoid vague subjects such as `fix bugs`,
  `update code`, or `address feedback`.
- Preserve the scope and conditions of the change; do not overstate what it does.
- Do not add a trailing period, emoji, or AI attribution.

```text
feat: save exploration runs as workflows
fix: prevent approval reuse across different program runs
refactor: share schema drift helpers
perf: cache recent sandbox type check results
docs: clarify workflow approval requirements
test: verify unreviewed writes never reach downstream servers
build: prepare the package for publication
ci: shard tests across parallel jobs
chore: merge client approval support (#41)
```

### Body and references

A subject is enough for a straightforward change. When context is needed, add a
blank line and explain what changed and why. Include relevant conditions,
tradeoffs, or migration steps. Wrap prose at 72 characters and put issue
references at the end as `Refs #N` or `Closes #N`.

Security fixes, breaking changes, migrations, and reverts need a body explaining
the impact. Mark breaking changes with `!` before the colon and include a
`BREAKING CHANGE:` footer describing the required migration. Use `fix` for a
revert that corrects behavior or `chore` for other reverts, and identify the
reverted commit in the body.

```text
fix: block writes when adapters change after approval

Compare adapter digests before applying or resuming a plan. Stop before
sending writes if the adapters differ from those the developer approved.

Refs #54
```

Never add a `Co-Authored-By` line or any other AI attribution trailer.

### Merge commits

Use `chore: merge short explanation (#N)` for pull request merges. For branch
synchronization, use `chore: merge main into short branch purpose`. Keep merge
commits as merges; changing their message does not require squashing them.
