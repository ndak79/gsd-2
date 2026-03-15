# S01: DB Foundation + Decisions + Requirements — Research

**Date:** 2026-03-14

## Summary

S01 lays the foundation for all DB-backed context in GSD: installing `better-sqlite3`, creating the schema, building typed wrappers for decisions and requirements, creating SQL views that filter out superseded rows, and implementing graceful fallback when the native addon is unavailable.

The codebase already has a battle-tested pattern for optional native modules. `native-parser-bridge.ts` and `native-git-bridge.ts` both use the same `try { require('@gsd/native') } catch {}` pattern with a `loadAttempted` guard and per-function fallback. The DB module should follow this exact pattern — a `gsd-db.ts` bridge that attempts `require('better-sqlite3')` on first access, caches the result, and exposes typed wrappers. When unavailable, `isDbAvailable()` returns false, and all downstream consumers (query layer, prompt builders) fall back to the existing `inlineGsdRootFile()` path with zero code changes.

The decisions table maps directly from the current DECISIONS.md markdown table format: `| # | When | Scope | Decision | Choice | Rationale | Revisable? |`. Requirements have a richer structure with `### Rxxx —` headings and `- Field: value` lines under each. Neither has an existing TypeScript parser — `parseRequirementCounts()` only counts headings, and there's no `parseDecision()` at all. S01 needs to define the table schemas; S02 will build the actual markdown parsers. S01's query layer should work with pre-populated data (via direct inserts or tests) without depending on importers.

## Recommendation

Build three modules: `gsd-db.ts` (database lifecycle + schema), `context-store.ts` (typed query wrappers + formatters), and tests. Follow the native-parser-bridge pattern exactly for optional dependency loading. Use `optionalDependencies` in package.json (matching the existing `@gsd-build/engine-*` pattern). Place `gsd.db` at `.gsd/gsd.db` and add it to the gitignore baseline in `gitignore.ts`.

Schema should use `better-sqlite3`'s sync API throughout since all prompt building is synchronous. WAL mode via `PRAGMA journal_mode=WAL` on every `openDatabase()` call. Schema versioning via a `schema_version` table with forward-only migration functions keyed by version number.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| SQLite access from Node.js | `better-sqlite3@12.x` | Sync API matches existing sync prompt-building code. Prebuilt binaries for Node 22 on all target platforms. 12.x is current stable. |
| TypeScript types for better-sqlite3 | `@types/better-sqlite3@7.x` | Accurate types for Database, Statement, Transaction. Dev dependency only. |
| Optional native module loading | `native-parser-bridge.ts` pattern | Proven `try/catch require()` with `loadAttempted` guard. Identical fallback semantics needed here. |
| Gitignore management | `gitignore.ts` `BASELINE_PATTERNS` | Just add `".gsd/gsd.db"`, `".gsd/gsd.db-wal"`, `".gsd/gsd.db-shm"` to the existing pattern array. |
| Test runner | Node built-in `node --test` with `resolve-ts.mjs` hook | Project standard. Custom `createTestContext()` helpers for assertions. |

## Existing Code and Patterns

- `src/resources/extensions/gsd/native-parser-bridge.ts` — **Follow this pattern exactly** for optional `better-sqlite3` loading. Lazy `require()` with `loadAttempted` guard, per-function null checks, clean fallback to JS implementations. The key pattern: module-scoped `nativeModule` variable, `loadNative()` function, every public function checks `loadNative()` first.
- `src/resources/extensions/gsd/native-git-bridge.ts` — Same pattern, second example. Uses `require("@gsd/native")` with try/catch. Exports individual functions that each call `loadNative()`.
- `src/resources/extensions/gsd/gitignore.ts` — `BASELINE_PATTERNS` array is where `gsd.db` patterns need to be added. Has `ensureGitignore()` that handles idempotent appending.
- `src/resources/extensions/gsd/files.ts` — `parseRequirementCounts()` at line 627 only counts requirement headings by category. No structured requirement parser exists. No decision parser exists at all. S01 doesn't need parsers (that's S02), but the schema must match the markdown structure.
- `src/resources/extensions/gsd/auto.ts` — `inlineGsdRootFile()` at line 2492 is the function that loads entire markdown files for prompt injection. Used ~19 times across 9+ prompt builders. This is the integration point S03 will rewire, but S01's `isDbAvailable()` function is the conditional gate.
- `src/resources/extensions/gsd/types.ts` — Core type definitions. No Decision or Requirement types exist yet — they're loaded as raw markdown strings. S01 should define `Decision` and `Requirement` interfaces here.
- `src/resources/extensions/gsd/state.ts` — `deriveState()` uses `parseRequirementCounts()` for the state dashboard. S04 will rewire this to DB queries.
- `src/resources/extensions/gsd/paths.ts` — `gsdRoot()` returns `.gsd/` path. `resolveGsdRootFile()` handles file resolution. The DB path should be `join(gsdRoot(basePath), 'gsd.db')`.

## Constraints

- **ESM project with CJS native addon loading**: The project is `"type": "module"` but native addons use `require()` (see `native-parser-bridge.ts`). `better-sqlite3` must be loaded via `require()` or `createRequire()`, not `import()`. The existing bridges already solved this.
- **Sync API required**: All prompt building in `auto.ts` is synchronous (no `await` for file reads after `inlineGsdRootFile()` returns). `better-sqlite3`'s sync API is a hard requirement — async alternatives like `sql.js` won't work without rewriting the entire prompt builder chain.
- **Node 22 + arm64 darwin**: Current target is `v22.20.0 arm64 darwin`. `better-sqlite3@12.x` provides prebuilt binaries for this via `prebuild-install`. No compilation needed.
- **Schema must be future-proof for vector search (R021)**: Decisions use auto-increment `seq` as PK; requirements use stable `id` (R001, R002...). Both must be joinable by future embedding tables. Use INTEGER and TEXT PKs respectively — no composite PKs that would complicate joins.
- **`.gsd/gsd.db` must be gitignored**: It's derived local state. WAL auxiliary files (`-wal`, `-shm`) must also be gitignored.
- **Test runner uses `--experimental-strip-types`**: Tests import `.ts` files directly with the `resolve-ts.mjs` hook. New test files must follow this pattern.

## Common Pitfalls

- **WAL mode on in-memory databases**: `PRAGMA journal_mode=WAL` silently falls back to `memory` mode for `:memory:` databases. Tests using in-memory DBs won't actually test WAL. Use temp-file DBs in tests that verify WAL behavior specifically, but `:memory:` is fine for schema/query tests.
- **require() in ESM modules**: Bare `require('better-sqlite3')` won't work in ESM. Must use `createRequire(import.meta.url)` or the existing pattern from native-parser-bridge which already handles this with `// eslint-disable-next-line @typescript-eslint/no-require-imports`.
- **Schema version race conditions**: If two processes open the DB simultaneously (e.g., pi session + worktree), both might try to run migrations. Use `BEGIN IMMEDIATE` transaction for migration to get a write lock. WAL mode allows concurrent readers during this.
- **Foreign key enforcement**: SQLite has foreign keys disabled by default. Must run `PRAGMA foreign_keys = ON` after opening if any tables use FK constraints. For S01, decisions and requirements are standalone tables, but set the pattern now for S02+ tables.
- **TEXT vs JSON columns**: For fields like `supporting_slices` that hold arrays, use TEXT with comma-separated values or JSON. JSON would require `json_each()` for queries. Comma-separated is simpler for the S01 scope and matches the markdown format (e.g., `"M001/S03, M001/S06"`).
- **Prepared statement caching**: `better-sqlite3` statements should be prepared once and reused, not re-prepared per call. The `db.prepare()` result should be cached at module scope or in a statement cache object.

## Open Risks

- **`better-sqlite3` prebuilt binary freshness**: Node 22.20.0 is very recent. If `prebuild-install` doesn't have binaries for this exact Node version, it falls back to compiling from source, requiring `node-gyp` + Python + C++ compiler. This is exactly why graceful fallback (R002) is critical. Verified: `npm install better-sqlite3` succeeds on the target platform without compilation.
- **Package distribution impact**: Adding `better-sqlite3` to `optionalDependencies` increases npm package size by ~5MB (prebuilt native addon). This is acceptable for the token savings it delivers, but worth noting.
- **Schema evolution between S01 and S02**: S01 defines the schema for decisions and requirements only. S02 will add tables for roadmaps, plans, summaries, etc. The migration system must handle adding tables to an existing DB without data loss. Design the migration runner to handle version 1→2→3→...N upgrades.
- **In-memory WAL verification gap**: As noted in pitfalls, in-memory DBs don't actually use WAL mode. The R020 requirement (WAL enabled) needs a file-based test to truly verify. The platform proof-of-concept confirmed WAL works on file-based DBs.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| SQLite / better-sqlite3 | `martinholovsky/claude-skills-generator@sqlite database expert` | available (544 installs) |

Low relevance — the skill is generic SQLite guidance, not specific to `better-sqlite3` patterns or GSD's architecture. The library docs from Context7 and the existing native-bridge patterns provide better guidance than a generic skill.

## Sources

- `better-sqlite3` API: WAL mode, prepared statements, transactions (source: [Context7 better-sqlite3 docs](https://context7.com/wiselibs/better-sqlite3))
- `better-sqlite3` current version is 12.8.0, `@types/better-sqlite3` is 7.6.13 (source: npm registry)
- `node:sqlite` is available in Node 22 but still experimental, lacks `.pragma()` method (source: local runtime verification)
- Platform verification: `better-sqlite3` installs and runs correctly on Node v22.20.0 arm64 darwin with 0.01ms avg query latency (source: local proof-of-concept)
