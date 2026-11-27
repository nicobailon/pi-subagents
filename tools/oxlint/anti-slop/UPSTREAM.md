# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop, `skills/install-anti-slop/assets/anti-slop/`
- Current snapshot: commit `63dbb09` (2026-11-20). Dependencies: `oxlint` and `@oxlint/plugins` pinned at 1.95.0.
- Earlier base: commit `6d53855` (2026-08-18), first vendored in this repo by `e3cd44ac`. Its files matched that commit, except for the two local edits below.
- Installed paths: `index.ts` (generic plugin), `effect/index.ts` (Effect plugin, vendored but not registered: this repo has no direct `effect` dependency), `rules/`, `shared/`, `effect/rules/`, `effect/shared/`, `vendor/eslint-stylistic/` (keep its LICENSE and UPSTREAM.md).

## Local deviations

- `shared/lexical-type-parameters.ts` reads node keys with `Object.getOwnPropertyDescriptor` instead of a `Record` cast. Upstream left the file unchanged since `6d53855`, so the local version is kept.
- `rules/no-unknown-type-aliases.ts` had a local check for unions that hide `unknown`. Upstream now covers that case through `shared/type-alias-resolution.ts`, so the upstream file replaced the local edit.
- `shared/type-alias-resolution.ts` `aliasSubstitutions` starts each alias with only its own type parameters (`new Map()`, not `new Map(base)`). Upstream let a caller's parameter replace a same-named module alias inside an unrelated alias, so `type T = string; type Fixed = T; type Wrap<T> = Fixed | { item: T }; type R = Wrap<unknown>` was reported as hiding `unknown`.

## Rules

`npm run lint` checks `index.ts`, `src` and `scripts`. Tests are not linted. CI runs it in the typecheck leg of `.github/workflows/test.yml`.

These are on at `error`: `no-module-mocking`, `no-reduce-accumulator-copy`, `no-reflect-apply`, `no-shape-in-symbol-names`, `no-unknown-type-aliases`, `no-widen-then-assert`, and the native `oxc/no-accumulating-spread`.

These are off, so not in `.oxlintrc.json`:

| Rule | Findings in src at `63dbb09` | Why it's off |
|---|---|---|
| `require-readable-spacing` | 19,151 | Blank-line style the code base doesn't follow; adopting it means reformatting every file. |
| `no-conditional-empty-object-spread` | 2,753 | `...(x ? { a } : {})` is the house idiom for optional fields. |
| `no-runtime-typeof` | 2,154 | Mostly input checks at file, process and network boundaries, which is where the repo wants validation. |
| `require-safety-comment-for-type-assertion` | 1,501 | The repo doesn't use code comments. |
| `no-unknown-parameters` | 730 | `unknown` is the honest input type for untrusted JSON and host payloads before they are narrowed. |
| `no-unsafe-dictionary-type` | 610 | Same boundary records (`Record<string, unknown>`) that the narrowing code reads. |
| `no-known-value-widening` | 433 | Flags every explicit inline object type on a return or variable, such as `): { error: string } \| …`. The repo writes these contracts inline on purpose. |
| `no-unknown-returns` | 69 | JSON readers, JSON-pointer lookups and redaction helpers return arbitrary JSON, and host callbacks have ignored return values. A named type there would be unvalidated, and dropping the annotation would turn the result into `any`. |
| `no-array-filter-map` | 60 | Iterator helpers aren't available: `tsconfig` uses lib ES2023, and workflows also run on Bun. Rewriting with `flatMap` makes short pipelines harder to read. |
| `no-chained-type-assertions` | 51, now 23 | 28 were rewritten as single assertions. The other 23 are field-checked JSON files cast to their domain type, plus Pi host APIs typed through `on`/`registerTool` overloads. Removing them needs schema validators for each persisted file format. |
| `no-object-parameters` | 26 | `object` is the right type for WeakMap identity keys (session manager, UI) and for the generic JSON writers. |
| `no-reflect-get` | 4 | All four are inside Proxy `get` traps, where `Reflect.get` is the correct call. |

Native Oxlint defaults that are off or configured:

| Rule | Setting | Why |
|---|---|---|
| `eslint/no-control-regex` | off | Control-character validation and ANSI stripping are intentional. |
| `eslint/no-unsafe-finally` | off | `finally` blocks rethrow cleanup errors on purpose (`shared/atomic-json.ts` only when the write itself succeeded; the other sites for anything but ENOENT). |
| `unicorn/no-useless-spread` | off | The remaining spreads take a snapshot of a live Map before a loop that mutates it. |
| `eslint/no-unused-vars` | `ignoreRestSiblings`, `^_` patterns | `const { omitted, ...rest } = value` is the omit idiom. |

## Next update

Use `6d53855` as the base for `lexical-type-parameters.ts`, and `63dbb09` for everything else, including the `aliasSubstitutions` fix.
