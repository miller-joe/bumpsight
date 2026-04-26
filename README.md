# bumpsight

Docker image update advisor and applier for self-hosters. Periodically scans your `compose.yaml` files, classifies new tags as patch / minor / major, applies the safe ones automatically, and emails you the rest with one-click approve / deny links — with optional LLM-summarised release notes.

[![npm](https://img.shields.io/npm/v/bumpsight.svg)](https://www.npmjs.com/package/bumpsight)
[![CI](https://github.com/miller-joe/bumpsight/actions/workflows/ci.yml/badge.svg)](https://github.com/miller-joe/bumpsight/actions/workflows/ci.yml)
[![GHCR image](https://img.shields.io/badge/ghcr.io-miller--joe%2Fbumpsight-2b3137?logo=github)](https://github.com/miller-joe/bumpsight/pkgs/container/bumpsight)
[![MIT license](https://img.shields.io/npm/l/bumpsight.svg)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)

Watchtower was archived 2025-12-17. Diun and What's Up Docker tell you a tag moved but can't tell you whether the bump is safe or apply it for you. bumpsight does both — and stays out of your way for the bumps you don't want it touching.

## What you get

- **Daemon mode** — one container, one config block, runs forever. Polls every `interval`.
- **Semver-aware policy.** `patch` auto-applies patches only. `minor` adds minors. `major` opens the floodgates. `notify` always asks. `none` ignores. Set globally and override per stack.
- **One-click approve / deny.** Emails contain real URLs that, when clicked, pull and recreate the affected service via the host's Docker socket — or mark it denied and never bother you about that bump again.
- **LLM-assisted risk read** for held bumps, via a local Ollama model (`advise`).
- **SMTP and Apprise** notifiers built in. Apprise inherits its 70+ channels (Discord, ntfy, Slack, Gotify, …) without bumpsight having to embed them.
- **CLI commands** for the audit-style work too: `doctor` (lint), `scan` (one-shot tag check), `advise` (LLM summary). Run from your terminal, no daemon needed.

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
      - /mnt/docker/stacks:/stacks                  # mount your compose tree
      - bumpsight-state:/var/lib/bumpsight          # SQLite state lives here
      - ./bumpsight.yaml:/config/bumpsight.yaml:ro  # optional, see below
    environment:
      BUMPSIGHT_NOTIFY: "smtp://user:pass@mail.example.com:587/?to=admin@example.com&from=bumpsight@example.com"
      BUMPSIGHT_PUBLIC_URL: "https://bump.example.com"
      BUMPSIGHT_AUTO_APPLY: "patch"
      BUMPSIGHT_INTERVAL: "6h"

volumes:
  bumpsight-state:
```

That's the whole product. Point `BUMPSIGHT_PUBLIC_URL` at however you expose port 9100 (reverse proxy, Tailscale, LAN-only) — that's the base URL bumpsight uses for the approve/deny links it embeds in your emails.

To watch only specific compose files (instead of crawling the whole tree), pass them after `daemon`:

```yaml
    command: ["daemon", "/stacks/jellyfin/compose.yaml", "/stacks/postgres/compose.yaml"]
```

Or list them in `bumpsight.yaml` (see below).

## Quick start (CLI only)

If you don't want a daemon — just point-in-time audits — use the npm package:

```bash
npx bumpsight doctor compose.yaml
npx bumpsight scan compose.yaml
npx bumpsight advise linuxserver/sonarr:4.0.14 --to 4.1.0
```

Requires Node 20+. Ollama running locally is needed for `advise`; everything else works offline.

## Configuration

bumpsight reads three sources, in order of precedence: CLI flags > environment variables > `/config/bumpsight.yaml`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BUMPSIGHT_NOTIFY` | (none) | Comma-separated list of notifier URIs. See "Notification channels" below. |
| `BUMPSIGHT_PUBLIC_URL` | (none) | Public-facing base URL of the daemon. Approve/deny links are only included in notifications when this is set. |
| `BUMPSIGHT_AUTO_APPLY` | `notify` | Default policy: `patch` / `minor` / `major` / `notify` / `none`. |
| `BUMPSIGHT_INTERVAL` | `6h` | Scan interval. `30s`, `10m`, `6h`, `1d`. |
| `BUMPSIGHT_CONFIG` | `/config/bumpsight.yaml` | Path to the YAML config file. |
| `BUMPSIGHT_DB` | `/var/lib/bumpsight/state.db` | SQLite state file. |
| `BUMPSIGHT_HTTP_PORT` | `9100` | Approve/deny server port. |
| `BUMPSIGHT_HTTP_HOST` | `0.0.0.0` | Bind interface. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama base URL for `advise`. |
| `BUMPSIGHT_MODEL` | `llama3.2` | Ollama model. |

### `/config/bumpsight.yaml`

Optional. Useful for per-stack overrides and committing your apply policy to git.

```yaml
default: notify          # patch | minor | major | notify | none

stacks:
  stalwart:    notify    # mail server: never auto-bump
  authentik:   none      # only ever apply manually
  glance:      minor     # let dashboards float minors too
  postgres:    patch     # patches yes, minors hold

interval: 6h
notify:
  - smtp://user:pass@mail.example.com:587/?to=admin@example.com&from=bumpsight@example.com
  - apprise://apprise.local:8000/notify/bumpsight   # extra channels via apprise-api

compose_files:
  - /stacks/jellyfin/compose.yaml
  - /stacks/postgres/compose.yaml

public_url: https://bump.example.com
```

The stack name is the **basename of the directory holding the compose file** — `/stacks/jellyfin/compose.yaml` → stack `jellyfin`.

## Notification channels

The notifier list is one of bumpsight's two interfaces with the outside world (the other is the approve/deny HTTP server). Two drivers ship in the box; you can mix and stack them.

### SMTP / SMTPS

```
smtp://user:password@mail.example.com:587/?to=admin@example.com&from=bumpsight@example.com
smtps://user:password@mail.example.com/?to=a@example.com&to=b@example.com&from=bumpsight@example.com
```

Multiple `?to=` recipients are allowed. Plain-text body. Implicit TLS on `smtps://` (port 465 by default), STARTTLS via opportunistic upgrade on `smtp://` (port 587 by default).

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
4. **Hold path:** sends the email/Apprise notification with two URLs:
    - `https://your-bump-url/approve/<token>` — when clicked, marks the row approved and runs the same apply path as above.
    - `https://your-bump-url/deny/<token>` — marks the row denied. bumpsight will not re-prompt for this exact bump.

`unknown` bumps (cross-family changes, non-numeric tags, channel rolls like `latest` → `stable`) are always held, regardless of policy. There's nothing meaningful to "auto-patch" there.

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

Fetches GitHub releases between two tags, feeds them to Ollama, and prints a structured summary of breaking changes, new features, and required actions. Pass `--compose <file> --service <name>` and the LLM also gets your service config so it can call out env-vars or ports specific to your setup.

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

- v0.1: `doctor` (lint), `scan` (registry tag freshness), `advise` (LLM-summarised breaking changes via Ollama)
- v0.2: `daemon` mode — interval scheduler, semver-aware auto-apply policy, SQLite state, SMTP / Apprise notifiers, HTTP approve/deny server, automatic compose-file rewrite + `docker compose pull && up -d`, GHCR image (linux/amd64 + linux/arm64)

Planned:

- Weekly digest report (applied / pending / failed) via the same notifier list
- `advise` integration in held notifications — embed the LLM risk summary directly in the approval email
- Rule ignore-file for `doctor`
- Podman and `nerdctl` socket support
- `quay.io` registry
- Multi-hop family walks (e.g. `4.0.14` → through `4.0.x` → `4.1.x` breakage map)
- OpenAI / Anthropic provider for users who don't run Ollama

## License

MIT

## Support

If this saves you a broken homelab update at 3 AM:

[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)
