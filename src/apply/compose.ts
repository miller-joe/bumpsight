import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument, isScalar } from "yaml";

/**
 * Rewrite a single service's image tag in-place inside a compose file,
 * preserving comments and formatting via the yaml library's Document API.
 *
 * The `expectedCurrentTag` guard avoids racing with a manual edit: if the
 * compose file no longer holds the tag we're trying to bump from, the
 * rewrite throws rather than overwriting whatever a human just changed.
 */
export interface RewriteOptions {
  composePath: string;
  serviceName: string;
  expectedCurrentTag: string;
  newTag: string;
}

export function rewriteImageTag(opts: RewriteOptions): void {
  const raw = readFileSync(opts.composePath, "utf-8");
  const doc = parseDocument(raw);
  const node = doc.getIn(["services", opts.serviceName, "image"], true);
  if (!node || !isScalar(node) || typeof node.value !== "string") {
    throw new Error(
      `${opts.composePath}: services.${opts.serviceName}.image not found or not a string`,
    );
  }
  const current = node.value;
  const replaced = replaceTagInRef(current, opts.expectedCurrentTag, opts.newTag);
  node.value = replaced;
  writeFileSync(opts.composePath, doc.toString(), "utf-8");
}

/**
 * Swap the tag portion of a Docker image reference. Returns the new string.
 * Throws if the existing tag doesn't match `expectedCurrentTag` — that
 * guard is what makes the rewrite race-safe.
 */
export function replaceTagInRef(
  ref: string,
  expectedCurrentTag: string,
  newTag: string,
): string {
  // Strip an optional digest suffix; we ignore digests for the rewrite.
  const atIdx = ref.indexOf("@");
  const head = atIdx >= 0 ? ref.slice(0, atIdx) : ref;
  const digest = atIdx >= 0 ? ref.slice(atIdx) : "";

  const lastSlash = head.lastIndexOf("/");
  const lastColon = head.lastIndexOf(":");
  // A colon counts as the tag separator only if it's after the last slash
  // (otherwise it's part of a registry like `localhost:5000/x`).
  const tagColon = lastColon > lastSlash ? lastColon : -1;
  const currentTag = tagColon >= 0 ? head.slice(tagColon + 1) : "latest";
  const baseRef = tagColon >= 0 ? head.slice(0, tagColon) : head;

  if (currentTag !== expectedCurrentTag) {
    throw new Error(
      `image tag drift: expected ${expectedCurrentTag}, found ${currentTag}`,
    );
  }
  return `${baseRef}:${newTag}${digest}`;
}
