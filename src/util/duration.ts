/**
 * Parse a duration string like "30s", "10m", "6h", "1d" into milliseconds.
 * Plain integers are interpreted as seconds. Throws on garbage.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty duration");
  const match = trimmed.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) throw new Error(`invalid duration: ${input}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const factors: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * factors[unit]!;
}
