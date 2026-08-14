// Canonicalization: normalizes a concrete route into a stable shape by replacing purely-numeric
// path segments with ":id" (e.g. /member/12345 -> /member/:id). This lets a urlMatches-style
// checkpoint authored against one concrete record/tenant still recognize the "same kind of
// place" on a different record id or a differently-prefixed tenant, without the artifact author
// having to enumerate every id or tenant path prefix up front.
export function canonicalizePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.length > 0 && /^\d+$/.test(segment) ? ":id" : segment))
    .join("/");
}

function pathOf(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    // Not a full URL (e.g. already just a path, or a bare checkpoint pattern) -- use as-is.
    return urlOrPath;
  }
}

/**
 * True if `observedUrl` has the same canonical route shape as `authoredPattern`, tolerant of a
 * tenant path prefix being added on one side (checked via suffix containment, not just
 * equality) -- e.g. a pattern authored against tenant A's "/member/10001" still recognizes
 * tenant B's "/tenant-b/member/99999". This is a heuristic fallback, not a full pattern
 * language: it treats `authoredPattern` as a literal path fragment, not as regex, so it's only
 * meaningful for the common case of a checkpoint pattern that IS a concrete-looking path.
 */
export function matchesCanonically(authoredPattern: string, observedUrl: string): boolean {
  const observed = canonicalizePath(pathOf(observedUrl));
  const authored = canonicalizePath(pathOf(authoredPattern));
  if (!authored) return false;
  return observed === authored || observed.endsWith(authored) || authored.endsWith(observed);
}
