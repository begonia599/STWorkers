# STWorkers Development Rules

Read `docs/GOALS.md`, `docs/ROADMAP.md`, and `docs/COMPATIBILITY.md` before changes.

## Frozen Product Boundaries

- Preserve the upstream ST frontend and its core behavior. Do not build a replacement UI.
- Target one owner deploying to their own Cloudflare account using free-tier resources.
- Tavern Helper and ST-Prompt-Template compatibility are release gates, not optional extras.
- No local model management, server-side inference, voice, image generation, or public multi-tenant service.
- Do not disable arbitrary plugin installation permanently merely to simplify implementation.
- Pin versions for reproducible verification, not as a permanent ecosystem restriction.

## Engineering

- `public/` is upstream compatibility surface. Keep changes small, documented, and tested.
- Implement Workers code under `cloudflare/`. Do not import the Node backend into the Worker bundle.
- Preserve request/response contracts, unknown fields, message swipes, variables, and event ordering.
- Unsupported APIs must fail explicitly. Never fake success, data persistence, or extension versions.
- Never copy user data, secrets, ignored extension directories, or local config into deployment assets.
- Authentication must run before serving HTML, scripts, data, and APIs.
- Browser iframe scripts are privileged client-side code, not a server-side sandbox.
- Keep database migrations additive and test data preservation.
- Run `npm --prefix cloudflare test` and `npm --prefix cloudflare run build`.
- P0 contract tests are not evidence of full ST, Tavern Helper, EJS, or MVU compatibility.
- Update roadmap statuses only after the corresponding evidence exists.
- Do not deploy, publish, or create remote resources without explicit user authorization.
