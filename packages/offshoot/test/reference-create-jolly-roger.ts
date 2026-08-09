/**
 * The reference behaviour: create-jolly-roger's substitution logic, ported
 * VERBATIM from `create-jolly-roger/cli.js` so the migration is compared
 * against what that tool actually does, not against a description of it.
 *
 * Kept deliberately faithful, including the `try { readFileSync(path,'utf-8') }
 * catch` binary guard that does not work (see the binary tests).
 */

import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

function replaceInText(text: string, replacements: [string, string][]): string {
	let result = text;
	for (const [pattern, replacement] of replacements) {
		result = result.split(pattern).join(replacement);
	}
	return result;
}

export function buildReplacements(projectName: string): [string, string][] {
	// Derive title case: "my-app" -> "My App"
	const titleCase = projectName
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');

	return [
		// Package names
		['"jolly-roger"', `"${projectName}"`],
		['"jolly-roger-web"', `"${projectName}-web"`],
		['"jolly-roger-contracts"', `"${projectName}-contracts"`],

		// Display names
		['Jolly Roger', titleCase],

		// Contract package imports in README
		['"jolly-roger-contracts/', `"${projectName}-contracts/`],

		// Case-insensitive regex in e2e tests: /jolly roger/i
		['/jolly roger/i', `/${projectName.replace(/-/g, ' ')}/i`],
	];
}

export const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'dist',
	'artifacts',
	'cache',
	'generated',
	'deployments',
	'purgatory.db',
]);

export const SKIP_FILES = new Set([
	'pnpm-lock.yaml',
	'package-lock.json',
	'yarn.lock',
	'pnpm-workspace.yaml',
]);

export function processAllFiles(
	dir: string,
	replacements: [string, string][],
): void {
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		const st = statSync(fullPath);

		if (st.isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue;
			processAllFiles(fullPath, replacements);
		} else if (st.isFile()) {
			if (SKIP_FILES.has(entry)) continue;
			try {
				const content = readFileSync(fullPath, 'utf-8');
				const newContent = replaceInText(content, replacements);
				if (newContent !== content) {
					writeFileSync(fullPath, newContent, 'utf-8');
				}
			} catch {
				// Binary file, skip
			}
		}
	}
}
