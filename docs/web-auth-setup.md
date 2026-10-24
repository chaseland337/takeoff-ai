# Your private company takeoff website

This setup needs one technical helper for the first deployment. After that, the
owner and employees use the website; they do not need GitHub or API keys.
Cloudflare hosts the website, Supabase stores accounts/projects/private PDFs,
and your chosen AI provider processes only requests made with AI tools.
Terminal examples use Bash (on Windows, use WSL or Git Bash).

## Owner checklist

1. Create company-owned **Supabase**, **Cloudflare**, and **AI provider** accounts.
   Keep billing and recovery access under your company's control.
2. Ask your helper to complete the setup below, including the security checks.
3. Open your website, sign in, and set a strong password.
4. Invite one estimator first. Use a non-confidential sample PDF.
5. Create a named project, upload its drawings, verify scale, and try the tools.
6. Wait for online saving to finish. Open the same project on another computer.
7. Check quantities and exports against a known job before using results in a bid.
8. Arrange database **and drawing-file** backups, test a restore, and set an AI
   provider monthly spending limit. Do this before uploading client drawings.

**Never paste passwords or secret keys into GitHub, chat, or source files.**
An invitation link is also a credential: send it only to the intended employee.

## 1. Create and configure Supabase

Create a Supabase project in the company's preferred region. In its dashboard:

- **Authentication → Providers → Email:** enable email/password, but turn
  **Allow new users to sign up OFF**. Keep email confirmation enabled.
  Administrative email invitations still work; do not enable public signup.
- **Authentication → URL Configuration:** set Site URL to the exact production
  HTTPS website origin, for example `https://takeoff.your-company.com`.
  Allow that exact URL as a redirect URL. For development only, also allow
  `http://localhost:8788`. Avoid wildcard preview URLs in production.
- Configure a production **SMTP email provider** for invitation/password-reset
  delivery. Supabase's default test email service is not adequate for employees.
  Check your provider's sender verification, SPF/DKIM, limits, and spam folder.
- Set an appropriate password policy and short access-token lifetime (for example
  one hour). Invitation and recovery links expire; send another if necessary.
- Under project **API settings**, record the project URL and legacy public
  **anon** key. Also locate the **service_role** key in a secure place. The latter
  bypasses database policies: it must appear only in Cloudflare server secrets.

Use separate Supabase projects for development/testing and production. Do not
point untrusted pull-request previews at production accounts or secrets.

## 2. Apply the database and private storage migration

From a checkout of this repository, use a PostgreSQL client (`psql`). Get the
connection string from Supabase's **Connect** dialog, choosing a connection your
network supports. The migration runs against a Supabase database, not an empty
vanilla Postgres database: it uses Supabase's auth and storage schemas.

```bash
# Reads the connection string without putting it in shell history.
read -rsp 'Supabase database connection string: ' DATABASE_URL; echo
export DATABASE_URL
for migration in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f "$migration" || break
done
unset DATABASE_URL
```

Alternatively, paste each migration, in filename order, into Supabase's **SQL
Editor**, wrap it in `begin;` and `commit;`, and run it once. Stop and investigate
any error; do not deploy with a partially applied schema. Track applied migrations
so they are not reapplied.
Keep all tables' row-level security enabled. Do not make the drawing bucket
public or add broad authenticated-user policies in the dashboard.

The schema includes organizations, organization members, pending invitations,
projects with revision checking, drawing records, audit fields, and atomic AI
usage counters. Users inherit access to **every project in their company**.
This first version does not have per-project restricted employee groups.

### Bootstrap the first owner (trusted operator only)

In Supabase **Authentication → Users**, use **Add user → Send invitation** to
invite the owner. Copy that user's UUID from the user list. Then run this in the
SQL Editor, replacing the example values:

```sql
begin;
with company as (
  insert into public.organizations (name)
  values ('Your Construction Company')
  returning id
)
insert into public.organization_members (organization_id, user_id, role, email)
select id, 'REPLACE-WITH-OWNER-USER-UUID'::uuid, 'owner', 'owner@your-company.com'
from company;
commit;
```

The owner follows the email link, sets their password, and signs in. This
trusted bootstrap is the only routine step that uses the SQL Editor to grant
access. Employees must be invited from the app, not manually added in Auth:
an Auth account alone does **not** grant company access. Each account belongs
to one company in this first version. Use a separate account when testing a
second company.

## 3. Configure the browser build

Use Node.js 22.13 or newer and install the existing dependencies:

```bash
npm ci
```

Create a git-ignored `.env.web.local` in the repository root:

```dotenv
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-PUBLIC-ANON-KEY
```

These two values are intentionally public and embedded in the browser bundle.
Authorization is enforced by database/storage policies, not by hiding the anon
key. **Never use `VITE_` for a service-role, database password, or AI key.**
The checked-in `.env.web` enables company web mode. Ordinary `npm run dev` and
desktop builds retain their existing local behavior; use web mode for this setup.

## 4. Configure Cloudflare Pages

Connect the repository to a Cloudflare Pages project (not GitHub Pages).
Set build command **`npm run build:web`** and output directory **`dist`**.
Choose Node.js 22.13+ for the build (Pages build variable `NODE_VERSION=22`
selects the current Node 22 release).
Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the Pages **build**
environment as above. Redeploy whenever build variables change.

Set these **server runtime** values in Pages settings; configure production
and trusted testing environments separately:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Same project's URL as the browser build |
| `SUPABASE_ANON_KEY` | Same project's public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret**; server invitations and atomic AI counters only |
| `APP_URL` | Exact production HTTPS origin; trusted invitation redirect |
| `AI_API_KEY` | **Secret**; your AI provider's API key |
| `AI_BASE_URL` | OpenAI-compatible API base; defaults to OpenRouter |
| `AI_MODEL` | Vision-capable model ID |
| `AI_MODEL_SHEET_NAME` | Optional cheaper vision model for sheet names |
| `AI_JSON_MODE` | Set to `off` only if the model rejects JSON mode |
| `DAILY_LIMIT` | Per-employee daily request cap; default 25 |
| `ORG_DAILY_LIMIT` | Per-company daily request cap; default 100 |
| `GLOBAL_DAILY_LIMIT` | Across all companies daily cap; default 200 |

`wrangler.toml` contains the model/limit defaults. Change those non-secret
settings there to suit your account. Store the five required runtime values
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`,
and `AI_API_KEY`) as Pages secrets, using the commands below or the dashboard's
encrypted/secret option. Public URL/anon values are not confidential, but storing
their runtime copies this way avoids conflicts with Wrangler-managed variables.
The existing `USAGE` KV binding is only for the
legacy standalone access-code proxy; company mode uses atomic Postgres counters.
Do not copy another deployment's KV namespace into your account. The legacy
`[[kv_namespaces]]` example is commented out; company deployments do not need it.
`ACCESS_CODES` is not used in company mode.

For a command-line deployment:

```bash
npx wrangler login
npx wrangler pages project create takeoff-ai --production-branch main
# Each command prompts for a value; do not paste values into command arguments.
npx wrangler pages secret put SUPABASE_URL --project-name takeoff-ai
npx wrangler pages secret put SUPABASE_ANON_KEY --project-name takeoff-ai
npx wrangler pages secret put SUPABASE_SERVICE_ROLE_KEY --project-name takeoff-ai
npx wrangler pages secret put APP_URL --project-name takeoff-ai
npx wrangler pages secret put AI_API_KEY --project-name takeoff-ai
npm run deploy:web
```

The build publishes `dist` and the Pages Functions in `functions/`. A static-only
GitHub Pages upload does **not** run `/api/ai` or `/api/invites`. Make sure the
production address agrees with `APP_URL`, Supabase Site URL, and allowed
redirect URLs. Do not put passwords/keys in `wrangler.toml`.

## 5. Local web development (with real auth)

Use a separate test Supabase project with the same migration/bootstrap steps.
Set `.env.web.local` to its public values. Create a git-ignored `.dev.vars`:

```dotenv
SUPABASE_URL=https://YOUR-TEST-PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR-TEST-PUBLIC-ANON-KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR-TEST-SERVER-ONLY-KEY
APP_URL=http://localhost:8788
AI_API_KEY=YOUR-TEST-AI-PROVIDER-KEY
```

Allow `http://localhost:8788` in that test project's Supabase redirect URLs.

```bash
npm run build:web
npx wrangler pages dev dist --port 8788
```

Open `http://localhost:8788`. This runs both the built app and its API functions.
For frontend-only iteration, `npm run dev -- --mode web` works with Supabase but
needs a same-origin Pages API for invitations/AI; use Pages dev for end-to-end
checks. Never share `.dev.vars` or `.env.web.local`. Rebuild after code/env changes.

Existing checks:

```bash
npm run typecheck
npm test
npm run build
npm run build:web
```

Database-policy regression checks also exist in
`supabase/tests/company_access.sql`. Run them only in a new, disposable local
PostgreSQL database as its owner, **never in your Supabase project**:

```bash
createdb company_access_test &&
psql -X -v ON_ERROR_STOP=1 -d company_access_test -f supabase/tests/company_access.sql &&
dropdb company_access_test
```

The test mocks Supabase's auth/storage schemas and rolls its changes back.
It checks company isolation, ownership fields, role/invitation restrictions,
revision conflicts, private file policies, and quotas.

## Daily use and employee access

- **Owner:** manages company access, can invite admins and members.
- **Admin:** invites/manages ordinary members; cannot promote themselves or
  another employee into owner/admin access.
- **Member:** works on shared company projects; cannot invite employees.
- Use the account controls to invite an employee, then have them follow their
  email link and choose a password. There is no public Create account page.
- Withdraw an unused invitation from the pending-invitations list if it was sent
  in error. Revoking an employee's membership and withdrawing an invitation are
  separate actions; check both lists when removing access.
- Use **Forgot password** at login to request a recovery email, then follow
  its link on the same browser to set a new password.
- Revoke company membership when an employee leaves. Server-side checks apply
  to each new project/file/AI request, even before their login token expires.
  Revocation cannot retract files already downloaded or drawings already on-screen.
- Name projects clearly. Wait for online saves before closing. If a save fails,
  keep the tab open, restore connectivity, and retry. Do not assume work is
  saved while an error is showing.
- Two employees can open a project, but edits are not merged in real time.
  On a revision conflict, preserve unsaved work with a project-file export,
  reload the latest online version, and coordinate with the other estimator.
- Deleting a shared project affects everyone. Once deletion starts, the project
  is locked against new edits/uploads while its private files are removed.
  Retry an interrupted deletion to finish cleanup; do not continue estimating
  in a project marked for deletion.
- To bring an old browser-only project online, open its old local/desktop app,
  **Save to file…**, then use **Open file…** in the company website.
  No old local project is silently uploaded.

## Acceptance checks before client drawings

Use separate browsers/private windows and two test companies. Automated tests
are helpful, but do not replace checking the actual Supabase and Pages setup:

- [ ] A logged-out visitor sees login, cannot list projects, and gets 401 on AI.
- [ ] Public signup is disabled in Supabase, not just hidden in the app.
- [ ] Owner invitation email arrives; the employee sets a password and signs in.
- [ ] Password reset email/link works; sign-out returns to login.
- [ ] A member cannot invite or change roles, even through direct API requests.
- [ ] Create, rename, upload a PDF, run tools, save, reopen on another computer,
      and export. Verify scale and measured quantities against a known plan.
- [ ] Company B cannot read/update/delete company A's projects or download/upload
      its PDFs using copied IDs/paths and B's token.
- [ ] A copied private file URL does not work when logged out.
- [ ] Revoked employees cannot fetch projects/files or call AI with an old token.
- [ ] Simultaneous edits produce a conflict rather than silently overwriting work.
- [ ] Offline/failed saves remain visibly failed; retry does not claim false success.
- [ ] Project deletion removes private drawing objects as well as database records.
- [ ] AI requests stop at employee, company, and global caps.
- [ ] Restore a test database **and private storage files** from backups.

## Security notes and limits

**Protected:** Supabase verifies email/password sessions; row-level security
restricts projects, drawings, and membership reads to the user's company. Storage
is a private PDF bucket with company/project paths and a 50 MB per-file limit.
Server-generated ownership/timestamp fields identify creators and last writers.
Only trusted owner/admin invitation paths grant access. Browser-supplied role,
organization, and ownership claims do not grant privileges.

**What remains local:** open drawings and edits are held in browser memory.
The Supabase SDK persists the login session in site storage so refresh works;
sign out on shared computers. Local preferences/starter takeoff types and the
app shell may remain in browser storage. Desktop/local projects remain local.
Downloaded Excel, PDF, and `.takeoff` exports are ordinary unencrypted files:
protect them under your company's file-handling policy.

**AI data flow:** chosen sheet images/text/prompts travel from the browser to
the same-origin Cloudflare AI function, then to the configured AI provider.
The provider key never reaches the browser. The function verifies a live
Supabase user and current membership, and reserves daily quota atomically
before forwarding. Failed provider calls can consume a request. Review provider
retention/training/region terms before sending confidential plans. Most vector
takeoff tools run locally and do not require an AI provider.

**Operational limits:** this is company-wide sharing, not live collaboration,
enterprise SSO, a tamper-proof compliance audit, or a substitute for estimator
review. There is no automatic bid-ready estimate guarantee or malware scanning
service. Keep the PDF parser and dependencies patched. Set provider-side spend
limits in addition to request caps (requests vary in token cost). Set your
database/storage retention and backup policy; a database backup alone does not
back up Supabase Storage file contents. Keep the service-role key restricted
and rotate it if exposed. Database and Supabase administrators remain trusted.
