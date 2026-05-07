<img src="assets/logo.svg" width="80" height="80" alt="bumpsight">

# bumpsight

Docker image update advisor and applier for self-hosters. Periodically scans your `compose.yaml` files, classifies new tags as patch / minor / major, applies the safe ones automatically, and emails you the rest with one-click approve / deny links — accompanied by an LLM-summarised read of the upstream release notes.

[![npm](https://img.shields.io/npm/v/bumpsight.svg)](https://www.npmjs.com/package/bumpsight)
[![CI](https://github.com/miller-joe/bumpsight/actions/workflows/ci.yml/badge.svg)](https://github.com/miller-joe/bumpsight/actions/workflows/ci.yml)
[![GHCR image](https://img.shields.io/badge/ghcr.io-miller--joe%2Fbumpsight-2b3137?logo=github)](https://github.com/miller-joe/bumpsight/pkgs/container/bumpsight)
[![MIT license](https://img.shields.io/npm/l/bumpsight.svg)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)

Watchtower was archived 2025-12-17. Diun and What's Up Docker tell you a tag moved but can't tell you whether the bump is safe or apply it for you. bumpsight does both — and stays out of your way for the bumps you don't want it touching.

## What you get

- **Daemon mode** — one container, one config block, runs forever. Polls every `interval`. Auto-discovers every `compose.yaml` under `/stacks`.
- **Semver-aware policy on two axes.** Each stack has an `app` axis (the primary service) and a `dependencies` axis (Postgres / Redis / MariaDB / Vault / etc.). Each axis takes `patch` / `minor` / `major` / `notify` / `none`. Default since v0.5.1: `{ app: minor, dependencies: none }` — auto-apply patches + minors on the app (the bumps semver flags as backwards-compatible), hold majors for approval, silent on deps (they follow the parent app's release cadence, not their own). Set globally and override per stack.
- **One-click approve / deny.** Emails contain real URLs that, when clicked, pull and recreate the affected service via the host's Docker socket — or mark it denied and never bother you about that bump again.
- **LLM-assisted risk read** for held bumps via any OpenAI-compatible LLM endpoint — LiteLLM (cloud fan-out), Ollama (local), OpenAI, vLLM, anything else that speaks `/v1/chat/completions`.
- **SMTP and Apprise** notifiers built in. Apprise inherits its 70+ channels (Discord, ntfy, Slack, Gotify, …) without bumpsight having to embed them.
- **CLI commands** for the audit-style work: `doctor` (lint), `scan` (one-shot tag check), `advise` (LLM summary). Run from your terminal, no daemon needed.

## Quick start (Docker)

The drop-in:

```yaml
services:
  bumpsight:
    image: ghcr.io/miller-joe/bumpsight:latest
    container_name: bumpsight
    restart: unless-stopped
    ports:
      - "9100:9100"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # Aligned mount: container path == host path. Required so target
      # stacks with relative bind mounts (./config, ./data, …) resolve
      # correctly when bumpsight invokes `docker compose` against them.
      - /mnt/docker/stacks:/mnt/docker/stacks       # mount your compose tree
      - bumpsight-state:/var/lib/bumpsight          # SQLite state lives here
      - ./bumpsight.yaml:/config/bumpsight.yaml:ro  # optional, see below
    environment:
      BUMPSIGHT_NOTIFY: "smtp://user:pass@mail.example.com:587/?to=admin@example.com&from=bumpsight@example.com"
      BUMPSIGHT_PUBLIC_URL: "https://bump.example.com"
      # Default since v0.5.1: auto-apply patch+minor on the app axis, hold
      # majors for approval, silent on deps. Override per-stack in
      # bumpsight.yaml. To restore the pre-v0.5.0 "ask about everything"
      # behavior, set BUMPSIGHT_AUTO_UPDATE_APP: "notify".
      BUMPSIGHT_INTERVAL: "6h"
      # Any OpenAI-compatible LLM endpoint. See "LLM endpoint" below.
      BUMPSIGHT_LLM_URL: "http://litellm:4000/v1"
      BUMPSIGHT_LLM_KEY: "sk-..."
      BUMPSIGHT_MODEL: "smart"

volumes:
  bumpsight-state:
```

That's the whole product. Mount your compose tree at the same path inside the container as on the host (the *aligned-mount* convention since v0.4.2 — keeps relative bind mounts in target stacks resolvable when bumpsight runs `docker compose` against them) and bumpsight auto-discovers every `<stack>/compose.{yaml,yml}` underneath. Set `stacks_dir:` in `bumpsight.yaml` to the same path you mounted, or override via `BUMPSIGHT_STACKS_DIR`. Point `BUMPSIGHT_PUBLIC_URL` at however you expose port 9100 (reverse proxy, Tailscale, LAN-only) — that's the base URL bumpsight uses for the approve/deny links it embeds in your emails.

To opt a specific stack OUT of scanning, set its policy to `none` in `bumpsight.yaml` (see below). To restrict to a specific allowlist instead of auto-discovery, pass paths after `daemon` or set `compose_files:` in the config.

## Quick start (CLI only)

If you don't want a daemon — just point-in-time audits — use the npm package:

```bash
npx bumpsight doctor compose.yaml
npx bumpsight scan compose.yaml
npx bumpsight advise linuxserver/sonarr:4.0.14 --to 4.1.0
```

Requires Node 20+. The `advise` command needs an LLM endpoint configured (see below); everything else works offline.

## LLM endpoint

bumpsight talks to any OpenAI-compatible chat-completions endpoint. Three common setups:

### LiteLLM (recommended for self-hosters without a GPU)

[LiteLLM](https://github.com/BerriAI/litellm) proxies a single OpenAI-compatible interface in front of Cerebras / Groq / Mistral / Gemini / OpenRouter / Anthropic / OpenAI / etc. Most have free tiers generous enough for bumpsight's needs (a single 6h scan on ~50 stacks is a few thousand tokens at most). Once LiteLLM is up:

```yaml
environment:
  BUMPSIGHT_LLM_URL: "http://litellm:4000/v1"
  BUMPSIGHT_LLM_KEY: "sk-..."        # LiteLLM master key
  BUMPSIGHT_MODEL: "smart"           # or whichever LiteLLM alias you've set up
```

### Ollama (local, requires GPU)

[Ollama](https://ollama.com) speaks the OpenAI compat API natively at `/v1` since 0.1.40. No key needed.

```yaml
environment:
  BUMPSIGHT_LLM_URL: "http://ollama:11434/v1"
  BUMPSIGHT_MODEL: "qwen2.5:14b-instruct"
```

(Legacy `OLLAMA_HOST` is also accepted — bumpsight derives `<host>/v1` automatically.)

### OpenAI / direct provider

```yaml
environment:
  BUMPSIGHT_LLM_URL: "https://api.openai.com/v1"
  BUMPSIGHT_LLM_KEY: "sk-..."
  BUMPSIGHT_MODEL: "gpt-4o-mini"
```

Same shape works for any other provider that exposes `/v1/chat/completions` — vLLM, llama.cpp's server, OpenRouter direct, Together AI, Groq direct, etc. **`BUMPSIGHT_LLM_URL` unset = advise disabled** (held emails arrive without the LLM section). Everything else still works.

## Configuration

Three sources, in precedence order: CLI flags > environment variables > `/config/bumpsight.yaml`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BUMPSIGHT_NOTIFY` | (none) | Comma-separated list of notifier URIs. See "Notification channels" below. |
| `BUMPSIGHT_PUBLIC_URL` | (none) | Public-facing base URL of the daemon. Approve/deny links are only included in notifications when this is set. |
| `BUMPSIGHT_AUTO_APPLY` | (unset) | Legacy single-axis default — applies to the **app** axis only since v0.5.0 (pre-v0.5.0 it set both axes). Use `BUMPSIGHT_AUTO_UPDATE_APP` / `BUMPSIGHT_AUTO_UPDATE_DEPENDENCIES` for fine-grained control. |
| `BUMPSIGHT_AUTO_UPDATE_APP` | `minor` | Default app-axis policy: `patch` / `minor` / `major` / `notify` / `none`. v0.5.1 default auto-applies patches + minors and holds majors for approval. |
| `BUMPSIGHT_AUTO_UPDATE_DEPENDENCIES` | `none` | Default deps-axis policy. v0.5.0+ silences dep images by default; deps follow the parent app's cadence. Set to `notify` if you want bumpsight to surface dep tag changes. |
| `BUMPSIGHT_INTERVAL` | `6h` | Scan interval. `30s`, `10m`, `6h`, `1d`. |
| `BUMPSIGHT_STACKS_DIR` | `/stacks` | Root directory for auto-discovery (one level deep). |
| `BUMPSIGHT_CONFIG` | `/config/bumpsight.yaml` | Path to the YAML config file. |
| `BUMPSIGHT_DB` | `/var/lib/bumpsight/state.db` | SQLite state file. |
| `BUMPSIGHT_HTTP_PORT` | `9100` | Approve/deny server port. |
| `BUMPSIGHT_HTTP_HOST` | `0.0.0.0` | Bind interface. |
| `BUMPSIGHT_LLM_URL` | (none) | OpenAI-compatible LLM base URL ending in `/v1`. When unset, advise is skipped. |
| `BUMPSIGHT_LLM_KEY` | (none) | Bearer token for the LLM endpoint. Required for LiteLLM, OpenAI, etc.; ignored by Ollama. |
| `BUMPSIGHT_MODEL` | `llama3.2` | Model name. For Ollama: e.g. `qwen2.5:14b-instruct`. For LiteLLM: an alias like `smart`. |
| `BUMPSIGHT_LLM_TIMEOUT_MS` | `180000` | Per-call LLM request timeout (ms). Default 180s since v0.4.2. Routers like LiteLLM walk fallback chains server-side and can exceed shorter timeouts; bump higher for slow local Ollama on CPU, lower for stricter SLAs. |
| `OLLAMA_HOST` | (none) | Legacy Ollama base URL. Used as `<host>/v1` when `BUMPSIGHT_LLM_URL` is unset. |
| `GITHUB_TOKEN` | (none) | Optional. Lifts the GitHub-anonymous rate limit when fetching upstream release notes. |
| `BUMPSIGHT_DIGEST_HOUR` | `18` | Hour-of-day (0–23, local TZ) the daily-digest email fires. Set to a negative value (`-1`) to disable. Empty days produce no email. |
| `BUMPSIGHT_OUTBOX_DIR` | `/var/lib/bumpsight/outbox` | Where every dispatched notification is archived as JSON (per-event + daily-digest). |
| `BUMPSIGHT_OUTBOX_KEEP` | `200` | Most recent N outbox files retained; older ones unlinked on every write. |

### `/config/bumpsight.yaml`

Optional. Useful for per-stack overrides and committing your apply policy to git.

```yaml
# v0.5.0+ two-axis form. v0.5.1 default: { app: minor, dependencies: none } —
# auto-apply patch+minor on the primary service, hold majors for approval,
# silent on deps.
default:
  app: minor             # auto patch+minor on the app, hold majors for approval
  dependencies: none     # silent — deps follow the parent app's release cadence

stacks:
  stalwart:  { app: none, dependencies: none }    # never auto-bump
  authentik: { app: none, dependencies: none }    # only ever apply manually
  glance:    { app: major }                       # let dashboards float everything
  postgres:  { app: patch }                       # patches yes, minors hold

# Legacy single-axis form is still accepted (mapped to `{ app: <value>,
# dependencies: none }` since v0.5.0). To restore the pre-v0.5.0 "ask about
# every bump" behavior on both axes, use:
#
#   default: { app: notify, dependencies: notify }

interval: 6h
notify:
  - smtp://user:pass@mail.example.com:587/?to=admin@example.com&from=bumpsight@example.com
  - apprise://apprise.local:8000/notify/bumpsight   # extra channels via apprise-api

# stacks_dir: /stacks       # override the auto-discovery root if needed
# compose_files: []         # explicit allowlist; when set, bypasses auto-discovery
public_url: https://bump.example.com
```

The stack name is the **basename of the directory holding the compose file** — `/stacks/jellyfin/compose.yaml` → stack `jellyfin`.

By default bumpsight scans every `<stacks_dir>/<name>/compose.{yaml,yml}` it finds. To opt a stack out, set its policy to `none`. Hidden directories (starting with `.`) are skipped automatically — that gives you a quick archive convention.

## Notification channels

Two drivers ship in the box; you can mix and stack them.

### SMTP / SMTPS

```
smtp://user:password@mail.example.com:587/?to=admin@example.com&from=bumpsight@example.com
smtps://user:password@mail.example.com/?to=a@example.com&to=b@example.com&from=bumpsight@example.com
```

Multiple `?to=` recipients are allowed. HTML email with an action card at the top (Approve / Deny buttons), plain-text fallback included. Implicit TLS on `smtps://` (port 465 by default), STARTTLS via opportunistic upgrade on `smtp://` (port 587 by default).

### Apprise

```
apprise://apprise.example.com/notify/bumpsight
apprises://apprise.example.com/notify/bumpsight   # forces https
```

These point at an existing [apprise-api](https://github.com/caronc/apprise-api) instance — the URL is the endpoint apprise-api exposes. Once you've configured the underlying targets in apprise-api (Discord, ntfy, Slack, Gotify, Mattermost, …), bumpsight POSTs Markdown-formatted notifications to that endpoint and apprise fans them out. bumpsight does not embed apprise itself, so the bumpsight image stays slim.

### Stacking

```
BUMPSIGHT_NOTIFY: "smtp://...,apprise://apprise.local/notify/bumpsight"
```

Comma-separated. Failures in one channel never block delivery to the others.

## How apply works

When a scan finds a new tag in the same family, bumpsight:

1. **Classifies** the bump as `patch` / `minor` / `major` / `unknown` against the previous tag.
2. **Decides** based on the policy for that stack (or the default).
3. **Auto-apply path:** rewrites the compose file to swap only the tag (preserving comments, formatting, other services), then runs `docker compose -f <file> pull <service>` followed by `... up -d <service>` against the host's Docker socket. The combined log is stored in the SQLite state.
4. **Hold path:** sends an HTML email with the action card at top — instruction + styled Approve / Deny buttons — followed by metadata and the LLM release-note summary.
    - `https://your-bump-url/approve/<token>` — when clicked, marks the row approved and runs the same apply path as above.
    - `https://your-bump-url/deny/<token>` — marks the row denied. bumpsight will not re-prompt for this exact bump.
5. **Post-apply prune (v0.4.2+):** after a successful, non-moving-tag apply, bumpsight removes the *just-replaced* image tag if no other container references it. Reports `freed N MB` in the apply log + completion email. Always best-effort; a prune failure never marks the apply itself failed. Skipped for moving-tag bumps (`:latest` digest changes etc. — the rolling tag still resolves the old digest implicitly). This keeps disk usage from creeping up over time as bumpsight applies multiple version bumps in succession.

### Rolling-tag (`:latest`, `:nightly`, …) semantics

When the source compose entry uses a moving tag (`:latest`, `:stable`, `:edge`, `:nightly`, `:rolling`, etc.), bumpsight tracks updates by **digest** rather than tag string. The compose file is left untouched on apply — `docker compose pull` picks up the new digest and `up -d` recreates the container. v0.4.2 fixed a class of apply failures where digest-only bumps on rolling tags were trying (and failing) to rewrite a 12-char digest prefix into a compose entry that read `latest`.

`unknown` bumps (cross-family changes, channel rolls like `latest` → `stable`) are always held, regardless of policy. There's nothing meaningful to "auto-patch" there.

The `(stack, service, current_tag, target_tag)` tuple is unique in state — repeat scans don't re-spam notifications for already-seen bumps.

## CLI commands

The daemon owns the long-running flow. The CLI commands let you do the same checks ad-hoc.

### `bumpsight doctor <compose-file>`

Lints a `compose.yaml` for homelab anti-patterns. Exit code 1 on errors, 0 otherwise.

```
$ bumpsight doctor compose.yaml
compose.yaml:

  ERROR BS002 [jellyfin] service runs with privileged: true
  WARN  BS001 [radarr] image linuxserver/radarr uses implicit or explicit :latest tag
  WARN  BS008 [portainer] mounts the Docker socket
  INFO  BS004 [radarr] no healthcheck defined

summary: 1 error, 2 warn, 1 info
```

`--json` for machine-readable output.

### `bumpsight scan <compose-file>`

For each image, checks Docker Hub or `ghcr.io` for the highest tag in the same family.

```
$ bumpsight scan compose.yaml
compose.yaml: 4 service(s) with images

  jellyfin   linuxserver/jellyfin:10.10.7    → 10.11.0
  radarr     linuxserver/radarr:5.14.0.9383-ls250    up to date
  postgres   postgres:16    up to date
```

`--offline` skips the lookup. `--timeout <ms>` sets the per-image budget. `--json` for machine output.

### `bumpsight advise <image> --to <tag>`

Resolves the upstream GitHub repo for the image, fetches releases between the two tags (capped at the 25 most recent in range to keep prompts manageable), feeds them to your configured LLM endpoint, and prints a structured summary of breaking changes, new features, and required actions. Pass `--compose <file> --service <name>` and the LLM also gets your service config so it can call out env-vars or ports specific to your setup.

bumpsight ships a curated upstream-repo table for the common Docker Official images (node → nodejs/node, postgres → postgres/postgres, vault → hashicorp/vault, etc.) so the advise output isn't blank for them. For everything else it falls back to scanning the Docker Hub description for a GitHub link, or you can pass `--repo owner/name` explicitly.

### `bumpsight daemon`

The same loop the container runs, but you can run it bare-metal too — useful for cron-driven setups (`bumpsight daemon --once`) or systemd services.

## Lint rules

| ID | Severity | Rule |
|---|---|---|
| BS001 | warn  | Image uses implicit or explicit `:latest` tag |
| BS002 | error | Service runs with `privileged: true` |
| BS003 | warn  | Service uses `network_mode: host` |
| BS004 | info  | No healthcheck defined |
| BS005 | warn  | Environment variable looks like a secret with a literal value |
| BS006 | info  | No restart policy set |
| BS007 | info  | No memory limit configured (`mem_limit` or `deploy.resources.limits.memory`) |
| BS008 | warn  | Mounts the Docker socket |
| BS010 | warn  | `cap_add` contains a dangerous capability |

Rule IDs are stable across releases. Suppression via ignore-file is on the roadmap.

## Development

```bash
git clone https://github.com/miller-joe/bumpsight
cd bumpsight
npm install
npm run dev -- daemon /path/to/compose.yaml --once
npm test
```

Requires Node 20+.

To build the container image locally:

```bash
docker build -t bumpsight:dev .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v $PWD:/stacks bumpsight:dev daemon /stacks/some/compose.yaml --once
```

## Roadmap

Shipped:

- v0.1: `doctor` (lint), `scan` (registry tag freshness), `advise` (LLM-summarised breaking changes)
- v0.2: `daemon` mode — interval scheduler, semver-aware auto-apply policy, SQLite state, SMTP / Apprise notifiers, HTTP approve/deny server, automatic compose-file rewrite + `docker compose pull && up -d`, GHCR image (linux/amd64 + linux/arm64), HTML emails with action card at top, OpenAI-compatible LLM client (LiteLLM / Ollama / OpenAI / etc.), curated upstream-repo table for Docker Official images
- v0.3: `:latest`-digest tracking with semver-pair resolution (Phase 1+2), `/queue` HTTP route, `report` policy, LSIO tag format support, dependency-image-aware advise prompts, GHCR per-tag manifest support, LLM opinion-fallback when no upstream notes, multi-arch buildx via GHCR cache
- v0.4: split policy (`app` vs `dependencies` axes), apply-completion notifications + outbox archive + `advise_text` persistence (v0.4.1), advise reliability (180s default timeout, configurable `BUMPSIGHT_LLM_TIMEOUT_MS`, retry-on-AbortError), aligned-mount convention, rolling-tag apply path fix, post-apply targeted image prune (v0.4.2), daily-digest email rollup at configurable hour with `<details>`/`<summary>` per-row collapsibles (v0.4.3)
- v0.5: **BREAKING DEFAULT** — new policy fallback `{ app: minor, dependencies: none }` since v0.5.1 (auto patch+minor on the app, hold majors, silent deps; pre-v0.5.0 was `{ notify, notify }`). Paired dep-recommendation lookup — when advising on a held app-major bump, fetches the parent app's upstream compose at the new tag and surfaces dep-pin diffs in the advise email (`bump` / `image-change` / `add` recommendations).

Planned (v0.5.1+):

- Digest-bump enrichment via OCI labels — resolve `org.opencontainers.image.revision` to upstream git SHA, diff commits between previous + new SHAs, feed to LLM for a real "what changed in this digest move" summary
- Apply-time bundling of paired dep changes — let Approve on a major bundle the dep pin rewrites alongside the app rewrite, atomically
- Scheduled deep-prune (`BUMPSIGHT_PRUNE_SCHEDULE`) — opt-in, periodic `image prune --filter until=N` + `volume prune` + `builder prune`
- Rule ignore-file for `doctor`
- Podman and `nerdctl` socket support
- `quay.io` registry
- Multi-hop family walks (e.g. `4.0.14` → through `4.0.x` → `4.1.x` breakage map)

## License

MIT

## Support

If this saves you a broken homelab update at 3 AM:

[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)
