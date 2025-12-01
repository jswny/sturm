# Development

## Prereqs
- Node 24+ (LTS) and pnpm 10.x (`corepack enable` recommended).
- After clone: `pnpm install` then `pnpm approve-builds` to allow esbuild’s postinstall.

## Workspace layout
- Apps in `apps/`; main app: `apps/discord-gateway`.
- Shared libs (future): `packages/`.

## Commands
- Dev (watch): `pnpm dev` (Turbo → tsx watch).
- Lint: `pnpm lint` (Biome).
- Typecheck: `pnpm typecheck` (tsc --noEmit).
- Build: `pnpm build` (tsc -b → dist/).
- Run built: `pnpm --filter discord-gateway start`.

## Adding deps
- Runtime: `pnpm add <pkg> --filter discord-gateway`
- Dev: `pnpm add -D <pkg> --filter discord-gateway`
(Or `cd apps/discord-gateway` and run `pnpm add ...`).

## Env
- Per-app envs. Copy `apps/discord-gateway/.env.example` → `.env` and fill secrets.
- `dotenv/config` auto-loads `.env` in dev/start.

## Notes
- Turbo caches locally; remote cache optional (`npx turbo link` later).
- ESM (`type: module`), TS `moduleResolution: "NodeNext"`.
- Use Node’s built-in `fetch` (Node 18+) for HTTP; add `AbortController` for timeouts/retries helpers as needed.
- Use explicit file extensions in relative imports (e.g., `./foo.js`) for NodeNext compatibility.
- In CI, prefer `pnpm install --frozen-lockfile` and commit lockfile changes after `pnpm approve-builds`.
- Default to modern Node-first patterns; avoid legacy/compat layers unless a requirement demands it.
