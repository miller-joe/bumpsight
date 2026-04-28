# Changelog

All notable changes to bumpsight are documented here.

## 0.2.1 — 2026-04-27

Reliability fixes shaken out by the v0.2.0 dogfood deploy.

### Fixed

- **Held bumps no longer get marked `notified` when delivery fails.** A row is only advanced to `notified` after at least one notifier reports success. Previously, an SMTP rejection (e.g. an MXroute throttle) would silently bury the row — it would never re-fire on later scans. Now failed deliveries leave rows in `pending` and the next scan retries.

### Added

- **Per-message dispatch rate limit.** New `BUMPSIGHT_NOTIFY_INTERVAL` env (also `notify_interval:` in `bumpsight.yaml`), default `10s`. Enforces a minimum gap between dispatched notifications so a 13-bump first scan doesn't trip the SMTP relay's rate limit.
- **Image-level dedup.** Multiple stacks running the same image bump now collapse into a single notification — e.g. 17 vault-agent sidecars on `1.21 → 1.22` produce one email listing all stacks, not 17. Approving (or denying) the canonical link applies the decision to every sibling stack in the group.

## 0.2.0 — 2026-04-26

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
- LLM client switched from Ollama-native to **OpenAI-compatible** at the protocol level. Same client works with LiteLLM (recommended for cloud fan-out), Ollama (`/v1` since 0.1.40), OpenAI, vLLM, llama.cpp, and any other gateway exposing `/v1/chat/completions`. Configured via `BUMPSIGHT_LLM_URL` and `BUMPSIGHT_LLM_KEY`; legacy `OLLAMA_HOST` still accepted.
- Email subject simplified to `stack/service: image → tag` — no more `[bumpsight]` prefix or `(bump — banner)` suffix. Body grew the action card (instruction + styled Approve/Deny buttons) at the top; metadata + LLM summary follow.
- Hold notifications now ship as HTML with a multipart text fallback. Action card is a colored box, buttons are real styled `<a>` elements (green Approve, slate Deny), metadata in a clean table, LLM summary in a soft monospace block.
- Daemon now **auto-discovers** every `<stacks_dir>/<name>/compose.{yaml,yml}` by default (root configurable via `BUMPSIGHT_STACKS_DIR`). The opt-out model: per-stack policy `none` excludes a stack from scanning. The legacy `compose_files:` allowlist still works when set.
- `advise` upstream-repo resolution gained a curated table for Docker Official images (node, postgres, redis, nginx, vault, …) so the LLM gets real release notes instead of empty wrapper-repo results. Tag-name matching now does prefix and substring fallback, so an image pinned to `8.0` finds a release tagged `8.0.40`.
- `advise` caps the prompt at the 25 most-recent releases in range to keep cloud-LLM round-trips under the timeout for active repos like hashicorp/vault.
- Default LLM call timeout dropped from 120s to 60s — cloud routers reply in single-digit seconds, and 60s prevents one stuck call from wedging a 48-stack scan.

## 0.1.0 — 2026-04-21

First public release. Three commands, fully offline-capable except `advise`.

### Added

- **`bumpsight doctor <compose>`** — compose-file linter with 10 stable rules covering `:latest` use, privileged containers, host networking, missing healthchecks, secret-shaped env values, missing restart policies, missing memory limits, exposed Docker sockets, and dangerous `cap_add` capabilities. Exit code `1` on errors, `0` otherwise. JSON output via `--json`.
- **`bumpsight scan <compose>`** — registry tag-freshness check against Docker Hub and `ghcr.io`, scoped to the same version family of each image's existing tag (won't bump `16` to `16.2` or `16.2-alpine` to `16.3`). `--offline` skips the network and `--timeout` controls per-image budget.
- **`bumpsight advise <image> --to <tag>`** — fetches GitHub releases between two tags, feeds them to a local Ollama model, and returns a structured summary of breaking changes, new features, and required actions. Optional `--compose` + `--service` lets the LLM call out env-vars and ports specific to your config. Image → upstream-repo mapping uses an explicit `--repo` override, then `linuxserver/*` and `ghcr.io/*` heuristics, then a Docker Hub description scan.

### Notes

- Watchtower was archived 2025-12-17; bumpsight is the human-in-the-loop alternative — it tells you what's new and what's risky rather than auto-applying.
- Daemon mode (scheduler + email/Apprise notifications + auto-apply gates) is planned for v0.2.
