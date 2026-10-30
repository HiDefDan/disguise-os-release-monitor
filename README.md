# disguise-os-release-monitor

Watches the [Disguise hardware OS images page](https://help.disguise.one/hardware/hardware-os-images)
and opens a GitHub Issue when the latest OS image for any hardware platform changes.
Disguise has no notification service for OS updates. This repo fills that gap.

## How it works

- `.github/workflows/watch.yml` runs every 6 hours (at :17) and on demand.
- `watch.mjs` (Node 20, no dependencies) fetches the page and extracts every
  `cfpkg.disguise.one/pkg/os-image/<platform>/<version>/<file>.iso` link.
- Every listed image is committed to `latest.json` as `{ "<platform>/<version>": "<filename>" }`.
  The filename includes the build hash, so silent re-releases are caught, including
  re-releases of older images that are no longer the newest for their platform.
- An issue is opened when any image's filename changes (re-release), or a new version or
  platform appears. Each entry shows the release or re-release date and reason from the page's
  revision history (when the page gives one), and marks the newest image for each platform.
  The first run records a baseline and opens no issue.
- If the page can't be fetched or contains no ISO links, the run **fails** (red X, plus GitHub's
  failed-workflow email), so a broken scraper never looks like "nothing new". Reading dates is
  best effort: if the page wording changes, alerts still go out, just without the date.
- Each run's log lists every image, its date as read from the page, and the newest per platform.

Only that one page is requested. ISOs are never downloaded. Only the built-in `GITHUB_TOKEN`
is used. No secrets are needed.

## Setup

1. Install the **GitHub** iOS app and sign in.
2. On this repo choose **Watch → Custom → Issues** (or All activity).
3. Enable push notifications in the app.
4. Run the workflow once from **Actions → disguise-os-watch → Run workflow** to record the baseline.

## Keepalive

GitHub disables scheduled workflows after 60 days without repository activity. Disguise
releases roughly quarterly, so `.github/workflows/keepalive.yml` commits a timestamp to
`.keepalive` on the 1st of each month. If a scheduled workflow is ever disabled anyway,
re-enable it under **Actions → (workflow) → Enable workflow**.

## Testing

- **Change detection:** edit one filename in `latest.json`, commit, then run the workflow.
  It should open exactly one issue listing that image (with its date) and restore `latest.json`.
- **Failure path:** run the workflow with the `page_url` input set to a page with no ISO links
  (for example `https://example.com/`). The run should fail and nothing should be committed.
- **Locally:** `node watch.mjs` (set `PAGE_URL` to test against another page).
