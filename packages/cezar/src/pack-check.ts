/** Tarball bundle check — the pure half of `scripts/check-pack.mjs`.
 *
 *  Phase R1 of the cockpit redesign shipped an npm tarball with no UI in it
 *  (`files` listed the sources, not the Vite build). This module pins that bug
 *  class: given the file list `npm pack --dry-run --json` reports, decide
 *  whether the package would ship a working cockpit. Kept dependency-free and
 *  side-effect-free so the decision is unit-testable; the script owns the
 *  `npm pack` invocation and the exit code.
 */

/** Human-readable problems with a would-be tarball; empty array = publishable.
 *
 *  Requirements (spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`, Serving):
 *  - `web/dist/index.html` — the built shell every GET serves.
 *  - at least one `web/dist/assets/*` file — the hashed JS/CSS bundles; an
 *    index.html alone renders a blank page.
 */
export function findPackGaps(packedFiles: readonly string[]): string[] {
  const gaps: string[] = [];
  if (!packedFiles.includes('web/dist/index.html')) {
    gaps.push('web/dist/index.html is missing — the tarball would ship no UI shell (run `npm run build:web`)');
  }
  if (!packedFiles.some((f) => f.startsWith('web/dist/assets/') && f.length > 'web/dist/assets/'.length)) {
    gaps.push('no web/dist/assets/* bundle in the tarball — the shell would load with no JS/CSS');
  }
  // The SDLC baseline (spec 2026-10-06-ai-native-sdlc-fleet) is read at runtime from the package
  // root; a tarball without it would answer every audit with a baseline that cannot load.
  for (const required of ['baseline/manifest.json', 'baseline/files/CLAUDE.md']) {
    if (!packedFiles.includes(required)) {
      gaps.push(`${required} is missing — the SDLC baseline would not load (add "baseline" to the package "files")`);
    }
  }
  return gaps;
}
