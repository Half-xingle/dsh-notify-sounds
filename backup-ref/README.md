# backup-ref — pre-refactor sources and the one-shot migration helpers

This directory is **not** part of the plugin, the build, or the published package.
It exists so the src/ layout can be re-derived and re-verified later.

| File | What it is |
| --- | --- |
| `client.orig.js` / `index.orig.js` | The pre-refactor single-file halves, recovered from git (`git show <baseline>:lib/...`). Read-only reference. |
| `migrate-client.mjs` | Derives `src/client/index.js` from `client.orig.js`: the factory body minus its `__ModuleLoader__.load` wrapper and minus one level of factory indentation. |
| `compare-client.mjs` | Proves the rebuilt `lib/client.js` is semantically identical to `client.orig.js` (line-by-line, ignoring indentation, plus the exports surface). |
| `debug-gating.mjs` | Scratch probe used while diagnosing the settings-adoption path. Safe to delete. |

## Re-derive or re-verify

```powershell
node backup-ref/migrate-client.mjs     # src/client/index.js <- client.orig.js
node scripts/build.mjs                 # lib/ <- src/
node backup-ref/compare-client.mjs     # rebuilt bundle vs the pre-refactor bundle
```

`compare-client.mjs` must print
`compare-client: OK — the migration only moved code and changed indentation`.
Any other result means the browser half's behavior changed and needs review.
