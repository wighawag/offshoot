import picomatch from "picomatch";

const cache = new Map<string, (path: string) => boolean>();

function matcher(pattern: string): (path: string) => boolean {
	let m = cache.get(pattern);
	if (!m) {
		m = picomatch(pattern, {dot: true});
		cache.set(pattern, m);
	}
	return m;
}

/**
 * Match a POSIX-relative path against a glob list. A bare pattern with no
 * slash also matches at any depth, so `skipIfExists: [".env"]` behaves the way
 * a template author expects.
 */
export function matchesAny(path: string, patterns: readonly string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (matcher(pattern)(path)) return true;
		if (!pattern.includes("/") && matcher(`**/${pattern}`)(path)) return true;
	}
	return false;
}
