# Upload service (optional)

A small service that lets a **signed-in** submitter attach screenshots and a
PDF slide deck **on your catalog's `/submit/` page**, instead of opening the
issue afterwards and dragging the files in. Each file uploads the moment it is
picked, and the issue the page writes refers to it with an `upload:` line. When
the submission is scaffolded into a draft pull request, the automation copies
the files into the entry, exactly as it copies GitHub attachments today.

You do not need this service. Leave `submit.uploads_url` blank in
`_data/site.yml` and the submit page works exactly as before: submitters add
their files on GitHub after they submit.

**It needs the sign-in service.** Only signed-in submitters can upload, so set
up [`services/github-signin`](../github-signin/README.md) first and check that
signing in works.

## How it works

1. A signed-in submitter picks a screenshot or a PDF on `/submit/`. The page
   shrinks the image in the browser (which also strips location data), then
   sends the file to this service's `/api/upload`, with the submitter's GitHub
   sign-in token.
2. The service asks GitHub who the token belongs to (one `GET /user` call), and
   checks the file: it must come from your site, be at most 4 MB, and really be
   a PNG, JPEG or WebP image or a PDF, judged by its first bytes rather than its
   name.
3. With its **own** GitHub App, the service writes the file to your private
   uploads repository, filed under the submitter's numeric GitHub id, and
   answers with a reference such as `upload:k3j9…/9f2c…e1.png`.
4. When the submitter presses **Submit to GitHub**, the issue carries those
   references. The scaffold workflow looks them up **under the issue author's
   id only**, so a reference copied into someone else's issue finds nothing.
5. When the issue closes (the entry is published or declined), a cleanup
   workflow deletes that submitter's files; a daily run deletes anything left
   over for more than 14 days that no open submission still needs.

The service stores nothing itself: no database, no file storage, nothing on
disk. Each file goes straight from the request to GitHub. It has no runtime
dependencies.

- The submitter's token is used for that one `GET /user` call and nothing
  else. It is never logged, stored or passed on.
- Each file is its own branch, `u/<user-id>/<draft>/<sha256>`, holding a single
  commit with just that file, so deleting the branch is the whole cleanup.
- Uploading the same file to the same draft twice is harmless: the second
  upload is answered without writing anything.
- Every response is `Cache-Control: no-store` and `Referrer-Policy:
  no-referrer`, and only the origins in `ALLOWED_ORIGIN` may call it.
- If any environment variable is missing or malformed, every upload and every
  removal is refused.

### What the private repository does and does not protect

The uploads repository is private, so files from a draft that was never
submitted, or a submission that was declined, are never public, and nobody
can use the service to host files for the world to download.

It does **not** keep screenshots private. Once a submission is scaffolded, its
files are committed to a **public draft branch** in the catalog repository,
before anyone has reviewed them, just as files dragged into a GitHub issue are
public the moment they are attached. Tell submitters not to upload anything
with personal information in it; the submit page says so too.

Git keeps deleted content in its history. Deleting an upload's branch makes the
file unreachable, but if something sensitive must be gone at once, contact
GitHub Support to have it purged.

### The sign-in token is shared with this service

Without uploads, a submitter's sign-in token is sent only to `api.github.com`.
With uploads, the page also sends it to this service, which you run, so the
service can tell who is uploading and hold each person to their own limits.
The service uses the token for one `GET /user` call and nothing else. The
token can only do what the sign-in App allows (read and write issues in the
catalog repository); it cannot touch the uploads repository at all.

## Set it up

You need the sign-in service already working, a GitHub account that can create
a repository and a GitHub App for the account (user or organization) that owns
the catalog repository, and a Vercel account. The Vercel CLI is used through
`npx`, so nothing is installed globally.

### 1. Create the private uploads repository

In the account that owns the catalog, create a new repository named
`<catalog>-uploads` (for example `catalog-uploads`):

- Visibility: **Private**.
- Tick **Add a README file**, so the repository starts with one commit. The
  service cannot write to an empty repository.

Nothing else goes in it. The service and the workflows only ever create and
delete branches under `u/`.

### 2. Register the uploads GitHub App

This is a **second** GitHub App, separate from the sign-in App. Giving the
sign-in App access to files would widen what every submitter's token in the
browser can do; this App's key never leaves the service and the catalog's
Actions secrets.

On GitHub go to **Settings → Developer settings → GitHub Apps → New GitHub
App**. For an organization, go to the organization's settings instead, so the
app belongs to the organization.

| Setting | Value |
| --- | --- |
| GitHub App name | anything, e.g. "<Your catalog> uploads". Submitters never see it. |
| Homepage URL | your catalog's address |
| Callback URL | leave blank |
| Request user authorization (OAuth) during installation | Off |
| Enable Device Flow | Off |
| Webhook | Untick **Active**. The service does not use webhooks. |
| Repository permissions → **Contents** | **Read and write**. Metadata (read-only) is added automatically. |
| Every other permission | No access |
| Where can this GitHub App be installed? | Only on this account |

Create the app, then:

1. Note the **App ID** (a number, near the top of the app's page).
2. Under **Private keys**, choose **Generate a private key**. Your browser
   downloads a `.pem` file. Keep it safe; you need it twice below, then you can
   delete the download.
3. Choose **Install App** and install it on the account that owns the catalog,
   for **Only select repositories** → the uploads repository only. Not the
   catalog repository.

### 3. Deploy and configure the service

From this directory:

```sh
cd services/uploads
npx vercel link                                       # create (or pick) a Vercel project for this directory
npx vercel env add UPLOADS_APP_ID production          # the App ID
npx vercel env add UPLOADS_APP_PRIVATE_KEY production # paste the whole .pem file
npx vercel env add UPLOADS_REPO production            # owner/name, e.g. example/catalog-uploads
npx vercel env add ALLOWED_ORIGIN production          # your site's origin, e.g. https://catalog.example.org
npx vercel deploy --prod                              # gives the address, e.g. https://catalog-uploads.vercel.app
```

- `UPLOADS_APP_PRIVATE_KEY`: paste the whole file, including the
  `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` lines.
  A key pasted on one line with `\n` in place of the line breaks also works.
- `ALLOWED_ORIGIN`: the same value as the sign-in service's: your catalog's
  scheme and host only, no path and no trailing slash. Separate several with
  commas. Only `https://` origins are accepted, plus `http://localhost` and
  other loopback addresses for local testing.
- Optional: `MIN_ACCOUNT_AGE_DAYS`, a whole number of days. GitHub accounts
  younger than that cannot upload (they can still submit and add files on
  GitHub). Unset allows any account; a value such as `7` is recommended, so
  throwaway accounts made to fill the uploads repository cannot upload.

### 4. Give the catalog's workflows access

In the **catalog** repository, under **Settings → Secrets and variables →
Actions**:

- Secrets: `UPLOADS_APP_ID` (the App ID) and `UPLOADS_APP_PRIVATE_KEY` (the
  whole `.pem` file).
- Variables: `UPLOADS_REPO`, the same `owner/name` as above.

Two workflows already in the catalog use them, and both do nothing while
`UPLOADS_REPO` is unset:

- **New entry from issue** (`new-entry.yml`) mints a read-only token for the
  uploads repository for each run and gives it to the scaffold step alone. If
  minting fails, the entry is still drafted, with a warning for each file it
  could not collect.
- **Uploads cleanup** (`uploads-cleanup.yml`) mints a token that can delete
  branches. It runs when a `content:new-entry` issue closes, and every day at
  04:47 UTC, when it deletes any draft's files that are more than 14 days old
  and that no open submission still names. To run it by hand, use **Actions →
  Uploads cleanup → Run workflow**; tick **Preview only** to list what would be
  deleted without deleting anything. (An issue the automation itself closes,
  such as a declined submission, does not start the first run; the daily sweep
  catches it.)

Then delete the downloaded `.pem` file.

### 5. Turn it on in the catalog

In `_data/site.yml`:

```yaml
submit:
  signin_url: "https://catalog-signin.vercel.app"
  uploads_url: "https://catalog-uploads.vercel.app"
```

Use the service's address only, with no path. `npm run validate` checks it,
and refuses `uploads_url` without `signin_url`.

### 6. Add a rate-limit rule as a backstop

The service holds each GitHub account to its own limits, but anyone can make
up GitHub accounts. In the Vercel project, under **Firewall**, add a rate-limit
rule on the path `/api/upload`, for example 60 requests per minute per IP
address. Normal use is far below that.

### 7. Try it

Publish the change, open `/submit/`, sign in, and submit a test entry with a
deck and three screenshots. Check the draft pull request shows the files, edit
the issue and check they are still there, then close the issue and check the
uploads repository has no branches left under `u/`.

## Limits

- **4 MB per file**, for screenshots and decks alike (Vercel accepts at most
  4.5 MB per request on every plan). Screenshots are shrunk in the browser
  first, so they rarely come close. A bigger deck has to be exported smaller
  ("export as PDF, minimum size") or linked instead.
- **3 drafts per person** with files at once. A fourth is refused with a
  message asking the submitter to finish or remove the files of an earlier
  draft.
- **9 files per draft.**
- **GitHub's own limit:** an App may make about 80 content-creating requests a
  minute and 500 an hour. Each file takes four, so that is roughly fourteen
  submissions an hour with a deck and eight screenshots each, for the whole
  catalog. When GitHub says to slow down, the service answers `429` with a
  `Retry-After` time (`rate_limited`) and the page waits and tries again, a few
  times at most. The per-person limits above are answered `429` too, but the
  page does not retry those: it shows the message.

## For the submit page

`OPTIONS /api/upload` answers the CORS preflight for the allowed origins.

`POST /api/upload`, with the file as the raw body:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <the submitter's GitHub sign-in token>` |
| `Content-Type` | `application/octet-stream` |
| `X-Upload-Set` | the draft's id: 26 characters of `a`–`z` and `2`–`7` |
| `X-Upload-Kind` | `image` or `pdf` |
| `X-Upload-Name` | optional, up to 200 characters, for display only; never stored |

`201` answers `{"ref":"upload:<set>/<sha256>.<ext>","sha256":"…","bytes":n,"ext":"png|jpg|webp|pdf"}`.

`DELETE /api/upload?ref=upload:<set>/<sha256>.<ext>` removes one of the
caller's own files and answers `204`, also when it was already gone.

Errors answer `{"error":"<code>","message":"<a sentence for the submitter>"}`:

| Status | `error` |
| --- | --- |
| 400 | `bad_set`, `bad_kind`, `bad_name`, `bad_length`, `bad_ref`, `empty_file`, `interrupted` |
| 401 | `unauthorized`: sign in again |
| 403 | `origin_not_allowed`, `account_too_new` |
| 405 | `method_not_allowed` |
| 413 | `too_large` |
| 415 | `wrong_content_type`, `not_an_image`, `not_a_pdf` |
| 429 | `rate_limited` (retry after `Retry-After` seconds); `too_many_drafts`, `too_many_files` (a limit, not worth retrying until the submitter removes files) |
| 500 | `not_configured` |
| 503 | `github_unavailable` |

## Develop and test

```sh
node --test "services/uploads/test/*.test.mjs" test/scripts/upload_refs_parity.test.mjs
```

The tests call the handler directly with a fake GitHub, so they never touch the
network. `lib/refs.mjs` is a copy of `scripts/lib/upload_refs.mjs`, because
this service deploys from its own directory; the parity test fails if the two
drift apart. The repository's `npm test` and `npm run lint` include this
directory.

## Rotate or remove

- **Rotate the App's private key:** generate a new key on the app, then update
  `UPLOADS_APP_PRIVATE_KEY` in both places: `npx vercel env rm
  UPLOADS_APP_PRIVATE_KEY production`, `npx vercel env add
  UPLOADS_APP_PRIVATE_KEY production`, `npx vercel deploy --prod`, and the
  catalog repository's secret. After that, delete the old key on GitHub.
- **Turn it off:** blank `submit.uploads_url` and publish. Submissions already
  open keep their `upload:` lines; leave the App installed until they are
  scaffolded and closed, or ask those submitters to attach the files on GitHub.
  Then uninstall or delete the uploads App, delete the uploads repository and
  the catalog's `UPLOADS_*` secrets and variable, and remove the Vercel project.
