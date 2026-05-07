import { parseTag } from "../util/semver.js";

export type BumpKind = "patch" | "minor" | "major" | "digest" | "unknown";

/**
 * Tags that don't carry a version in their name and instead "move" — i.e.
 * the digest under the tag changes over time without the tag string changing.
 * These get tracked by digest comparison instead of tag-name comparison.
 */
const MOVING_TAGS = new Set([
  "latest",
  "stable",
  "edge",
  "main",
  "master",
  "rolling",
  "current",
  "nightly",
  "dev",
  "develop",
]);

export function isMovingTag(tag: string): boolean {
  return MOVING_TAGS.has(tag.toLowerCase());
}

/**
 * Image references that are typically a dependency layer of another app
 * (databases, caches, brokers, secret stores). When a parent app's compose
 * pins one of these to a specific version, that pin reflects what the
 * parent app has tested against — independent major upgrades risk on-disk
 * format breaks, schema mismatch, or silent corruption.
 *
 * Bumpsight uses this list to soften the advise output for major bumps:
 * surface the bump for awareness, but recommend "wait for the parent app
 * to bump it" instead of "here's what to check before upgrading."
 *
 * Match is on the canonical Docker Hub `namespace/name` form (or just
 * `name` for `library/<name>` images). Forks and unofficial mirrors
 * aren't covered — that's intentional, the canonical names cover ~95%
 * of homelab-stack DB sidecars.
 */
const KNOWN_DEPENDENCY_IMAGES = new Set<string>([
  // Postgres family
  "postgres", "library/postgres",
  "pgvector/pgvector",
  "tensorchord/pgvecto-rs",
  "ankane/pgvector",
  "supabase/postgres",
  // MariaDB / MySQL
  "mariadb", "library/mariadb",
  "mysql", "library/mysql",
  "percona", "library/percona",
  // Mongo
  "mongo", "library/mongo",
  "mongodb/mongodb-community-server",
  // KV / cache
  "redis", "library/redis",
  "valkey/valkey",
  "memcached", "library/memcached",
  "eqalpha/keydb",
  // Search
  "elasticsearch", "library/elasticsearch",
  "opensearchproject/opensearch",
  // Brokers
  "rabbitmq", "library/rabbitmq",
  "apache/kafka",
  "confluentinc/cp-kafka",
  "nats", "library/nats",
  // Vector DBs
  "qdrant/qdrant",
  "weaviate/weaviate",
  "chromadb/chroma",
  "milvusdb/milvus",
  // Other infra
  "clickhouse/clickhouse-server",
  "couchdb", "library/couchdb",
  "influxdb", "library/influxdb",
  "getmeili/meilisearch",
  // Secret stores
  "hashicorp/vault",
  "hashicorp/consul",
  // Coordination
  "zookeeper", "library/zookeeper",
]);

/**
 * Return true if the image ref is a well-known dependency layer (DB, cache,
 * broker, secret store, vector DB, etc.). Pass the full image ref like
 * `library/postgres` or `valkey/valkey`. Implicit `library/` is stripped
 * before lookup so callers can pass the bare repo name too (`postgres`).
 */
export function isDependencyImage(repoRef: string): boolean {
  const normalized = repoRef.toLowerCase();
  // Strip a registry host if present (`docker.io/library/postgres`,
  // `ghcr.io/foo/bar` — we only check namespace/name).
  const noRegistry = normalized.replace(/^[a-z0-9.-]+\.[a-z]+\//, "");
  return (
    KNOWN_DEPENDENCY_IMAGES.has(noRegistry) ||
    KNOWN_DEPENDENCY_IMAGES.has(`library/${noRegistry}`)
  );
}

/**
 * Classify a tag bump into patch / minor / major using the same family
 * detection as scan. Anything that isn't a clean numeric bump within the
 * same family is "unknown" — and "unknown" is never auto-applied.
 */
export function classifyBump(currentTag: string, newTag: string): BumpKind {
  const cur = parseTag(currentTag);
  const next = parseTag(newTag);
  if (cur.family !== next.family) return "unknown";
  if (!cur.numeric || !next.numeric) return "unknown";
  const major = (cur.numeric[0] ?? 0) !== (next.numeric[0] ?? 0);
  const minor = (cur.numeric[1] ?? 0) !== (next.numeric[1] ?? 0);
  if (major) return "major";
  if (minor) return "minor";
  return "patch";
}

/**
 * Bump-action level. Controls how aggressively bumpsight auto-applies upgrades.
 *   patch / minor / major  → auto-apply at or below the named bump kind.
 *   notify                 → never auto-apply; hold for human approval.
 *   none                   → ignore (no email, no DB row).
 *
 * v0.4.0 dropped the legacy `report` action — `notify` covers the "tell me,
 * I'll decide" need; the old `report` (FYI-only no approve/deny) was an
 * underused middle ground. Loaders accept legacy `report` and silently map
 * it to `notify` with a one-time warning at startup.
 */
export type BumpAction = "patch" | "minor" | "major" | "notify" | "none";

/**
 * Per-stack policy: two orthogonal axes. The `app` axis controls the primary
 * service in the stack; the `dependencies` axis controls images recognized
 * as dependency layers (Postgres, Redis, MariaDB, Vault, etc. — see
 * `isDependencyImage`).
 *
 * v0.5.x default: `{ app: "minor", dependencies: "none" }` — auto-apply
 * patches + minors of the primary service (the contracts semver gives you for
 * free), hold majors for human approval (the version-author saying "this
 * might break you"), and stay silent on deps. Dep images follow the parent
 * app's release cadence; bumpsight does not surface independent dep tag
 * changes by default. Independent dep-major upgrades against a parent app's
 * pin risk on-disk format breaks, so the canonical answer is "wait for the
 * parent app to bump it."
 */
export interface PolicyAxes {
  app: BumpAction;
  dependencies: BumpAction;
}

export interface RulesConfig {
  /** Default policy applied when a stack has no explicit override. */
  default: PolicyAxes;
  /** Per-stack overrides keyed by stack name (compose project / directory). */
  stacks: Record<string, PolicyAxes>;
}

export type Decision = "auto-apply" | "hold" | "skip";

/**
 * Decide what to do with a discovered bump.
 *
 * Reads from the right axis of the stack's policy based on whether the
 * bumped image is a known dependency layer. A bump on `library/postgres`
 * (a dep) reads from `policy.dependencies`; a bump on `outline` (the app)
 * reads from `policy.app`.
 *
 *   patch  → auto-apply patches only.
 *   minor  → auto-apply patches and minors.
 *   major  → auto-apply everything classified.
 *   notify → never auto-apply; hold for human approval.
 *   none   → silent skip.
 *
 * `unknown` and `digest` bumps are always held — they don't carry a
 * semver classification we can reason about safely. `none` still skips
 * them silently, since the operator explicitly asked for silence.
 */
export function decideAction(
  config: RulesConfig,
  stack: string,
  bump: BumpKind,
  isDependency: boolean,
): Decision {
  const axes = config.stacks[stack] ?? config.default;
  const action = isDependency ? axes.dependencies : axes.app;
  if (action === "none") return "skip";
  if (action === "notify") return "hold";
  if (bump === "unknown" || bump === "digest") return "hold";
  const allowed: Record<Exclude<BumpAction, "notify" | "none">, BumpKind[]> = {
    patch: ["patch"],
    minor: ["patch", "minor"],
    major: ["patch", "minor", "major"],
  };
  return allowed[action].includes(bump) ? "auto-apply" : "hold";
}
