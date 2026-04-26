# Changelog

All notable changes to bumpsight are documented here.

## Unreleased — v0.2 foundation

Daemon-mode foundation. Apply step + HTTP approve/deny + Docker image are landing in a follow-up commit before the v0.2.0 tag.

### Added

- **`bumpsight daemon`** subcommand: long-lived process that periodically rescans configured compose files, classifies new tags as `patch` / `minor` / `major` / `unknown` against the same family detection used by `scan`, and routes each bump through a per-stack policy.
- **Auto-apply policy engine** (`patch` / `minor` / `major` / `notify` / `none`) configurable globally via `--auto-apply` / `BUMPSIGHT_AUTO_APPLY` and per-stack via a `/config/bumpsight.yaml` file. Unknown bumps are always held for human approval, regardless of policy.
- **SQLite state layer** (`better-sqlite3`) tracking every discovered bump through the `pending → notified → approved/denied → applied/failed` lifecycle. Idempotent on rescans — repeat discoveries don't duplicate rows or re-spam notifications.
- **Notifier framework** with two drivers shipped:
    - **SMTP** via nodemailer (`smtp://` and `smtps://` URIs) — username/password, multiple `?to=` recipients, plain-text body.
    - **Apprise** via HTTP POST to an existing apprise-api endpoint (`apprise://` and `apprises://` URIs) — Markdown-formatted body, inherits Apprise's 70+ channels (Discord, ntfy, Slack, Gotify, …) without bringing them into the bumpsight container.
    - Multiple notifiers via comma-separated `--notify` / `BUMPSIGHT_NOTIFY` URIs.
- **`--once`** flag for daemon — single scan pass; useful for cron-driven setups and tests.
- **Duration parser** for human-friendly intervals (`30s`, `10m`, `6h`, `1d`).

### Changed

- `--version` now actually prints the version when called without a subcommand (previously fell through to help).

### Coming in v0.2.0

- Docker-socket integration to actually `compose pull && up -d` for queued auto-applies and approved holds.
- HTTP server with signed approve/deny URLs, embedded in approval emails.
- Docker image (GHCR) published on tag push, with a single drop-in compose snippet.
- Weekly digest report (applied / pending / failed) via the same notifier list.
- README rewrite reflecting the daemon-mode workflow.

## 0.1.0 — 2026-04-21

First public release. Three commands, fully offline-capable except `advise`.

### Added

- **`bumpsight doctor <compose>`** — compose-file linter with 10 stable rules covering `:latest` use, privileged containers, host networking, missing healthchecks, secret-shaped env values, missing restart policies, missing memory limits, exposed Docker sockets, and dangerous `cap_add` capabilities. Exit code `1` on errors, `0` otherwise. JSON output via `--json`.
- **`bumpsight scan <compose>`** — registry tag-freshness check against Docker Hub and `ghcr.io`, scoped to the same version family of each image's existing tag (won't bump `16` to `16.2` or `16.2-alpine` to `16.3`). `--offline` skips the network and `--timeout` controls per-image budget.
- **`bumpsight advise <image> --to <tag>`** — fetches GitHub releases between two tags, feeds them to a local Ollama model, and returns a structured summary of breaking changes, new features, and required actions. Optional `--compose` + `--service` lets the LLM call out env-vars and ports specific to your config. Image → upstream-repo mapping uses an explicit `--repo` override, then `linuxserver/*` and `ghcr.io/*` heuristics, then a Docker Hub description scan.

### Notes

- Watchtower was archived 2025-12-17; bumpsight is the human-in-the-loop alternative — it tells you what's new and what's risky rather than auto-applying.
- Daemon mode (scheduler + email/Apprise notifications + auto-apply gates) is planned for v0.2.
