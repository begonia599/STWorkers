# Owner Accounts and Cookie Sessions

This replaces the initial HTTP Basic gate with the upstream SillyTavern login page
and account profile UI. It is a **single-owner** backend, not public registration
or the complete upstream multi-user server.

## Using the Account

1. Deploy with an independent `AUTH_PASSWORD` of 24-1024 characters. Keep it private.
2. Open the instance, select `owner` on the original login page, and enter that password.
3. Open User Settings -> Account to change the everyday password. Supply the current
   password and a new password of 12-1024 characters. Passwordless accounts are not allowed.
4. Use the original Logout button to revoke the current session.

The login HTML and `scripts/login.js` are reused without modification.
The account module receives three small adjustments: failed logout shows an error,
`singleOwner: true` hides only the multi-user panel, and password changes still
request the current password. The owner retains `admin: true`, because upstream
global-plugin management depends on it. Original Node profiles without the extra
field retain their original controls. Stored data ownership does not change.

First-visit onboarding remains the upstream flow, separate from the login account.
Its persona name is not the account handle.

## Existing Instances

Apply all additive D1 migrations, including `0004_accounts.sql`, **before** uploading
the new Worker. Native Workers Builds and the Actions update path do this in that order.
Actions now needs D1 migration permission on the already selected database; failure
stops the Worker upload instead of shipping code against missing tables.

Keep the existing bindings, `AUTH_PASSWORD`, and `DATA_KEY`. The first successful
login proves ownership with the existing deployment password. There is no anonymous
"first visitor becomes administrator" setup endpoint.

The migration adds only these tables and an index:

- `stworkers_accounts`: the fixed `owner` profile, salted password verifier and revision.
- `stworkers_sessions`: hashed random session IDs, CSRF values, origin and expiry.
- `stworkers_login_limits`: bounded login-attempt counters.

Existing `documents` keys, character/chat objects, plugin metadata and encrypted
model credentials are not renamed or copied. Settings remain `settings/owner`.
An existing native deployment with owner records but missing `DATA_KEY` is also
rejected rather than silently generating a replacement key.

Direct Wrangler users must run `d1 migrations apply DB` with their exact existing
config and the appropriate `--local` or `--remote` target first. Do not delete or
recreate the database to work around migration errors.

Old Basic credentials no longer authenticate. Existing browser tabs must reload
and sign in. Do not roll back to the Basic build after changing the account password:
that old code still uses the deployment secret as its login password.

## Recovery

Changing the everyday account password does **not** modify `AUTH_PASSWORD`.
The old bootstrap password stops working for ordinary login after that change.
The secret remains a pepper and deployment-owner recovery credential.

If the account password is lost:

1. In the correct Cloudflare Worker, replace `AUTH_PASSWORD` with a **new**, independently
   generated password of at least 24 characters and deploy the secret change.
2. Keep `DATA_KEY`, D1 and R2 unchanged.
3. Reload, select `owner`, and sign in with the new secret value.

The new secret invalidates old sessions immediately on subsequent requests.
Successful recovery replaces the password verifier and increments the account
revision while retaining profile and application data. Merely re-entering the
unchanged bootstrap secret is not a password reset.

The original "Forgot password?" entry returns readable recovery instructions.
Console recovery-code generation, email recovery, public registration, account
deletion/reset and full account backups are not implemented; unsupported endpoints
return explicit failures. Recovery secrets are never printed to Worker logs.
Losing `DATA_KEY` is separate: account recovery cannot decrypt lost model credentials.

## Security and Cost Boundaries

- Production requires HTTPS. Only loopback development permits HTTP.
- Session cookies use `__Host-`, Secure, HttpOnly, SameSite=Strict and Path=/ with no Domain.
  Loopback HTTP uses a different unprefixed cookie name. Browser JavaScript cannot
  read the cookie, but trusted same-origin plugin code still has the owner's privileges.
- Login-page CSRF uses an expiring signed anonymous cookie. Tokens are bound to the
  browser and origin. Obtaining a token alone does not authorize a login or private API.
- Authenticated writes validate a session CSRF token, Origin and Fetch Metadata.
  No permissive CORS headers are added.
- Session IDs contain 256 random bits; D1 stores their SHA-256 hashes, not bearer values.
  Account revisions revoke other sessions after password change. The current cookie
  is rotated while retaining that page's CSRF value for upstream UI compatibility.
- Password verification is HMAC-SHA256 prehashing with the Worker secret, followed by
  salted PBKDF2-SHA256 with 100,000 iterations. The password is NFC-normalized.
  Login/password changes do the expensive work; ordinary requests do not.
  This scheme is separate from Node ST's scrypt format, not a direct Node account import.
- Sessions last seven days. The upstream ten-minute ping extends near-expiry sessions
  only, capped at 30 days from login. At most 20 session rows are retained.
- Authentication reads the primary D1 binding, not an eventually stale replica.
  Each authenticated asset/API request incurs a session lookup. There is no per-request
  last-seen write; avatar/profile data is read only by the profile API.
  This is not evidence of free-tier CPU or quota acceptance.
- Login and password-change attempts are limited to 10 per hashed IP bucket and 100
  globally per 15-minute window, including successful attempts. The fixed 256 buckets
  bound storage without retaining raw IPs; collisions can share a limit.
  Anonymous CSRF/list requests create no account/session database rows.
  These application limits do not prevent volumetric traffic or guarantee availability.
- Only the explicit upstream login dependency list is public. `/css/user.css` returns
  an inert generated response, never a private asset. Application modules, plugins,
  source ZIPs, bootstrap metadata and user images remain authenticated.
- Responses remain `no-store`; no login details or database errors enter error bodies.

## Verification

Unit/security and deployment-guard tests use synthetic data and SQLite.
`check-account-local.mjs` uses isolated real workerd/D1, the built original frontend,
desktop/mobile browser contexts and synthetic model responses.

```sh
npm --prefix cloudflare test
npm --prefix cloudflare run build
node cloudflare/scripts/check-account-local.mjs <playwright-package.json> <browser-executable>
```

For pinned plugin regression, rebuild `assets-p3` from an already verified bundle
using `build-assets.mjs --plugins <bundle.json>`, then pass `--plugins` to the account
check. No plugin download, installation, publishing or cloud deployment is implicit.
Evidence and screenshots are written to `cloudflare/.build/account-check/<run-id>/`.

Legacy local probes now log in through `owner-client.mjs`; original Node reference
servers still use their own Basic configuration for independent comparisons.
For smoke/cloud API probes after a password change, supply the current account
password through `STWORKERS_TEST_PASSWORD`, not a command-line argument.

The account migration has not yet been applied to the live Cloudflare instance.
Local evidence does not establish real Workers HTTPS/browser behavior, D1 latency,
free-tier CPU, button deployment or full community-card compatibility.

## Recorded Local Results

- Full suite: **285 passed, 0 failed, 0 skipped**.
- Standard build and Wrangler dry-run passed: 667.03 KiB, gzip 129.87 KiB.
- Final account/UI run:
  `cloudflare/.build/account-check/445d4259-d924-48dd-829d-ba212d91dfdb/results.json`.
  Passed desktop 1440x1000 and mobile 390x844 login, wrong-password display, old-data
  load, synthetic generation, profile password change, cookie rotation, other-device
  revocation, replay rejection, real logout and failed-logout reporting.
- That run loaded pinned Helper 4.9.5 and EJS 1.17.9; a real Helper global variable
  survived desktop reload and a fresh mobile session. Profile admin privileges remain
  available to plugins while the multi-user administration entry is hidden.
- Final fresh-instance/prebundle run:
  `cloudflare/.build/actions-check/efd2c7a0-291c-4ced-a879-be50143fa62f/results.json`.
  The original first-run welcome dialog, authenticated plugin bytes, desktop/mobile
  reload and retained variables passed. No online plugin installation, Worker download,
  R2 object or extension-archive record was created.
- Both final browser runs had zero page errors and zero unexpected HTTP errors.
  Background writes with a provably revoked old cookie are tracked separately, not
  accepted as writes and not confused with errors from a current authenticated session.
- Login/profile screenshots were inspected. Login HTML and login JavaScript matched
  their upstream source bytes. No live Cloudflare update, Git push or model-provider
  call was performed by this verification.

Older P1-P4 browser scripts were adapted to Cookie login, but their complete historical
card/generation/cancellation suites were not all rerun in this account-migration pass.
