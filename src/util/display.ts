import type { UpdateRow } from "../state/db.js";

/**
 * v0.6.0: the value to display for the "from" / "to" side of an update.
 *
 * Prefers the decoded `display_from` / `display_to` override (a version or
 * build date derived from OCI labels for a moving-tag digest bump). Falls back
 * to the raw tag — with a `…` suffix for an un-decoded digest-class row so it
 * still reads as a truncated hash rather than a real tag.
 */
type DisplayRow = Pick<
  UpdateRow,
  "display_from" | "display_to" | "current_tag" | "target_tag" | "bump"
>;

export function fromDisplay(row: DisplayRow): string {
  if (row.display_from) return row.display_from;
  return row.bump === "digest" ? `${row.current_tag}…` : row.current_tag;
}

export function toDisplay(row: DisplayRow): string {
  if (row.display_to) return row.display_to;
  return row.bump === "digest" ? `${row.target_tag}…` : row.target_tag;
}

/**
 * The floating tag a row tracks by digest (`latest`, `4.39`, …), from its
 * `moving:<tag>` or `pinned:<tag>` family. Undefined for ordinary tag bumps.
 */
export function floatingTagOf(family: string | null | undefined): string | undefined {
  if (!family) return undefined;
  const m = family.match(/^(?:moving|pinned):(.*)$/);
  return m ? m[1] : undefined;
}
