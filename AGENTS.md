<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## TraceForce Engine project conventions

- Primary product goal: reconstruct a Base token's story from public on-chain evidence: who funded examined wallets, which wallets are connected, who accumulated in the earliest observed window, and what transaction evidence suggests coordinated selling. UI, AI commentary, websites, market context and scoring must support this goal, never substitute for acquired evidence.
- Deployment target: Next.js on Vercel, MySQL on Hostinger, and a protected long-running scan/AI engine when required. Hosted deployment is not verified until actually configured and tested. Preserve the later user requirement of fresh request-owned scans without server report/evidence/chat history; only explicit visitor browser snapshots persist reports.
- Read `docs/architecture.md` and `docs/security.md` before changing module boundaries or security policy. `docs/skills-roadmap.md` lists planned skills, not installed capabilities.
- Use strict TypeScript and Server Components by default. Keep database/provider credentials and access in server-only modules. Validate external input at runtime.
- Use Tailwind 4 with the semantic tokens in `src/app/globals.css`. Keep utility class names static and extract repeated combinations into typed components. Preserve keyboard access, responsive layout, and reduced-motion support.
- Keep route handlers thin and separate fresh acquisition, pure analysis, anonymous admission, and request-owned execution. Public scans must not persist parameters, reports, evidence, or chat; explicit report snapshots belong only in the visitor's browser.
- Preserve nonce-based CSP and request-time rendering. Do not cache nonce-bearing HTML across visitors or add inline HTML styles. Keep structured data escaped and pass its trusted nonce.
- Use validated site configuration for metadata and URLs. Production indexing is explicit; preview/API pages remain nonindexable. Do not invent a public domain or token details.
- Store blockchain amounts exactly as decimal strings or `bigint`. Retain evidence and coverage; unknown observations must not become zero or proof of ownership.
- Generate and review new schema migrations, commit SQL/snapshots/journal together, and apply them explicitly. Never migrate at build, startup, or request time. Never log credentials or weaken remote TLS verification.
- Run checks appropriate to the change: `npm run check`, production build, relevant browser checks, and migration checks for database work. Do not claim live database/provider verification without performing it.
