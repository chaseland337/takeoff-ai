# Web app with its own AI service

> **Company deployments:** use [web-auth-setup.md](web-auth-setup.md).
> The current web UI requires Supabase employee login and saves company projects
> online. The access-code instructions below describe the legacy standalone AI
> proxy only; they do not configure the company website. The Pages AI endpoint
> requires company authentication; access codes cannot bypass it.

The web version runs on Cloudflare Pages: the app itself (`dist`) plus functions
at `/api/ai` and `/api/invites`. Follow the linked company setup guide for the
database migration, email delivery, owner bootstrap, secrets, local development,
and deployment.

- Employees use invited email/password accounts; they do not need an AI key.
- Company projects and PDFs save privately in Supabase, rather than only in a browser.
- The AI server holds the model key and checks current company membership.
- Employee, company, and global daily caps are reserved atomically in Postgres.
  Set a monthly spending limit at the AI provider as well.
- Any OpenAI-compatible endpoint can be configured. OpenRouter is the default.
  Change `AI_MODEL` in `wrangler.toml` to choose a vision model. Optionally set
  `AI_MODEL_SHEET_NAME` to a cheaper model and `AI_JSON_MODE=off` for a model
  that rejects JSON mode.
- AI is a fallback: assembly types are read from the drawing's own text first,
  and vector tools (fill, walls, rooms, doors, hatches, symbols) need no AI.

## Picking the cheapest model that works

1. Deploy with a candidate model.
2. In the app: **More › Show bid workbook scoring**, open a legend sheet (Kelso A0.3),
   **Read with AI**, then **Score against bid workbook…** with the estimator's workbook.
3. Change `AI_MODEL`, redeploy, repeat. Keep the cheapest one that still scores near
   100% (Claude scored 23/23 types and 80/80 layers on A0.3).

## Compatibility

The standalone logic in `worker/aiProxy.ts` retains access-code support when
used without company configuration. The Cloudflare Pages route requires
company configuration and cannot use this legacy fallback. Desktop/local and
claude.ai artifact builds retain their existing AI paths.
