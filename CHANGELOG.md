# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public interface for versioning purposes is the format of `latest.json`, the content of
alert issues, and `LATEST.md`. A change that breaks anything reading `latest.json` is a major
version. Automated commits by the workflow (`Update latest OS images`, `Keepalive`) are data,
not releases, and are not versioned.

## [Unreleased]

## [2.1.1] - 2026-10-30

### Changed
- Run the watcher on Node 24. Node 20 reached end-of-life in April 2026.
- Use `actions/checkout@v5` and `actions/setup-node@v5`, which run on Node 24, in both
  workflows. This removes the Node 20 deprecation warning from run logs.

## [2.1.0] - 2026-10-30

### Added
- `LATEST.md`: a rendered summary of the newest image per platform, using Disguise's own
  platform names linked to the official page, with release or re-release date and reason,
  Windows version, compatible Designer versions and a download link. It also has a collapsible
  list of every image and a watcher status badge. It has no timestamps, so it is only committed
  when the page changes.

## [2.0.0] - 2026-10-30

### Changed
- **Breaking:** `latest.json` now lists every image on the page, keyed by
  `"<platform>/<version-folder>"`, instead of one image per platform. An old-format file is
  replaced by a new baseline without raising an issue.
- Alerts now cover re-releases of any listed image, not only the newest per platform
  (for example the GX 3 `25Q1` re-release on 28/Sep/2026, which 1.0.0 missed).
- Each image in an alert shows its release or re-release date and reason from the page,
  what it replaces, and whether it is the newest for its platform.
- Run logs list every image with the date read from the page.

## [1.0.0] - 2026-10-30

### Added
- Scheduled watcher (every 6 hours, plus manual runs) for the Disguise hardware OS images page.
- `latest.json` recording the newest ISO filename per platform; compares filenames, so silent
  re-releases with a new build hash are caught.
- A GitHub issue for each change, raised before state is committed so a failed alert is retried.
- Fails visibly when the page can't be fetched or lists no ISOs.
- Monthly keepalive workflow so the schedule isn't disabled after 60 days of inactivity.
- Optional `page_url` input for testing the failure path.

[Unreleased]: https://github.com/HiDefDan/disguise-os-release-monitor/compare/v2.1.1...HEAD
[2.1.1]: https://github.com/HiDefDan/disguise-os-release-monitor/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/HiDefDan/disguise-os-release-monitor/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/HiDefDan/disguise-os-release-monitor/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/HiDefDan/disguise-os-release-monitor/releases/tag/v1.0.0
