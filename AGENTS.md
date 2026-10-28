# nonprofits

Shared instructions for coding agents. Stack, commands, layout, conventions, and the Never list live here. Claude Code loads this file from `.claude/CLAUDE.md`; Cursor loads it from `.cursor/rules/project.mdc`.

## Stack

- **Node 24**, from `.nvmrc`; CI reads it through `actions/setup-node`'s `node-version-file`. Only `.cursor/environment.json` pins a patch (`NODE_VERSION`), and its `NODE_SHA256` has to change with it: the install checks the tarball against that hash.
- **pnpm**, the version in the root `packageManager` field. CI's `pnpm/action-setup` reads it; `.cursor/environment.json` repeats it as `PNPM_VERSION`, so a bump changes both.
- **TypeScript**, **Biome**, and **Vitest**, versions in the `catalog` of `pnpm-workspace.yaml`.
- **Libraries**, same catalog: Hono, `@modelcontextprotocol/server`, `@libsql/client`, `better-auth` and `@better-auth/api-key`, Kysely, Zod, `csv-parse`, `@vercel/firewall`, `@vercel/functions`. A package depends on a catalog entry with `"catalog:"`. Do not pin a different version in a package; nothing checks this.

## Commands

CI's check job is these two commands, in order:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` (root `package.json`) is the gate a change has to pass: Biome, then typecheck, then the whole Vitest suite.

Before a commit, `.claude/skills/verify/` runs the quick pair: `pnpm exec biome check .`, then `pnpm typecheck`. `pnpm format` leaves import order alone, which `biome check` also gates; `pnpm exec biome check --write .` fixes both.

How to run the API, mint a local key, or build a month of IRS data: [CONTRIBUTING.md](CONTRIBUTING.md). How the suite is laid out: [TESTING.md](TESTING.md).

## Layout and boundaries

| Package | Owns | May import |
| --- | --- | --- |
| `@nonprofits/core` | EIN, lookup, search, result types | Nothing in the workspace. No runtime dependencies. |
| `@nonprofits/db` | Schema, app migrations, served-database pointer, search index and search query, fixtures | `@libsql/client` only |
| `@nonprofits/api` | Hono app on Vercel: `/v1`, `/mcp`, admin key routes, daily cron | `core`, `db` |
| `@nonprofits/import` | Monthly IRS bulk-file job and `.github/workflows/import.yml` | `db` |
| `@nonprofits/cli` | API-key admin. Talks to the api over HTTP | In tests only, `@nonprofits/api/test-support` |

`pnpm typecheck` enforces the "May import" column: a workspace package missing from a package's `dependencies` and `devDependencies` does not resolve there. `cli`'s "in tests only" is the exception: `@nonprofits/api` is a `cli` devDependency, so nothing stops `cli`'s `src` importing it. Nothing checks that `core` stays free of I/O, SQL, and framework code.

A new variable the api reads goes in `PRODUCTION_ENV` (`packages/api/src/production.ts`) and in `packages/api/.env.example`, a `required` or `secret` one as a `replace-with-` placeholder and an `optional` one empty; `packages/api/src/deploy.test.ts` fails when the two lists differ or when the example sets a `required` or `secret` variable to a value that would serve. A test runs only if its path matches `packages/*/{src,test}/**/*.test.ts` (`vitest.config.ts`).

## Conventions

- Relative imports end in `.ts`, not `.js`; the compiler accepts both, and nothing checks which.
- Committed placeholders start with `replace-with-`, and `isSecretSet` treats a placeholder, a string under 32 characters, or an unset variable as unset.

## Never

- Never commit a secret, token, credential, or production environment value. This repository is public. Those values live in Vercel environment variables, GitHub Actions secrets, or a gitignored `.env.*` file. `.gitignore` is the only check, and it covers `.env` and `.env.*` files alone, `.env.example` excepted.
- Never write a secret to a log. When a test needs a secret-shaped value, use a dummy such as `test-only-better-auth-secret-0123456789abcdef`.
- Never weaken a test so a change goes green: do not skip it, delete it, loosen the expected value, stub out the behavior it guards, or raise a timeout to hide a failure. Fix the code the test is about.
- Never point tests, fixtures, or the agent install at production Turso, Vercel, or GitHub credentials.
- Never let a test reach the network. `testApi()`'s default `fetch` rejects every call; nothing stops a direct `fetch` elsewhere.
- Never store an API key in plaintext.
- Never install without `--frozen-lockfile` in CI or in `.cursor/environment.json`, and never hand-edit `pnpm-lock.yaml`.
