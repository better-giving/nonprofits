# nonprofits

Claude Code loads this file from `.claude/CLAUDE.md`; Cursor loads it from `.cursor/rules/project.mdc`.

## Stack

- **Node 24**, from `.nvmrc`; CI reads it through `actions/setup-node`'s `node-version-file`. Only `.cursor/environment.json` pins a patch (`NODE_VERSION`), and its `NODE_SHA256` has to change with it: the install checks the tarball against that hash. In cloud agents, nvm's or the image's node can come first on PATH; `.cursor/environment.json` and `.claude/cloud-install.sh` each end `~/.bashrc` and the login file with a line putting the pinned node first, and fail unless new `bash -lc` and `bash -ic` shells resolve it. Run node through those shells or the Bash tool: a bare `bash -c` keeps the PATH it started with.
- **pnpm**, the version in the root `packageManager` field. CI's `pnpm/action-setup` reads it; `.cursor/environment.json` repeats it as `PNPM_VERSION`, so a bump changes both.
- **TypeScript**, **Biome**, and **Vitest**, versions in the `catalog` of `pnpm-workspace.yaml`.
- **Libraries**, same catalog: Hono, `@modelcontextprotocol/server`, `@libsql/client`, `better-auth` and `@better-auth/api-key`, Kysely, Zod, `csv-parse`, `@vercel/firewall`, `@vercel/functions`. A package depends on a catalog entry with `"catalog:"`. Do not pin a different version in a package; nothing checks this.

## Commands

CI's check job is these two commands, in order:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` (root `package.json`) is the gate a change has to pass: Biome, then typecheck, then the whole Vitest suite. Run the suite whole rather than a filtered subset: ~8 s wall on 8 cores (43 files, measured 2026-11-02).

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

## Team

Claude Code routes work to these `kru` seats, one per lane:

- **api** → `kru:hono-builder` — `packages/api`, the Hono app serving `/v1`, `/mcp`, the admin key routes and the daily cron route, plus `packages/core`'s lookup and search logic (hono 4.13.13, `@modelcontextprotocol/server` 2.2.0)
- **platform** → `kru:vercel-platform-engineer` — `packages/api/vercel.json`, `build.ts` and `server.ts`: deploy, env and secrets, the daily cron, Firewall per-minute limits (`@vercel/firewall` 1.2.5, `@vercel/functions` 3.9.11)
- **data** → `kru:turso-specialist` — `packages/db`'s schema, migrations and the served-database pointer, and every `@libsql/client` 0.18.0 call in `packages/api` and `packages/import`
- **import** → `kru:extension-builder` — `packages/import`, the Node job that parses IRS bulk files into each month's SQLite file, and `.github/workflows/import.yml` (csv-parse 7.0.3, `@zip.js/zip.js` 2.18.2, fflate 0.8.3, saxes 6.0.0, undici 7.29.1)
- **keys** → `kru:better-auth-specialist` — the API-key layer in `packages/api` and the key CLI in `packages/cli` (`better-auth` and `@better-auth/api-key` 1.7.7, on `kysely` 0.29.6)
- **skills** → `kru:vitest` for vitest ^5.0.3 and `kru:zod` for zod 4.6.5 (`pnpm-workspace.yaml` catalog); `kru:api-design` for `/v1` routes and minted API keys
- **mcp** → Vercel (claude.ai connector) for live project state; the `turso@turso` plugin (`.claude/settings.json`), its MCP at `mcp.turso.ai` signed in by the user; context7 (`.mcp.json`)

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
