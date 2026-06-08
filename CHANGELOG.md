# Changelog

All notable changes to bumpsight are documented here.

## 0.5.7 — 2026-06-08

Watched releases — opt-in tracking of non-Docker upstreams. Bumpsight's scan loop only sees Docker images referenced by an `image:` key in a discovered compose file. Versions that live elsewhere — a binary baked into a Dockerfile by a hardcoded pin, a tool in a `build:`-only container — never produce a compose image tag, so the scanner is structurally blind to them. (This is exactly the gap that let a git-lfs 3.3.0 → 3.6.1 bump on a dev container go unflagged.) `watched_releases` closes it: declare the upstream GitHub repo + your installed version, and bumpsight polls GitHub Releases and emails when a newer one appears. **Notify-only** — bumpsight can't install a host binary, so there are no Approve/Deny links; the email tells you to update the pin yourself and bump `current:` afterward.

### Added

- **`watched_releases` config (`src/daemon/config.ts`).** A top-level list in `bumpsight.yaml`: each entry is `{ repo: "owner/repo", current: "<installed version>", name?, policy?: notify|none, include_prerelease?: bool }`. `buildWatchedReleases()` validates entries independently — a malformed one is logged and **skipped**, never fatal, so a typo in an opt-in extra can't take down the core image-watching daemon. Duplicate repos collapse to the first. Empty/absent by default (zero-config principle).
- **`src/daemon/watched-releases.ts`** — `runWatchedReleasesOnce()` polls each repo via the existing `fetchReleases()` client, filters drafts (and pre-releases unless opted in), picks the newest release in the same version family as `current` via `findLatestInFamily()`, and emails when it's newer. Reuses `getAdviseSummary()` (with a `repo` override) for the upstream release-note LLM summary, and the existing notify + outbox layers (archive `kind: "watched-release"`). `startWatchedReleasesScheduler()` mirrors the deep-prune/digest schedulers (first run after a startup delay, then every `watch_interval`).
- **`watched_releases` state table (`src/state/db.ts`).** Tracks `current` / `latest_seen` / `notified_tag` / `notified_at` / `checked_at` / `advise_text` per repo. `notified_tag` dedups so each newer release fires exactly one email until the operator updates `current` or a newer release lands. Helpers: `getWatchedReleaseState`, `recordWatchedCheck`, `recordWatchedNotified`. Created via `CREATE TABLE IF NOT EXISTS` — no migration needed.
- **`watch_interval` config / `BUMPSIGHT_WATCH_INTERVAL` env.** Poll cadence (same duration syntax as `interval`); defaults to the scan interval. Wired through `--once` (single poll then exit) and the long-running daemon (scheduler + clean shutdown). New startup-log field `watched_releases=N repo(s) every <interval>` / `off`.

### Notes

- **Dedup contract matches the image path.** A row is only marked notified once the message actually delivered, so a transient SMTP failure leaves it eligible to re-fire next poll (same as `setNotified`). With no notifiers configured, delivery is a successful no-op and the row advances.
- **Why notify-only.** Bumpsight holds the docker socket and rewrites compose files; it has no mechanism to install a host/container binary, and `patch/minor/major` auto-apply axes would be meaningless. The email's job is to surface the gap and point at the manual fix.
- **Releases are slow + cheap to poll.** One GitHub API call per repo per `watch_interval`. A `GITHUB_TOKEN` (already forwarded by the daemon) lifts the anonymous 60/h limit to 5,000/h.

## 0.5.6 — 2026-06-07

Failed applies are now non-destructive. Fixes a latent compose-drift bug: a single-service auto-apply whose `docker compose pull`/`up -d` step failed left the compose file rewritten to the new tag even though that image was never pulled. The stack kept running the old image, so the drift was invisible — until the next recreate/reboot, which then failed with `No such image`. (A failed apply against a bad/nonexistent target tag would poison *every* future recreate.) Surfaced when a homelab reboot tried to recreate stacks whose composes had been left pinned to never-pulled tags by earlier failed applies (onlyoffice 9.4.0.1; the original n8n 2.19.0 incident was the first sighting).

### Fixed

- **`src/apply/index.ts` — roll the compose back on any docker failure, not just bundled applies.** The pre-apply compose snapshot is now taken for every non-moving apply (previously only when paired-dep bundling was active), and `restoreSnapshot()` runs whenever `pullAndUp` fails (previously only when `plan.rewrites.length > 0`). A failed apply now always leaves the compose on its last-known-good, pulled, running tag; the row is still marked `failed` and the completion notification still fires, and re-triggering re-applies cleanly. Moving-tag applies are unaffected (they never rewrite). Regression test added in `test/apply.test.ts` asserting the compose is restored to the original tag after a failed docker step.

## 0.5.5 — 2026-05-12

Digest-bump enrichment via OCI labels. Digest-class bumps (moving tags like `:latest` where bumpsight can't resolve the change to a semver pair) used to land in the daily digest as bare `digest sha256:abc… → sha256:def…` lines with no context. v0.5.5 decodes that pair into a real upstream commit range and produces an LLM summary of what changed.

### Added

- **`src/registry/oci-config.ts`** — two-hop registry walker that fetches the OCI image config blob for a given `(image, digest)` and extracts its labels. Supports docker.io and ghcr.io, follows manifest lists / image indices to the linux/amd64 manifest (with linux/arm64 + first-non-attestation fallbacks), and never throws. Returns `{ labels: {} }` on any failure path so callers can fall through cleanly.
- **`extractRevision()` / `extractSourceUrl()` / `parseGithubUrl()` helpers.** Canonical OCI labels (`org.opencontainers.image.revision`, `org.opencontainers.image.source`) take precedence, with the older `org.label-schema.vcs-ref` / `org.label-schema.vcs-url` accepted as fallbacks for older images. `parseGithubUrl` tolerates `git+https://` schemes, `.git` suffixes, and `www.github.com`.
- **`src/releases/github.ts` — `fetchCommitsBetween(coords, base, head)`** hits the GitHub Compare API (`/repos/{owner}/{repo}/compare/{base}...{head}`), returning a normalized `CompareResult` with `commits`, `totalCommits`, `htmlUrl`, and a `truncated` flag (GitHub caps responses at 250 commits). `base === head` short-circuits to an empty list without calling the API.
- **`src/advise/digest-enrichment.ts`** — `enrichDigestBump({ image, prevDigest, newDigest, llmUrl?, ... })` orchestrates the full pipeline: parallel label fetch for both digests → extract revision SHAs and source URL → parse the github.com repo → call the compare API → cap commit list at 30 → feed commit subjects to the LLM → render a summary block with `Digest range: abc…def on github.com/owner/repo (N commits)`, the compare URL, and either the LLM summary or the raw commit-subject list when LLM is unavailable. Never throws.
- **Daemon hook in `scanRunOnce`.** When `bump === "digest"` (semver resolution unavailable) and an LLM URL is configured, the daemon enriches the row inline and persists the rendered summary into `advise_text` via the existing column. The daily-digest renderer picks it up automatically — no changes needed in the digest email path. Hooked through a new `enrichDigestFn` test seam on `ScanRunDeps` / `StartDaemonDeps`.

### Changed

- **Daily-digest "suppressed digests" section.** Rows that previously rendered with only the `sha256:X…` delta now show an LLM-decoded "what changed" summary when OCI labels are present upstream. When labels are absent (older images, images built without `--label`), the row renders exactly as before — graceful fallback, no config needed.

### Notes

- **Includes the unreleased post-v0.5.4 commit `ad58a1e`** that integrates the inline `bumpsight` SVG mark into the held-bump and applied-result email HTML, the queue page header, and the daily-digest email header. (No image attachment / no CID — inline `<svg>` so every mail client renders it without dragging an additional MIME part.)
- **Falls back gracefully on every axis.** Missing labels, non-GitHub source, GitHub API errors, LLM unreachable — each failure mode produces either an empty `advise_text` (treated identically to today's behavior) or a structured commit-subject list without an LLM summary. The hold flow never aborts.
- **No new config.** Enrichment fires whenever the existing `llmUrl` / `BUMPSIGHT_LLM_URL` is set, which is also the prerequisite for the current advise pipeline. Operators without an LLM see the v0.5.4 behavior unchanged.
- **Registry calls.** Each digest-class bump that triggers enrichment performs up to four registry HTTP calls (token + manifest + arch-manifest + config-blob, per side). Docker Hub anon rate limits (100/6h) are well above this — a homelab with a few dozen `:latest`-pinned services bumps rarely enough that the budget isn't a concern.
- **GitHub compare API.** Anonymous compare works (60 req/h) but a `GITHUB_TOKEN` lifts the limit to 5,000/h. The existing daemon plumbing already forwards the token from compose env.
- **Why not enrich at email render time?** Persisting the summary at scan time means the daily-digest path stays simple (read `advise_text`, render), and means a single LLM/GitHub call per digest change instead of one per digest email.

## 0.5.4 — 2026-05-10

Apply-time bundling of paired dep changes. Extends the v0.5.0 paired-dep lookup from report-only to an atomic multi-image rewrite that fires when an operator clicks Approve on an app-major bump. Opt-in per stack — defaults stay off so existing deployments are unaffected.

### Added

- **`apply_paired_deps` config + `BUMPSIGHT_APPLY_PAIRED_DEPS` env var.** Accepts either a bare boolean (apply to all stacks) or the `{ default, stacks }` object for per-stack control. Off when unset — bundling never auto-runs without explicit opt-in.

  ```yaml
  apply_paired_deps:
    default: false
    stacks:
      outline: true        # bundle paired deps for outline only
  ```

- **`paired_deps_json` column on `updates`.** The v0.5.0 paired-dep lookup already captures structured recommendations at hold time; v0.5.4 now persists them on the row alongside `advise_text` so apply-time has the same data the operator saw in the email when they clicked Approve. Idempotent migration in `openDb()` for existing DBs.
- **`src/apply/paired-deps-plan.ts`** — `buildBundlePlan(composePath, recommendations)` reads the live compose, drift-checks each `kind: "bump"` recommendation against the originally-observed pin, and returns `{ rewrites, skipped }`. `add` (new dep) and `image-change` (e.g. `redis` → `valkey`) are always routed to `skipped` so they stay in the operator's hands. `formatBundleLog(plan)` renders the summary line that lands in `apply_log` and the applied-email log section.

### Changed

- **`applyOne` is now atomic across the primary + bundled deps.** A pre-apply snapshot of the compose file is captured before any rewrites; if any paired-dep rewrite fails its drift check, or the subsequent `docker compose pull`/`up -d` exits non-zero, the snapshot is restored and the row is marked failed. Half-rewritten compose files no longer ride into the next apply.
- **`pullAndUp` accepts `serviceName: string | string[]`.** Bundled applies pass `[primary, ...deps]` so a single pull and single `up -d` cover the whole bundle. Backwards compatible — single-string callers still work identically.
- **Daemon hold-notify writes `paired_deps_json` alongside `advise_text`.** Only when the v0.5.0 lookup returned recommendations; rows without paired deps stay null.
- **Startup banner reports bundling state.** `bundle_paired_deps=off` / `on (all stacks)` / `default=off on=outline` so the operator can verify their config without `--once`.

### Notes

- Drift between hold time and apply time is handled non-destructively: a drifted paired-dep entry is logged as `paired-dep skipped: <service> — local tag drifted since hold` and left alone. The primary apply still proceeds. This way a manual dep bump between approval and click doesn't turn a routine apply into a failure.
- `kind: "bump"` is the only category that bundles automatically. The decision is deliberate: `add` and `image-change` change the shape of the stack (new service, swapped runtime), and the upstream's recommended pin alone isn't enough to verify volumes/configs/networks will roundtrip. Those still show up in the email, just not in the automatic rewrite.
- Bundling is intentionally skipped on moving-tag applies (`row.family?.startsWith("moving:")`) — those don't touch the compose pin to begin with, so there's no bundling to do.
- Bundling reads the snapshot captured at hold time; if you'd rather apply against a fresh upstream pin, deny the existing row and let the next scan re-discover.

## 0.5.3 — 2026-05-10

Apply-email polish. Two small fixes that compound: shrink the captured apply log at the source, then hide what's left behind a spoiler so a clean log doesn't dominate the email.

### Changed

- **Pass `--quiet` to `docker compose pull` during apply.** Without a TTY, compose's plain progress mode emits every per-layer redraw as a separate newline (e.g. `xxxxxxxxxxxx Downloading [=>  ] 96.53MB/3.862GB` repeated for every status update). On a multi-GB image that ballooned the captured `apply_log` past 100KB and the resulting hold/applied email past 250KB. With `--quiet`, stdout is empty on success and errors still surface on stderr — apply logs on a successful pull are now near-empty (typically just the final `Container X Recreated` line from the `up` step).
- **Apply log section is now collapsed by default in HTML emails.** Both per-event mails (`buildAppliedHtml` in `src/daemon/index.ts`) and the daily digest (`renderRow` in `src/notify/digest.ts`) wrap the apply log `<pre>` in a `<details>` element. The `<summary>` advertises line count and size so the operator can decide at a glance whether it's worth opening (e.g. `Apply log (1348 lines · 124.6 KB)`). Plain-text bodies are unchanged — the `───── apply log ─────` divider stays.

### Notes

- The `--quiet` change only affects apply-time pulls; tag discovery still uses the registry HTTP API (no shell-out, no progress lines to silence).
- `<details>` is supported by Gmail web, Apple Mail, Thunderbird, iOS/Android Mail. Outlook desktop renders `<details>` as flat content (no collapse) — graceful degradation, not a regression.
- The combination cuts a typical large applied-email from ~265KB to ~5KB and leaves operators with one-glance triage instead of a wall of progress bars.

## 0.5.2 — 2026-05-08

Opt-in scheduled deep prune. Complements the v0.4.2 post-apply targeted prune, which only removes the just-replaced image tag and never touches dangling layers from cancelled builds, orphaned anonymous volumes, or the buildx cache. Over months of homelab churn those accumulate (52.6 GB reclaimed manually after a few months on Joe's setup); this gives operators a no-config-required cron without standing up a separate prune cron.

### Added

- **`BUMPSIGHT_PRUNE_SCHEDULE` env / `prune_schedule:` config field.** When set to a duration like `7d`, the daemon runs three docker prune commands on that interval and logs total reclaimed bytes:
  1. `docker image prune --filter until=168h -af` — dangling images plus tagged images older than a week with no container reference.
  2. `docker volume prune -f` — anonymous volumes not in use.
  3. `docker builder prune -af` — buildx cache.

  Off by default per the "ships to other people's homelabs, defaults must work zero-config" principle. Per-step failures don't abort the next step; transient docker hiccups don't permanently stop the schedule. First run starts 30s after daemon startup so the startup log gets to flush first.

- **`src/apply/deep-prune.ts`** — `runDeepPrune({ runner?, imageAgeFilter?, skipVolumes?, skipBuilder? })`. Returns `{ steps, totalReclaimedBytes, summary }`. Reusable from CLI / tests.
- **`src/daemon/deep-prune.ts`** — `startDeepPruneScheduler({ intervalMs, log, runner?, ... })`. Returns `{ stop(), runOnce() }`, mirroring the existing digest-scheduler shape.
- **`parseReclaimed(output)`** — handles both `Total reclaimed space: 1.23GB` (image/volume) and `Total: 1.23GB` (buildx) formats. Returns 0 on unrecognized output.

### Notes

- The startup banner now reports `prune=every <interval>` or `prune=off` alongside the existing scan/digest fields.
- Volumes and the builder cache can be individually skipped via `skipVolumes` / `skipBuilder` on the function — exposed for future per-stack overrides; no env knob yet.
- A "skip if pool free space > N%" guard was discussed in roadmap notes but deferred — `docker image prune` is essentially free when there's nothing to remove, so the guard's main benefit (saving CPU on idle hosts) wasn't worth the cross-platform complexity for this release.

## 0.5.1 — 2026-05-07

Same-day correction to the v0.5.0 default. v0.5.0 set the hard fallback to `{ app: "major", dependencies: "none" }` — Watchtower-like, auto-everything-including-major. That was too aggressive: semver explicitly flags major bumps as potentially breaking, so they should land in front of a human review. v0.5.1 settles on `{ app: "minor", dependencies: "none" }` — auto-apply patches and minors (the bumps that come with a backwards-compat contract), hold majors for approval, stay silent on deps.

### Changed

- **Hard fallback policy: `{ app: "minor", dependencies: "none" }`** (was `{ app: "major", dependencies: "none" }` for the few hours v0.5.0 was the latest). Operators upgrading from v0.5.0 will see major-on-app bumps move from auto-applied back to held-for-approval. Operators upgrading from pre-v0.5.0 still see the same overall behavior shift v0.5.0 introduced (deps go silent by default; legacy single-axis configs map to `{ app: <value>, dependencies: "none" }`).
- **Object-form fallback for missing `app:` field** also follows the new default — a config like `default: { dependencies: notify }` now resolves to `{ app: minor, dependencies: notify }` (was `major`).

## 0.5.0 — 2026-05-07

Two related changes that change bumpsight's defaults toward the philosophy "deps follow the parent app's release cadence" — they're shipped together so the new policy and the new lookup feature reinforce each other.

### Changed (BREAKING DEFAULT)

- **New default policy: `{ app: "major", dependencies: "none" }`** (Watchtower-like for the primary service, silent for dep images). Pre-v0.5.0 the hard fallback was `{ app: "notify", dependencies: "notify" }`. The new shape codifies what the v0.4.0 LLM advice was already telling operators: dependency images (Postgres / Redis / MariaDB / Vault / etc.) shouldn't have an independent upgrade lane in bumpsight — they follow the parent app's release cadence, and bumping them ahead of the parent risks on-disk format breaks, schema mismatch, or silent corruption. To keep the old "ask about every bump" behavior, set `default: notify` (legacy single-axis form) or `default: { app: notify, dependencies: notify }` in your config.
- **Legacy single-axis configs** (e.g. `default: minor`) now map to `{ app: <value>, dependencies: "none" }` instead of `{ app: <value>, dependencies: "notify" }`. Same philosophy: silence deps unless explicitly opted in.
- **`BUMPSIGHT_AUTO_APPLY` env** now applies to the app axis only. Pre-v0.5.0 it set both axes; that contradicts the new "deps follow parent" stance. Operators who actually want both axes driven by env should use `BUMPSIGHT_AUTO_UPDATE_APP` and `BUMPSIGHT_AUTO_UPDATE_DEPENDENCIES`.

### Added

- **Paired dep-recommendation lookup.** When advising on a held app-major bump, bumpsight now fetches the upstream parent app's compose file at the new version's git tag, finds dep services in it, and diffs their pins against the local stack. Differences are surfaced in a "Paired dependency recommendations" block at the bottom of the advise body (and persisted in the structured `pairedDeps` field on `AdviseSummary`):
    - `bump`: same image family, different tag (e.g. `postgres:16` → `postgres:17`)
    - `image-change`: image swapped (e.g. `redis:7` → `valkey/valkey:8`)
    - `add`: a dep service appears in the upstream compose that isn't in the local one
    
  Triggered only on app-major holds where (a) the bump is on a non-dep image, (b) `coords` resolved to a GitHub repo, and (c) a local `composeFile` was supplied. Best-effort: any failure (network, missing compose, parse error) yields an empty result; the LLM advice still ships unchanged.

- **`src/registry/upstream-compose.ts`** — `fetchUpstreamCompose(coords, version)`. Tries common compose paths (`docker-compose.yml`, `compose.yaml`, `examples/docker-compose.yml`, etc.) at common ref formats (`v{version}`, `{version}`, `release-{version}`). Returns the first hit that mentions `services:` (sanity check against README placeholders).

- **`src/advise/paired-deps.ts`** — `findPairedDepBumps(coords, version, localComposePath)`. Service-name match wins over image-family match (operators often rename `postgresql` → `db` but keep the role). `formatPairedDepReport(result)` renders the block appended to advise text.

- **`parseComposeString(raw, where?)`** — exposed from `src/compose/parse.ts` so the paired-deps lookup can parse upstream compose YAML without touching the filesystem.

### Notes

- v0.4.0 already had `KNOWN_DEPENDENCY_IMAGES` (Postgres / MariaDB / Mongo / Redis / Valkey / Elastic / OpenSearch / RabbitMQ / Kafka / Vault / Consul / Qdrant / Weaviate / Chroma / Milvus / etc.). The list was previously load-bearing only for LLM-advise softening; v0.5.0 makes it load-bearing for both the policy gate (the `dependencies` axis applies when this returns true) and the paired-deps diff (only services matching this list are reported).
- Apply-time bundling of paired dep changes is intentionally NOT in this release. The v0.5.0 flow is report-only: surface the recommendation, the operator updates the compose file themselves before clicking Approve. Atomic multi-image rewrite during apply is a v0.5.1+ candidate.

## 0.4.4 — 2026-05-06

Image-only fix for v0.4.3. Same code, follow-up release pattern as v0.2.2.

### Fixed

- **Honor `$TZ` in the GHCR image.** The v0.4.3 daily-digest scheduler uses local wall-clock hour for its fire decision, but Alpine's bare image silently treats every `$TZ` as UTC because `tzdata` isn't bundled. v0.4.4 adds `tzdata` to the runtime layer so the configured TZ takes effect. Operators on UTC see no behavior change. Operators on a non-UTC TZ get their actual local 18:00 (or whatever they configured via `BUMPSIGHT_DIGEST_HOUR`) instead of UTC 18:00.

## 0.4.3 — 2026-05-06

The deferred-twice daily-digest finally lands. OCI revision-label enrichment + paired dep-recommendation lookup remain queued for v0.4.4 — kept this release scoped to one feature on purpose (same spirit as v0.4.1 / v0.4.2).

### Added

- **Daily-digest email.** Once per day at a configurable hour (`BUMPSIGHT_DIGEST_HOUR`, default `18`, local TZ; set to a negative value to disable), bumpsight emits a single rollup email summarising the day's activity:
    - Apply failures (auto OR approved)
    - Auto-applied successes
    - Approved & applied successes
    - Suppressed digest-class bumps (rolling-tag refs that v0.4.1 silenced from per-event email)

  HTML body uses `<details>`/`<summary>` per item — closed by default with stack/service + version delta + bump kind; expand to see the persisted LLM advice from when the row dispatched (or apply log on failures). Empty days are silent (no email sent). Plain-text fallback inlines the same data with no collapse for non-HTML clients.

- **`BUMPSIGHT_DIGEST_HOUR` env var** + matching `digest_hour:` config-file key. 0–23 fires once per local day at the first wake-up at-or-after that hour. Negative number disables the scheduler entirely.

- **`findUndigestedSuppressed(db, sinceMs)`**, **`getLastDigestSent(db)`** state helpers. The first surfaces digest-class notified rows (status=`notified`, bump=`digest`, no `digested_at`) for the daily roll-up; the second is `MAX(digested_at)` and powers the once-per-local-day fire decision.

- **`startDigestScheduler(deps)`** + standalone **`runDigestOnce(deps)`** in `src/daemon/digest.ts`. The scheduler wakes every 60s, asks `shouldFireDigest(now, lastSent, hour)`, and dispatches when the answer is yes. `runOnce()` is exposed on the runtime for tests / manual triggers.

- **Digest emails are archived to the outbox** alongside per-event mail, with `kind: "digest"` and the row ids that were rolled up. Same retention rules as the v0.4.1 outbox.

### Changed

- **Daemon startup log** now prints the digest schedule alongside everything else (`digest=18:00 local` / `digest=off`).
- **DB schema unchanged** from v0.4.2. The `digested_at` column has been there since v0.4.0; v0.4.3 is the release that finally writes to it.

### Notes

- A digest send only marks rows digested when at least one notifier delivers (or there are no notifiers configured). A notifier-failure run leaves rows un-digested for the next tick, mirroring v0.2.1's `setNotified` rule. Stops a transient SMTP throttle from silently burying a day's worth of activity.
- The `runDigestOnce` window defaults to 25 hours (small overlap so border-of-window rows always show up exactly once). Override via `windowMs` if you call it programmatically.
- LLM advice text in the digest is the persisted `advise_text` from the row's original notification — no fresh LLM calls. Means the digest is fast and shows you what was actually emailed when, not a re-roll of stochastic summaries.

## 0.4.2 — 2026-05-04

Four bug-fix-flavored items surfaced from operating-in-anger over the past 48 hours. The originally-planned features (daily-digest email, OCI revision-label enrichment, paired dep-recommendation lookup) are deferred to v0.4.3 to keep this release tight.

### Added

- **Built-in post-apply image prune.** After a successful version bump, bumpsight now removes the just-replaced image tag if no other container references it. Reports `freed N MB` in the apply log (and so in the apply-completion email). Always best-effort: a prune failure never marks the apply itself failed. Skipped for moving-tag bumps (the rolling tag still resolves the old digest implicitly via `:latest`). Disable with `pruneAfterApply: false` in `ApplyDeps` when calling programmatically. *Why this matters:* on Joe's homelab, version churn from 7 days of bumpsight-driven upgrades silently grew docker storage from ~68 GB to 145 GB because old image versions accumulated. A manual `docker image prune -a` reclaimed 49 GB. Going forward each apply self-cleans.
- **`BUMPSIGHT_LLM_TIMEOUT_MS` env var.** Configurable LLM request timeout (default 180s, was hard-coded 60s). Routers like LiteLLM walk fallback chains server-side when a primary provider rate-limits — cumulative latency can exceed 60s and the operator-facing observation is just a vanished request that aborted client-side. 180s gives the chain room to settle.
- **Automatic single retry on `AbortError` for advise calls.** Wrapped via a new opt-in `retryOnAbort: true` flag on `chat()`. Caller-controlled (only the daemon's advise path uses it). Catches the case where the first call timed out client-side but a second attempt likely lands on a different/faster provider in the chain.

### Changed

- **Default LLM timeout 60s → 180s.** See `BUMPSIGHT_LLM_TIMEOUT_MS` above for rationale. Override via env var or `chat()` opts when needed.
- **Digest-class bumps on rolling tags now correctly skip compose rewrite.** Previously, a digest bump on a `:latest`-tagged service that didn't have a resolvable semver pair would attempt to rewrite `latest` → `<12-char-digest-prefix>` in compose and fail with `image tag drift: expected <sha>, found latest`. v0.4.2 sets `family = "moving:<tag>"` whenever the source compose tag matches `isMovingTag()`, so the apply path correctly skips rewrite and just runs `pull` + `up -d`. *Why this matters:* row 69's qbittorrent-mercury gluetun digest update failed twice with this exact error before being bypassed manually. Now self-heals.

### Recommended (operator action — homelab compose update)

- **Use an aligned `/stacks` mount in the bumpsight compose.** Replace the previous suggestion of `-v /path/to/stacks:/stacks` with the aligned form `-v /path/to/stacks:/path/to/stacks`. The non-aligned form breaks `docker compose up` for any target stack that uses a `./`-relative bind mount (e.g. `./php-override.ini`) — when bumpsight invokes compose from inside its container, the docker daemon resolves the relative path inside bumpsight's container view, which doesn't exist on the host. Aligned mount means container path == host path and relative binds resolve correctly. *Why this matters:* invoice-ninja 5.13.20 → 5.13.21 apply hit `error while creating mount source path '/stacks/invoice-ninja/php-override.ini': mkdir /stacks: read-only file system`, leaving the app container down until manual recovery from a host-aligned shell. Set `stacks_dir` in `bumpsight.yaml` to the same path you mounted (or env `BUMPSIGHT_STACKS_DIR`).

### Notes

- DB schema is unchanged from v0.4.1. Safe to roll forward and back across the v0.4.x line.
- The `pruneOldImage` helper (`src/apply/prune.ts`) is exported for future use by a scheduled deep-prune feature (v0.4.3).
- Carved out of the original v0.4.2 plan to keep this release tight, in the same spirit as v0.4.1.

## 0.4.1 — 2026-05-02

Triggered by 7 days of operating-in-anger feedback. Closes the silent-failure loop, kills digest-bump email noise, captures what we send.

### Added

- **Apply-completion notifications.** When an operator clicks Approve in a held-bump email, the apply step runs in the background. Pre-v0.4.1 there was no follow-up email — a failed apply (e.g. tag-drift safety check) died silently and the operator was left assuming success from the browser confirmation page. v0.4.1 dispatches a per-event email after every approve+apply attempt, success or failure, with the apply log inline.
- **Email outbox archive.** Every dispatched email is also written to `BUMPSIGHT_OUTBOX_DIR` (default `/var/lib/bumpsight/outbox`) as a JSON file (`<ISO-timestamp>-<kind>-<row-id>.json`) containing subject + body + html + advise summary + delivery result. Bounded retention via `BUMPSIGHT_OUTBOX_KEEP` (default 200 most recent). Lets operators (and Claude) audit what actually went out without re-rendering or re-calling the LLM.
- **`advise_text` column on `updates`.** When a held-bump email dispatches with an LLM advise summary, the rendered text is now persisted to the row. Useful for debugging "why was the AI advice unhelpful in this email" — read straight off the row instead of hoping the LLM gives the same stochastic answer twice.

### Changed

- **Digest-class bumps no longer fire per-event emails.** Rolling-tag refs (`:latest`, `:nightly`, etc.) cycle constantly and have no semver delta to summarise — per-event ASK emails were noise. The bump is still recorded + marked notified so `/queue` shows it, but no email goes out for the individual event. Daily-digest aggregation (v0.4.2) will surface these as a roll-up.
- **Apply-completion email wording adapts** to whether the bump was auto-applied or human-approved+applied. Subject line stays the same; body banner reads `Auto-applied` vs `Approved & applied` so the email is unambiguous in either flow.

### Notes

- DB schema migration is additive (`advise_text` column). Safe to roll back to v0.4.0 — the column just sits unused.
- The cosmetic startup-log fix (`default=[object Object]` → readable `policy=app:.../deps:...`) was committed to main right after v0.4.0 shipped (`13bcc0b`); ships properly in v0.4.1.

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
