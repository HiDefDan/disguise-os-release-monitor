# disguise-os-release-monitor

Watches the [Disguise hardware OS images page](https://help.disguise.one/hardware/hardware-os-images)
and opens a GitHub Issue when the latest OS image for any hardware platform changes.
Disguise has no notification service for OS updates. This repo fills that gap.

**[📋 Latest image for each platform → LATEST.md](LATEST.md)** (regenerated whenever the page changes)

## How it works

- `.github/workflows/watch.yml` runs every 6 hours (at :17) and on demand.
- `watch.mjs` (Node 24, no dependencies) fetches the page and extracts every
  `cfpkg.disguise.one/pkg/os-image/<platform>/<version>/<file>.iso` link.
- Every listed image is committed to `latest.json` as `{ "<platform>/<version>": "<filename>" }`.
  The filename includes the build hash, so silent re-releases are caught, including
  re-releases of older images that are no longer the newest for their platform.
- An issue is opened when any image's filename changes (re-release), or a new version or
  platform appears. Each entry shows the release or re-release date and reason from the page's
  revision history (when the page gives one), and marks the newest image for each platform.
  The first run records a baseline and opens no issue.
- It also reads Disguise's [legacy products page](https://www.disguise.one/en/products/legacy-products)
  and matches each legacy product to an OS platform by model name. `LATEST.md` marks platforms
  whose models are all (🟥) or partly (🟧) discontinued, with the successor, and has a legacy
  products table with each product's newest OS image. **Discontinued means no longer sold, not
  that OS builds have stopped** (RX I / RX II got 26Q1 two years after RX II was discontinued),
  so legacy platforms stay fully watched. Changes to the legacy list (a product added, removed
  or re-dated) raise an issue too. The list is committed as `legacy.json`.
- If the page can't be fetched or contains no ISO links, the run **fails** (red X, plus GitHub's
  failed-workflow email), so a broken scraper never looks like "nothing new". If only the legacy products page fails, OS
  alerts still go out and state is still committed, using the last known legacy list, and the
  run is then marked failed. Reading dates is
  best effort: if the page wording changes, alerts still go out, just without the date.
- `LATEST.md` is regenerated each run: the newest image per platform with release date, Windows
  and Designer versions and a download link, plus a collapsible list of every image. It has no
  timestamps, so it is only committed when something on the page changes.
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

## Versioning

Releases follow [Semantic Versioning](https://semver.org/) and are tagged `vX.Y.Z`. See
[CHANGELOG.md](CHANGELOG.md) for what changed in each release. To release: move the
`[Unreleased]` notes under a new version heading, update the compare links, commit, then
`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, for example `feat: track every listed image` or `fix(latest): read h3 headings`.
`feat` means a minor release, `fix` a patch, and `!` after the type (or a `BREAKING CHANGE:` footer)
a major one. `docs`, `ci`, `chore` and `refactor` need no release on their own. The workflows'
own commits are `chore(data): update watched state` and `chore(keepalive): monthly activity commit`.

## License

The code (`watch.mjs` and the workflows) is released under the [MIT License](LICENSE).

The generated data files (`latest.json`, `legacy.json`, `LATEST.md`) are derived from Disguise's
public [hardware OS images](https://help.disguise.one/hardware/hardware-os-images) and
[legacy products](https://www.disguise.one/en/products/legacy-products) pages. That content,
including quoted release notes, belongs to Disguise and is not covered by the MIT License.
"Disguise" and its product names are trademarks of Disguise.

This project is not affiliated with or endorsed by Disguise. Always check the official pages
before reimaging hardware.
