# bumpsight

Docker image update advisor for self-hosters. Lints your compose files, checks Docker Hub and GHCR for newer tags in the same version family, and summarizes the breaking changes in upstream release notes using a local LLM.

[![npm](https://img.shields.io/npm/v/bumpsight.svg)](https://www.npmjs.com/package/bumpsight)
[![CI](https://github.com/miller-joe/bumpsight/actions/workflows/ci.yml/badge.svg)](https://github.com/miller-joe/bumpsight/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/npm/l/bumpsight.svg)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)

Watchtower was archived on 2025-12-17. Diun and What's Up Docker notify you of new tags but can't tell you what actually changed or whether it will break your setup. bumpsight does.

## Install

```bash
npx bumpsight doctor ./compose.yaml
```

Or globally:

```bash
npm install -g bumpsight
bumpsight --help
```

Requires Node 20+. Ollama needs to be running locally for the `advise` command; everything else works offline.

## Commands

### `bumpsight doctor <compose-file>`

Lints a docker-compose file for homelab anti-patterns.

```
$ bumpsight doctor compose.yaml
compose.yaml:

  ERROR BS002 [jellyfin] service runs with privileged: true
         Privileged containers bypass most kernel security. Use cap_add for only the specific capabilities you need.
  WARN  BS001 [radarr] image linuxserver/radarr uses implicit or explicit :latest tag
         Pin to a specific version tag so reproducible deployments stay reproducible.
  WARN  BS008 [portainer] mounts the Docker socket
         Anything with socket access can control every container on the host. Use a socket proxy if the service only needs read access.
  INFO  BS004 [radarr] no healthcheck defined
  INFO  BS006 [radarr] no restart policy set

summary: 1 error, 2 warn, 2 info
```

Exit code is `1` if any errors were found, `0` otherwise. Pass `--json` for machine-readable output.

### `bumpsight scan <compose-file>`

For each image in the compose file, checks Docker Hub (or GHCR) for a newer tag in the same version family.

```
$ bumpsight scan compose.yaml
compose.yaml: 4 service(s) with images

  jellyfin              linuxserver/jellyfin:10.10.7    → 10.11.0
  radarr                linuxserver/radarr:5.14.0.9383-ls250    up to date
  postgres              postgres:16    up to date
  ombi                  linuxserver/ombi:4.42.0    up to date

```

Family matching is conservative on purpose. A service pinned to `16` won't be bumped to `16.2` (different part count = different family). A service on `16.2-alpine` won't be bumped to `16.3` (different variant). This is a feature, not a bug: it avoids surprise upgrades to incompatible tagging schemes. When nothing in the same family is newer, the row reads "up to date" — which just means "no safe bump," not "definitely the latest anywhere."

Flags:

- `--offline` skips the network lookup entirely. Useful for CI or scripted audits.
- `--timeout <ms>` sets the per-image timeout (default 8000).
- `--json` returns structured output.

Supported registries today: Docker Hub and `ghcr.io`. Other registries fall through with a `skipped` note.

### `bumpsight advise <image> --to <tag>`

Fetches GitHub releases between the current and target tag, feeds them to a local LLM through Ollama, and prints a structured summary of breaking changes, new features, and actions you should take. If you pass `--compose` and `--service`, the prompt also includes the user's service config so the LLM can call out removed env vars or ports specifically.

```
$ bumpsight advise linuxserver/sonarr:4.0.14 --to 4.1.0 --compose compose.yaml --service sonarr
linuxserver/sonarr  4.0.14 → 4.1.0
upstream: https://github.com/linuxserver/docker-sonarr (linuxserver)
releases in range: 3

Breaking changes:
- Removed BASE_URL env var (v4.1.0). You set BASE_URL in your compose.
- Default port changed from 8989 to 8585 (v4.0.17). Your compose maps 8989.

Notable new features:
- Native Whisparr integration (v4.1.0)
- Indexer health checks refactored (v4.0.15)
- v2 notification webhooks (v4.0.17)

Required actions:
- Remove the BASE_URL env var or migrate to the new `URL_BASE` key.
- Update port mapping in compose.yaml.
```

Image → upstream repo mapping heuristics, in order:

1. `--repo <owner>/<name>` explicit override.
2. `linuxserver/*` → `github.com/linuxserver/docker-*`.
3. `ghcr.io/<owner>/<name>` → `github.com/<owner>/<name>`.
4. Docker Hub metadata lookup (pattern-matches the first GitHub link in the image's description).

If all four fail, the command exits with an error asking for `--repo`.

Flags:

- `--from <tag>` — defaults to the tag in `<image>`. Set this when the compose file has the new tag already.
- `--repo <owner>/<name>` — override the upstream repo.
- `--compose <file> --service <name>` — include the service config in the prompt so the LLM can reference your specific env vars, ports, and mounts.
- `--ollama-host <url>` — default `http://127.0.0.1:11434` or `$OLLAMA_HOST`.
- `--model <name>` — default `llama3.2` or `$BUMPSIGHT_MODEL`. Any Ollama-compatible model works.
- `--github-token <token>` — optional, avoids GitHub API rate limits. `$GITHUB_TOKEN` is also read.
- `--json` — structured output with the release metadata.

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
| BS010 | warn  | `cap_add` contains a dangerous capability (`SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`, `ALL`) |

Rule IDs are stable across releases. Suppression via ignore-file is on the roadmap.

## Roadmap

Shipped in v0.1:

- `bumpsight doctor`: compose linter with 10 rules
- `bumpsight scan`: family-aware tag freshness against Docker Hub and GHCR
- `bumpsight advise`: GitHub releases → local Ollama LLM summary of breaking changes

Next:

- Long-running daemon mode that polls on a schedule and sends summaries to Slack / Discord / ntfy
- Rule ignore-file
- Podman and nerdctl sockets
- quay.io registry support
- Multi-hop family walks (e.g. `4.0.14` → through `4.0.x` → `4.1.x` breakage map)
- OpenAI / Anthropic provider for users who don't run Ollama

## Development

```bash
git clone https://github.com/miller-joe/bumpsight
cd bumpsight
npm install
npm run dev -- doctor ./some/compose.yaml
npm test
```

Requires Node 20+.

## License

MIT

## Support

If this saves you a broken homelab update:

[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)
