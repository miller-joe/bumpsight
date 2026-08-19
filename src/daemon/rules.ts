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
  "immich-app/postgres", // immich's bundled Postgres + VectorChord — follows the immich server
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

/** Case/separator-insensitive name compare (`vault-agent` vs `vault_agent`). */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Return true when this service is the stack's *primary* service — the app —
 * rather than a supporting layer.
 *
 * This exists because {@link isDependencyImage} can only see an image name, and
 * an image name alone is ambiguous: `hashicorp/vault` is a dependency in the
 * ~30 stacks where it runs as a `vault-agent` sidecar, but it is the *app* in
 * the stack that runs the Vault server itself. Same image, opposite role.
 *
 * Two signals, either of which is decisive:
 *   1. The service is named after its stack (`vault` in stack `vault`).
 *   2. It is the only service in the stack, so there is nothing else it could
 *      be a dependency *of*.
 *
 * When `siblingServices` is omitted only signal 1 is available — that is the
 * correct degraded behaviour for callers working from a stored row rather than
 * a parsed compose file (e.g. the reconcile pass).
 */
export function isPrimaryService(
  stackName: string,
  serviceName: string,
  siblingServices?: string[],
): boolean {
  if (normalizeName(stackName) === normalizeName(serviceName)) return true;
  if (siblingServices && siblingServices.length <= 1) return true;
  return false;
}

/**
 * Return true if the image ref is a well-known dependency layer (DB, cache,
 * broker, secret store, vector DB, etc.). Pass the full image ref like
 * `library/postgres` or `valkey/valkey`. Implicit `library/` is stripped
 * before lookup so callers can pass the bare repo name too (`postgres`).
 *
 * Pass `ctx` to disambiguate the case where a dependency-listed image is
 * actually the stack's app (see {@link isPrimaryService}). Without `ctx` the
 * behaviour is the pre-0.6.2 image-name-only lookup, so existing callers are
 * unaffected.
 */
export function isDependencyImage(
  repoRef: string,
  ctx?: { stack: string; service: string; siblingServices?: string[] },
): boolean {
  const normalized = repoRef.toLowerCase();
  // Strip a registry host if present (`docker.io/library/postgres`,
  // `ghcr.io/foo/bar` — we only check namespace/name).
  const noRegistry = normalized.replace(/^[a-z0-9.-]+\.[a-z]+\//, "");
  const known =
    KNOWN_DEPENDENCY_IMAGES.has(noRegistry) ||
    KNOWN_DEPENDENCY_IMAGES.has(`library/${noRegistry}`);
  if (!known) return false;
  // A dependency-listed image serving as the stack's app is an app.
  if (ctx && isPrimaryService(ctx.stack, ctx.service, ctx.siblingServices)) {
    return false;
  }
  return true;
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
  /** v0.6.4: policy for dep pins the PARENT APP's own upstream compose
   *  recommends at the version we already run — as opposed to `dependencies`,
   *  which governs new dep tags seen in the registry.
   *
   *  These are different questions and deserve different answers. The comment
   *  above says the canonical response to an independent dep bump is "wait for
   *  the parent app to bump it" — this axis is what finally watches for that.
   *  A fleet can therefore run `dependencies: none` (don't chase Postgres
   *  releases on our own) alongside `paired: notify` (do tell me when the app
   *  maintainer changes what they ship against).
   *
   *  Defaults to `notify` when unset: surfacing is safe, silence is not. */
  paired?: BumpAction;
}

export interface RulesConfig {
  /** Default policy applied when a stack has no explicit override. */
  default: PolicyAxes;
  /** Per-stack overrides keyed by stack name (compose project / directory). */
  stacks: Record<string, PolicyAxes>;
}

const VALID_ACTIONS: readonly string[] = [
  "patch",
  "minor",
  "major",
  "notify",
  "none",
];

/**
 * v0.6.0: overlay UI-set per-stack policy overrides (from the `stack_policies`
 * table) on top of the file/env rules. The DB wins per-stack. Invalid stored
 * values fall back to the underlying file/env value for that axis, so a bad
 * write can never widen auto-apply beyond what the config already allowed.
 *
 * Returns a fresh RulesConfig — the input is never mutated, so the daemon can
 * recompute this each scan tick and pick up UI edits without a restart.
 */
export function applyStackPolicyOverrides(
  rules: RulesConfig,
  overrides: Record<string, { app: string; dependencies: string }>,
): RulesConfig {
  const stacks: Record<string, PolicyAxes> = { ...rules.stacks };
  const coerce = (v: string, fallback: BumpAction): BumpAction =>
    VALID_ACTIONS.includes(v) ? (v as BumpAction) : fallback;
  for (const [stack, o] of Object.entries(overrides)) {
    const base = stacks[stack] ?? rules.default;
    stacks[stack] = {
      app: coerce(o.app, base.app),
      dependencies: coerce(o.dependencies, base.dependencies),
    };
  }
  return { default: rules.default, stacks };
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
 * `digest` (moving-tag) bumps AUTO-APPLY under any auto-apply policy: pinning
 * `:latest`/`:main` is itself the operator's opt-in to the author's rolling
 * releases (and the author's opt-in to shipping usable `:latest` builds), so
 * bumpsight rolls them forward rather than second-guessing an unknowable
 * change. Set the stack to `notify` to be asked even for moving tags, or `none`
 * to skip. `unknown` bumps (a non-moving tag we genuinely can't classify) are
 * still held.
 */
export function decideAction(
  config: RulesConfig,
  stack: string,
  bump: BumpKind,
  isDependency: boolean,
  origin?: string | null,
): Decision {
  const axes = config.stacks[stack] ?? config.default;
  // v0.6.4: a paired row is an upstream recommendation, not a registry find.
  // It routes to its own axis regardless of whether the image is dep-listed —
  // being a dependency is precisely what makes it a paired row.
  const action =
    origin === "paired"
      ? (axes.paired ?? "notify")
      : isDependency
        ? axes.dependencies
        : axes.app;
  if (action === "none") return "skip";
  if (action === "notify") return "hold";
  if (bump === "digest") return "auto-apply";
  if (bump === "unknown") return "hold";
  const allowed: Record<Exclude<BumpAction, "notify" | "none">, BumpKind[]> = {
    patch: ["patch"],
    minor: ["patch", "minor"],
    major: ["patch", "minor", "major"],
  };
  return allowed[action].includes(bump) ? "auto-apply" : "hold";
}
