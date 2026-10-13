# GitHub sign-in service (optional)

A small service that lets a submitter **sign in with GitHub on your catalog's
`/submit/` page** and send their answers as an issue straight from that page,
however long they are. Without it the page hands the answers to GitHub's issue
form in a prefilled link, which works for most submissions but cannot carry a
long write-up: GitHub drops a prefilled link through its sign-in page above
about 5,400 characters and refuses one above about 8,000.

You do not need this service. Leave `submit.signin_url` blank in
`_data/site.yml` and the submit page works exactly as before.

## How it works

1. The submitter presses **Sign in with GitHub** on `/submit/`. A small window
   opens this service's `/api/login`.
2. `/api/login` sends the window to GitHub, where the submitter approves your
   GitHub App (the first time only).
3. GitHub sends the window back to `/api/callback`, which swaps GitHub's
   one-time code for a user access token and passes the token to the
   `/submit/` tab with `postMessage`, addressed to your site's exact origin.
   The window then closes.
4. When the submitter presses **Submit to GitHub**, the page creates the issue
   through GitHub's API, as them. The issue body is exactly what GitHub's own
   form would have written, so the automation treats it like any other
   submission.

The service only finishes the sign-in. It never sees the answers, stores
nothing, and has no runtime dependencies.

- The `state` value and the PKCE verifier sit in a short-lived (10 minute)
  `HttpOnly`, `Secure`, `SameSite=Lax` cookie scoped to this service's host.
  `state` is compared in constant time.
- The token is never put in a URL, a cookie or a log line. The refresh token
  GitHub returns is thrown away, so the browser holds a token that lasts at
  most eight hours.
- Every response is `Cache-Control: no-store` and `Referrer-Policy:
  no-referrer`, with a strict Content Security Policy.
- If any environment variable is missing or malformed, every request is
  refused.

In the browser the token is kept in `sessionStorage`: it is limited to that
tab, gone when the tab closes, and sent only to `api.github.com`. It is never
saved with the draft.

### Every page on your site's origin is trusted with the token

The browser's security boundary is the **origin** (scheme and host), not the
path. Any page served from an origin listed in `ALLOWED_ORIGIN` can open
`/api/login` itself and receive a token, and GitHub signs a returning user in
again without asking once they have approved the app. Any such page can also
read the token the submit page keeps in `sessionStorage`. That matters on
GitHub Pages: every project site an account publishes shares one origin,
`https://<owner>.github.io`, so with that origin allowed, **every other Pages
site of that owner can get a signed-in submitter's token**, and so can anyone
who can publish to one of them.

What such a token can do is limited to what the GitHub App can do, as that
person: read and write issues (open, comment, edit, and close or label where
the person is allowed to) in the repositories the app is installed on. It
cannot touch code, pull requests, settings or any other repository. A
maintainer's token can do more to those issues than a visitor's.

So:

- Install the app on the catalog repository **only**.
- Serve the catalog from an origin no one else publishes to, normally a
  custom domain (`https://catalog.example.org`), and allow only that origin.
- Allow a shared `https://<owner>.github.io` origin only when you trust every
  Pages site that owner publishes, and everyone who can publish one, with that
  access.

## Set it up

You need a GitHub account that can create a GitHub App for the account (user
or organization) that owns the catalog repository, and a Vercel account. The
Vercel CLI is used through `npx`, so nothing is installed globally.

### 1. Deploy the service once, to get its address

From this directory:

```sh
cd services/github-signin
npx vercel link          # create (or pick) a Vercel project for this directory
npx vercel deploy --prod # gives the production address, e.g. https://catalog-signin.vercel.app
```

The first deploy has no configuration yet, so it answers every request with a
"not set up" page. That is expected.

### 2. Register a GitHub App

On GitHub go to **Settings → Developer settings → GitHub Apps → New GitHub
App**. For an organization, go to the organization's settings instead, so the
app belongs to the organization.

| Setting | Value |
| --- | --- |
| GitHub App name | anything, e.g. "<Your catalog> submissions". Submitters see it when they approve the app. |
| Homepage URL | your catalog's address |
| Callback URL | `https://<your-service>.vercel.app/api/callback`, using the address from step 1 |
| Expire user authorization tokens | **On** (the default). Tokens then last eight hours. If you turn it off, a token lasts until the submitter's tab closes or they sign out. |
| Request user authorization (OAuth) during installation | Off |
| Enable Device Flow | Off |
| Webhook | Untick **Active**. The service does not use webhooks. |
| Repository permissions → **Issues** | **Read and write**. Metadata (read-only) is added automatically. |
| Every other permission | No access |
| Where can this GitHub App be installed? | Only on this account |

Create the app, then:

1. Copy the **Client ID**.
2. Under **Client secrets**, choose **Generate a new client secret** and copy it.
3. Choose **Install App** and install it on the account that owns the catalog,
   for **Only select repositories** → the catalog repository.

A submitter's token can do only what both the app and the submitter are
allowed to do, and only in repositories where the app is installed. Here that
means opening and editing issues in the catalog repository, which any GitHub
user can already do there.

### 3. Configure the service

```sh
npx vercel env add GITHUB_CLIENT_ID production      # the app's Client ID
npx vercel env add GITHUB_CLIENT_SECRET production  # the client secret
npx vercel env add ALLOWED_ORIGIN production        # your site's origin, e.g. https://example.github.io
npx vercel deploy --prod
```

`ALLOWED_ORIGIN` is the **origin** of your catalog: the scheme and host only,
with no path and no trailing slash. A GitHub Pages project site at
`https://example.github.io/catalog/` has the origin `https://example.github.io`,
which every other Pages site of `example` shares: read
[Every page on your site's origin is trusted with the token](#every-page-on-your-sites-origin-is-trusted-with-the-token)
before you allow it.
To allow more than one origin (for example a custom domain and its
`github.io` address), separate them with commas. Only `https://` origins are
accepted, plus `http://localhost` and other loopback addresses for local
testing.

### 4. Turn it on in the catalog

In `_data/site.yml`:

```yaml
submit:
  signin_url: "https://catalog-signin.vercel.app"
```

Use the service's address only, with no path. `npm run validate` checks it.
Publish the change, open `/submit/`, and sign in once yourself to check it
works end to end.

## What submitters see

- **Not signed in, or the service is not set up:** the existing link hand-off,
  unchanged.
- **Signed in:** the intro says who they are signed in as and offers *Sign
  out*. The review step's button becomes **Submit to GitHub**. On success the
  page shows the new issue's number and link, and only then deletes the saved
  draft.
- **Anything goes wrong:** the answers and the draft stay where they are, and
  the page offers GitHub's own form instead:
  - an expired sign-in asks them to sign in again, then sends;
  - an app that is not installed, or no access (403/404), issues turned off
    (410), or a body GitHub rejects (422) explain what happened;
  - a GitHub error (5xx), a network failure or a timeout may have created the
    issue, so the page links to their own issues (`author:@me`) before
    suggesting they try again;
  - answers over GitHub's 65,536-character limit are never sent.
- **Pop-ups blocked:** the page says so, and the link hand-off still works.

## How the automation picks up these issues

GitHub drops the labels of an API request from anyone without push access to
the repository, so an issue sent from the page opens with no label. The
`claim` job in `.github/workflows/new-entry.yml` recognises an entry
submission by its shape (the form's title prefix and a `### <Label>` heading
for every question), adds `content:new-entry`, and the scaffold job runs in
the same workflow run. It runs on edits as well as on new issues, because an
edit made straight after submitting (to add a file, say) cancels the first
run, possibly before it added the label. An issue whose label a maintainer
removed is left alone. `missing-label.yml` leaves these issues alone. If the
label cannot be added (for example because Bootstrap labels was never run),
the claim job posts the usual "label missing" message instead.

## Develop and test

```sh
node --test services/github-signin/test/signin.test.mjs
```

The tests call the handlers directly with a stubbed `fetch`. The repository's
`npm test`, `npm run lint` and `npm run coverage` include this directory.

## Rotate or remove

- **Rotate the client secret:** generate a new secret on the app, then run
  `npx vercel env rm GITHUB_CLIENT_SECRET production`,
  `npx vercel env add GITHUB_CLIENT_SECRET production` and
  `npx vercel deploy --prod`. After that, delete the old secret on GitHub.
- **Turn it off:** blank `submit.signin_url` and publish. Then uninstall or
  delete the GitHub App, and remove the Vercel project if you no longer need
  it. Tokens already issued stop working when the app is uninstalled.
