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
- It also reads the [product compatibility](https://help.disguise.one/hardware/product-compatibility)
  page. `LATEST.md` has a **Designer compatibility by model** section: lifecycle phase, first and
  latest supported Designer, whether the model runs the latest Designer, and which Designer range
  each OS version supports, linked to the model's OS images. Changes (e.g. a model moving to End
  of Support) raise an issue and a push in that server type's thread. Committed as
  `compatibility.json`.
- If the page can't be fetched or contains no ISO links, the run **fails** (red X, plus GitHub's
  failed-workflow email), so a broken scraper never looks like "nothing new". If only the legacy products or compatibility page fails, OS
  alerts still go out and state is still committed, using the last known data for that page, and
  the run is then marked failed. Reading dates is
  best effort: if the page wording changes, alerts still go out, just without the date.
- `LATEST.md` is regenerated each run: the newest image per platform with release date, Windows
  and Designer versions and a download link, plus a collapsible list of every image. It has no
  timestamps, so it is only committed when something on the page changes.
- Each run's log lists every image, its date as read from the page, and the newest per platform.

Only the OS images, legacy products and product compatibility pages are requested. ISOs are never downloaded. Besides the
built-in `GITHUB_TOKEN`, the only secrets are the optional Notify! device ID and token below.

## Setup

### Push notifications per server type (Notify! app)

Each changed server type gets its own push, stacked in its own thread on your phone, e.g.
"GX 3+: 26Q1 re-released" with the build and the reason underneath. Legacy-list changes push too.

1. Install [Notify! – Web & Script Notifier](https://apps.apple.com/gb/app/notify-web-script-notifier/id6748288936)
   and open Settings to find your **Device ID** and **token**.
2. In this repo go to **Settings → Secrets and variables → Actions** and add two repository
   secrets: `NOTIFY_DEVICE_ID` and `NOTIFY_DEVICE_TOKEN`.
3. Optional: to hear about some server types only, add a repository **variable** (Variables tab)
   called `NOTIFY_PLATFORMS`, e.g. `GX3P, vx4p, RX3`. Leave it unset for all of them. The IDs
   are the platform folder names:

   | ID | Server type | ID | Server type |
   |:--|:--|:--|:--|
   | `GX3P` | GX 3+ | `vx4p` | VX 4+ |
   | `EX2C_EX2_EX3P` | EX 2 / EX 2C / EX 3+ | `vx2p` | VX 2+ |
   | `RX3` | RX III | `vx3` | VX 3 |
   | `rx` | RX I / RX II | `vx4` | VX 4 |
   | `gx3` | GX 3 | `vx12` | VX 1 / VX 2 |
   | `gx2c` | GX 2C | `EX3` | EX 3 |
   | `2xgx` | GX 1 / GX 2 / 2x4pro | `solo` | Solo |
   | `pro` | 4x4 / 4x2 | `plus` | 2x2plus |

4. Run **Actions → disguise-os-watch → Run workflow** with **Send a test push** ticked.

If a push fails (for example a wrong token), the issue and state commit still go through and the
run is marked failed, so you get GitHub's failure email. Without the secrets, pushes are skipped
with a warning.

### GitHub issues

Every change is also opened as an issue, the permanent record. To get those on your phone too:

1. Install the **GitHub** iOS app and sign in.
2. On this repo choose **Watch → Custom → Issues** (or All activity).
3. Enable push notifications in the app.

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
- **Locally:** `node watch.mjs` (set `PAGE_URL`, `LEGACY_URL` or `COMPAT_URL` to test against
  another page). Behind an HTTPS proxy, Node needs `NODE_USE_ENV_PROXY=1`.

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
