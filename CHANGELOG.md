# Changelog

All notable changes to bumpsight are documented here.

## 0.4.0 — 2026-04-28

Policy split: app and dependencies are now independent axes. Backward-compatible loader.

### Added

- **Per-stack policy split.** Each stack now has two orthogonal axes: `app` (the primary service) and `dependencies` (sidecar images bumpsight recognizes as dep layers — Postgres, Redis, MariaDB, Vault, Valkey, RabbitMQ, etc.). Each axis takes one of `patch | minor | major | notify | none`.

  ```yaml
  default:
    app: minor              # auto-apply patches + minors of the primary app
    dependencies: none      # never touch Postgres / Redis / etc.

  stacks:
    vault:
      app: patch
      dependencies: none
    outline:
      app: minor
      dependencies: notify  # tell me, I decide
  ```

  Or env vars: `BUMPSIGHT_AUTO_UPDATE_APP=minor` and `BUMPSIGHT_AUTO_UPDATE_DEPENDENCIES=none`.

  At-or-below the level → auto-apply silently. Above → ask email with AI assessment. `none` → silent skip. `notify` → ask for any change.
- **Backward-compat loader.** Legacy single-axis configs (`default: minor`, `stacks: { vault: patch }`) keep working. They auto-map at load time to `{ app: <value>, dependencies: notify }` — preserves the v0.3.x behavior of holding dep bumps for human approval. Deprecation warnings printed at startup. Migrate at your leisure.

### Changed

- **`decideAction(config, stack, bump, isDependency)`** — added the `isDependency` flag. The daemon scan path computes it once per bump via `isDependencyImage(image)` and routes to the correct axis.
- **The `report` action is dropped.** Was an underused FYI middle ground (dispatched email but no approve/deny); `notify` covers the use case. Legacy `report` in config files auto-migrates to `notify` with a one-time startup warning.
- **The hack from v0.3.3** that force-held dep-major regardless of policy is removed — the new dependencies axis makes it explicit and operator-controllable.

### Notes

- v0.4.1 will add the daily-digest email (auto-applied bumps aggregated into one daily report instead of per-apply). For v0.4.0, immediate per-apply emails still ship — the policy split is the primary v0.4.0 contract change.
- No DB schema break beyond the additive `digested_at` column on `updates` (preparing for v0.4.1, harmless on v0.4.0).

## 0.3.3 — 2026-04-28

LinuxServer.io tag support, dependency-image awareness, tighter advise prompts.

### Added

- **LinuxServer.io tag format support.** Tags like `4.0.17.2952-r0-ls309` now parse cleanly: build-number suffix patterns (`-r\d+`, `-ls\d+`, `-build\.\d+`) are stripped from the family discriminator so `4.0.17.2952-r0-ls309` and `4.0.18.2960-r0-ls310` end up in the same family and compare normally. The `version-` prefix common in LSIO tags is also stripped before parsing. Affects: sonarr, radarr, lidarr, prowlarr, qbittorrent, plex, and any other `linuxserver/*` image bumpsight scans.
- **Dependency-image awareness in advise output.** New `isDependencyImage()` helper in `src/daemon/rules.ts` recognizes well-known dependency layers (Postgres, MariaDB, MySQL, Mongo, Redis, Valkey, RabbitMQ, Kafka, Elasticsearch, OpenSearch, Vault, Consul, ClickHouse, InfluxDB, Meilisearch, Qdrant, Weaviate, Chroma, etc.). When advise is asked about a *major* bump of one of these, the LLM prompt switches to a "wait for the parent app to bump it" framing instead of "here's what to check before upgrading." Independent dependency-major upgrades risk on-disk format breaks, schema mismatches, or silent data corruption — bumpsight now reflects that.

### Changed

- **Tightened advise system prompts.** Both the release-notes and general-knowledge prompts now explicitly forbid "check the changelog / verify with the team / consult the docs / look up X / review the upgrade guide" punts. The LLM is required to give concrete findings from the supplied notes (or say "None mentioned in the supplied notes." explicitly) instead of redirecting the user. Every section of the output is required even if the body is just "None." — no silent skips. The general-knowledge prompt now also requires every section.
- **Recommended-action section** added to the release-notes prompt (was only in the opinion-only prompt). Both flavors now end with a short, opinionated approve / approve-after-quick-check / hold-for-review / hold-for-thorough-review verdict.

### Notes

- The dependency-image list covers canonical Docker Hub names (e.g. `postgres`, `library/postgres`, `hashicorp/vault`, `valkey/valkey`). Forks under custom namespaces (e.g. `randomfork/postgres-custom`) are intentionally **not** matched — the canonical names cover the ~95% case for typical homelab stacks. Add forks to the set if you maintain one.
- LSIO tag-name parsing is purely a family-discriminator fix; no schema or behavior change for non-LSIO images.

## 0.3.2 — 2026-04-28

`:latest` digest tracking — Phase 2: digest → semver resolution + GHCR support.

### Added

- **Digest → semver tag resolution.** When a moving tag (`:latest`, `:stable`, …) gets a new digest, bumpsight now looks for a semver-shaped tag in the registry that shares the digest (e.g. `nginx:latest` → digest also tagged `1.27.5`). When both the prior and new digests resolve to semver tags, the change is classified as a normal `patch` / `minor` / `major` bump and the stack's policy decides auto-apply vs hold — fulfilling the "12.1→12.2 auto, 12→13 ask" workflow.
- **GHCR digest tracking.** Now works on GHCR images. The Docker Registry v2 `/tags/list` endpoint that GHCR uses doesn't return digests inline, so bumpsight falls back to per-tag manifest probes (`HEAD /v2/<repo>/manifests/<tag>`) — capped at 30 probes per resolution to keep scans fast.
- **`Origin: digest change on :<tag>` line** in held + auto-applied notifications when the underlying source was a moving-tag bump. Makes it obvious that the resolved semver pair came from `:latest`'s pointer moving, not from rewriting `:latest` to a pinned tag in the compose file.
- **`tag_digests.resolved_tag` column.** Stores the semver tag we matched a digest to at observation time, so the next scan can compare resolved-pair against resolved-pair without re-probing the prior side.

### Changed

- **Auto-applied moving-tag bumps no longer rewrite the compose file.** When a `:latest` digest change resolves and falls under auto-apply policy, the daemon runs `docker compose pull && up -d` against the existing `:latest` reference instead of pinning the file to the resolved tag. The user's choice to track a moving tag is preserved.
- **Schema migration.** `tag_digests` gains a nullable `resolved_tag` column. Pre-v0.3.2 rows simply have NULL there — those bumps fall back to Phase 1 behavior (always hold) on the next observed digest change, since we don't know what tag the prior digest resolved to. Idempotent — safe to upgrade from v0.3.1.

### Notes

- When digest resolution fails on either the prior or new side (e.g. registry pruned the matching tag, or it's pinned outside the 200-tag horizon), the daemon falls back to Phase 1 — emit a `digest`-kind bump with hex prefixes and always hold.
- LLM advise now runs on resolved moving-tag bumps too, since the resolved semver pair is a real upstream tag range.

## 0.3.1 — 2026-04-27

`:latest` digest tracking — Phase 1.

### Added

- **Digest tracking for moving tags.** Bumpsight now detects when a non-semver tag (e.g. `:latest`, `:stable`, `:edge`, `:main`, `:master`, `:rolling`, `:current`, `:nightly`, `:dev`, `:develop`) gets a new digest under the same name — the case watchtower used to handle. First scan records the digest silently; later scans compare and emit a bump when the digest changes.
- **New `digest` bump kind.** Records show as `bump=digest` with the prior+new digest prefixes in the `current_tag`/`target_tag` columns. Subject line is `<image> digest changed` instead of the `→ <tag>` form. Always held for approval — Phase 2 will resolve digest → highest-precision tag and apply semver policy ("12.1→12.2 auto, 12→13 ask").
- **`tag_digests` table** stores last-seen `(image, tag) → digest, seen_at`. Lookup helpers exported from `src/state/db.ts`.
- **`isMovingTag` helper** in `src/daemon/rules.ts` — single source of truth for what counts as a moving tag.

### Changed

- **Schema migration.** The `bump` column previously had a CHECK constraint allowing only `patch | minor | major | unknown`. SQLite can't ALTER a CHECK in place, so `openDb` now detects the old form and rebuilds the table on first open. Idempotent — safe to upgrade from any prior v0.x DB.

### Notes

- **GHCR digest tracking is not yet supported** in this phase. The Docker Registry v2 `/tags/list` endpoint that GHCR uses doesn't return digests inline; getting them requires a per-tag manifest fetch. Phase 2 will add that.
- Digest bumps **always hold for approval** under any policy. Auto-apply for digest changes lands when Phase 2 ships the digest → semver-tag resolution.

## 0.3.0 — 2026-04-27

Visibility + parity batch.

### Added

- **`/queue` HTTP route.** Visit `BUMPSIGHT_PUBLIC_URL/queue` to see a styled HTML table of every tracked bump grouped by status (pending / notified / failed / denied / applied), with inline approve/deny links on actionable rows. Removes the need to `sqlite3` the state DB to see what's happening.
- **`report` policy level.** New per-stack action that sits between `notify` and `none`: bump is recorded, an HTML notification is dispatched, but no approve/deny flow is generated and no token is created. Useful for stacks where you only want awareness ("noisy upstream, I'll handle it manually when it matters"). Configure as `default: report` or per-stack in `bumpsight.yaml`, or `BUMPSIGHT_AUTO_APPLY=report`.
- **HTML + LLM summary on auto-applied notifications.** Auto-apply emails now ship as HTML with a green success banner (or red failure banner) at the top, full metadata table, the apply log, and the LLM upstream-release-note summary or general-knowledge opinion when `BUMPSIGHT_LLM_URL` is configured. Brings auto-applied notifications to parity with held-bump notifications.

### Changed

- Internal: `dispatchHoldNotification` was renamed to `dispatchBumpNotification` and now takes a `mode: "hold" | "report"` discriminator. Buttons, action-card text, and the HTML body branch on mode.

## 0.2.2 — 2026-04-27

Release pipeline fix only. Same code as v0.2.1.

### Fixed

- Multi-arch GHCR image build was hanging on the buildx cache export step. Switched the buildx cache backend from `type=gha` to GHCR-backed registry cache (`type=registry,ref=…:buildcache`) — fixes the hang and keeps `linux/amd64`+`linux/arm64` both publishing. Workflow also gained a `timeout-minutes: 30` guard and a `workflow_dispatch:` trigger so future stalls die cleanly and can be re-run from the Actions UI.

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
