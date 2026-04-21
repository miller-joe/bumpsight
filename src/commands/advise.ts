export interface AdviseOptions {
  image: string;
  from?: string;
  to?: string;
  format?: "text" | "json";
}

/**
 * Stub for v0.0.1. Fetches release notes for an image bump and summarizes
 * the breaking changes via a local LLM. Full implementation in a follow-up
 * release; this placeholder keeps the CLI contract stable and returns a
 * clear "not yet" so users know the command exists.
 */
export function runAdvise(_opts: AdviseOptions): { exitCode: number; output: string } {
  return {
    exitCode: 1,
    output:
      "bumpsight advise: not implemented in 0.0.1. Shipping with the update-manager daemon in 0.1.\n",
  };
}
