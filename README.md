# bumpsight

Docker image update advisor for self-hosters. Lints your compose files today; in a follow-up release, it will fetch upstream release notes and summarize the breaking changes between your current image tags and whatever's new, using a local LLM.

[![MIT license](https://img.shields.io/npm/l/bumpsight.svg)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)

## Status

**v0.0.1** ships `bumpsight doctor` (compose linter, 10 rules) and `bumpsight scan` (list images in a compose file). The update advisor (`bumpsight advise`) and the live tag-freshness check inside `scan` are on the roadmap, landing with v0.1.

Watchtower was archived on 2025-12-17. This tool exists because Diun and What's Up Docker notify you of new tags but can't tell you what actually changed or whether it will break your setup.

## Install

```bash
npx bumpsight doctor ./compose.yaml
```

Or globally:

```bash
npm install -g bumpsight
bumpsight doctor ./compose.yaml
```

Requires Node 20+.

## Usage

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
         Anything with socket access can control every container on the host. Use a socket proxy (tecnativa/docker-socket-proxy) if the service only needs read access.
  INFO  BS004 [radarr] no healthcheck defined
         A healthcheck lets orchestrators detect hung processes. Even a simple curl or nc command helps.
  INFO  BS006 [radarr] no restart policy set
         restart: unless-stopped is a sensible default for long-running homelab services.

summary: 1 error, 2 warn, 2 info
```

Exit code is `1` if any errors were found, `0` otherwise. Pass `--json` for machine-readable output.

### `bumpsight scan <compose-file>`

Lists the images referenced by a compose file. In v0.0.1 this is just a structured view of your stack; the remote tag-freshness check against Docker Hub and GHCR lands in the next release.

```
$ bumpsight scan compose.yaml
compose.yaml: 4 service(s) with images

  jellyfin              linuxserver/jellyfin:10.8.11
  radarr                linuxserver/radarr
  prowlarr              linuxserver/prowlarr:1.18
  ombi                  linuxserver/ombi:4.42.0

(remote tag-freshness lookup is on the roadmap, see README)
```

### `bumpsight advise <image>` (not yet shipped)

Summarizes breaking changes between two image tags using a local LLM (Ollama by default). Fetches the upstream release notes, diffs them, and flags anything that looks like it would break your current config. Landing in v0.1.

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

Rule IDs are stable. If you want to suppress a rule in a specific compose file, pipe through `--json` and filter yourself for now; a proper ignore-file lands with v0.1.

## Roadmap

Shipped in v0.0.1:

- `bumpsight doctor`: 10-rule compose linter with text and JSON output
- `bumpsight scan`: list images referenced by a compose file

Next release (v0.1):

- Remote tag-freshness lookup inside `scan` (Docker Hub, GHCR, quay.io)
- `bumpsight advise`: fetches upstream release notes, summarizes breaking changes via Ollama
- Long-running daemon mode that polls on a schedule and notifies via webhook
- Rule ignore-file

Later:

- Support for Podman and nerdctl sockets
- Watchtower-compatible `--label-enable` config
- Slack / Discord / ntfy webhook output

## Development

```bash
git clone https://github.com/miller-joe/bumpsight
cd bumpsight
npm install
npm run dev -- doctor ./fixtures/compose.yaml
npm test
```

Requires Node 20+.

## License

MIT

## Support

If this saves you a broken homelab update, consider funding the rest of the roadmap:

[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)
