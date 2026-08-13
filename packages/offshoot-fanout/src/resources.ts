import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/**
 * Finding files that ship beside the package.
 *
 * A published install carries `skills/` next to `dist/`, staged there at pack time. A checkout
 * keeps them at the repo root, two levels above `packages/offshoot-fanout`. Both are searched
 * rather than one being made canonical, so every command behaves the same in development and after
 * an install.
 */
const roots = ['../', '../../../'];

export function resolvePackageResource(relative: string): string | undefined {
	for (const root of roots) {
		try {
			const candidate = fileURLToPath(
				new URL(`${root}${relative}`, import.meta.url),
			);
			if (existsSync(candidate)) return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}
