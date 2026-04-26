# Changelog

All notable changes to bumpsight are documented here.

## Unreleased — v0.2

Daemon-mode release. Watchtower-replacement scope.

### Added

- **`bumpsight daemon`** subcommand: long-lived process that periodically rescans configured compose files, classifies new tags as `patch` / `minor` / `major` / `unknown`, and routes each through a per-stack policy.
- **Auto-apply policy engine** (`patch` / `minor` / `major` / `notify` / `none`) — global default + per-stack overrides via `/config/bumpsight.yaml`. Unknown bumps are always held for human approval regardless of policy.
- **Compose-file rewriter** that swaps only the tag of the targeted service via the yaml CST API, preserving comments, formatting, and other services. Race-safe — refuses to rewrite when the on-disk tag has drifted from what was scanned.
- **`docker compose pull` + `up -d`** apply step running against the host's Docker socket. Combined output captured into the apply log.
- **Approve / deny HTTP server** (port 9100 by default): GET `/approve/<token>` marks approved + kicks off apply in the background; GET `/deny/<token>` marks denied. Idempotent on re-clicks. Tokens are 24-byte random strings stored alongside each pending update.
- **SQLite state layer** (`better-sqlite3`) tracking every discovered bump through the `pending → notified → approved/denied → applied/failed` lifecycle. Idempotent on rescans.
- **Notifier framework** with two drivers shipped:
    - **SMTP** / **SMTPS** via nodemailer — `?to=` (multiple recipients), `?from=` required.
    - **Apprise** via HTTP POST to an existing apprise-api endpoint (`apprise://` / `apprises://`). Inherits Apprise's 70+ channels without embedding them in bumpsight.
    - Comma-separated stacking via `BUMPSIGHT_NOTIFY`. Per-channel failures don't block delivery to the others.
- **Approve / deny links** are embedded directly in held notifications when `BUMPSIGHT_PUBLIC_URL` is set.
- **GHCR image** `ghcr.io/miller-joe/bumpsight` built for `linux/amd64` and `linux/arm64`, published on every `v*` tag push by the new release workflow.
- **Dockerfile** — multi-stage build, `node:20-alpine` runtime with `docker-cli` + `docker-cli-compose` so the daemon can shell out to `docker compose` against the mounted host socket. `tini` for signal forwarding.
- **`--once`** flag for daemon — single scan pass; useful for cron-driven setups and tests.
- **Duration parser** for human-friendly intervals (`30s`, `10m`, `6h`, `1d`).
- **README rewrite** that leads with the daemon drop-in.

### Changed

- `--version` now actually prints the version when called without a subcommand (previously fell through to help).

## 0.1.0 — 2026-04-21

First public release. Three commands, fully offline-capable except `advise`.

### Added

- **`bumpsight doctor <compose>`** — compose-file linter with 10 stable rules covering `:latest` use, privileged containers, host networking, missing healthchecks, secret-shaped env values, missing restart policies, missing memory limits, exposed Docker sockets, and dangerous `cap_add` capabilities. Exit code `1` on errors, `0` otherwise. JSON output via `--json`.
- **`bumpsight scan <compose>`** — registry tag-freshness check against Docker Hub and `ghcr.io`, scoped to the same version family of each image's existing tag (won't bump `16` to `16.2` or `16.2-alpine` to `16.3`). `--offline` skips the network and `--timeout` controls per-image budget.
- **`bumpsight advise <image> --to <tag>`** — fetches GitHub releases between two tags, feeds them to a local Ollama model, and returns a structured summary of breaking changes, new features, and required actions. Optional `--compose` + `--service` lets the LLM call out env-vars and ports specific to your config. Image → upstream-repo mapping uses an explicit `--repo` override, then `linuxserver/*` and `ghcr.io/*` heuristics, then a Docker Hub description scan.

### Notes

- Watchtower was archived 2025-12-17; bumpsight is the human-in-the-loop alternative — it tells you what's new and what's risky rather than auto-applying.
- Daemon mode (scheduler + email/Apprise notifications + auto-apply gates) is planned for v0.2.
