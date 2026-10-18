# Packages

Every folder here is a deep module: a lot of behaviour behind a small interface.

```
src/packages/
  <name>/
    index.ts        ← an entry point (public). Import this from outside.
    bin.ts          ← another entry point. Packages may expose several.
    lib/            ← implementation: hidden from outside, free to import each other.
    tests/          ← tests and test helpers (a subfolder, so private).
```

**Entry points.** A package's public surface is its root files. Code outside a package may import only those, never anything in a subfolder.

**Intra-package freedom.** A package's own files import each other freely.

**Tests through the entry points.** Files under `<name>/tests/` may import any package's entry points and their own test helpers, but no package's internals, not even their own.

**No cycles.** No dependency cycles anywhere.

Avoid barrel files that re-export a whole subtree. Expose several small entry points instead, and keep the implementation in subfolders.

`npm run lint:boundaries` checks these rules with dependency-cruiser (`.dependency-cruiser.cjs`); `npm run check` runs it with the type check and lint.
