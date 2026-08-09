/**
 * Template configuration.
 *
 * Zero-config must work: with no config file at all, the source token is
 * inferred from the template repo name, the `rename` strategy runs, the target
 * name is prompted for, and the default skip lists apply. `npm create offshoot
 * wighawag/some-template my-app` works against a template that has never heard
 * of offshoot.
 *
 * Config is read from the FETCHED ref on every operation, so authors can
 * evolve it and existing projects pick the new version up on update.
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {OffshootConfig, PromptSpec, ResolvedConfig} from './types.js';

/** Carried over from create-jolly-roger and change-name. */
export const DEFAULT_SKIP_DIRS = [
	'node_modules',
	'.git',
	'.svelte-kit',
	'dist',
	'artifacts',
	'cache',
	'generated',
	'deployments',
];

export const DEFAULT_SKIP_FILES = [
	'pnpm-lock.yaml',
	'package-lock.json',
	'yarn.lock',
	'pnpm-workspace.yaml',
];

/** File CONTENT delimiters. Path delimiters are fixed at `{{ }}`; see path-interpolation.ts. */
export const DEFAULT_CONTENT_TAGS: [string, string] = ['{{', '}}'];

export const DEFAULT_BRANCH = 'template';

const CONFIG_FILENAMES = [
	'offshoot.config.ts',
	'offshoot.config.mts',
	'offshoot.config.js',
	'offshoot.config.mjs',
	'offshoot.config.cjs',
	'offshoot.config.json',
];

/** Typed helper for `offshoot.config.ts`. */
export function defineConfig(config: OffshootConfig): OffshootConfig {
	return config;
}

export function findConfigFile(dir: string): string | undefined {
	for (const name of CONFIG_FILENAMES) {
		const p = join(dir, name);
		if (existsSync(p)) return p;
	}
	return undefined;
}

export async function loadConfigFile(file: string): Promise<OffshootConfig> {
	if (file.endsWith('.json')) {
		const raw = readFileSync(file, 'utf8');
		try {
			return JSON.parse(raw) as OffshootConfig;
		} catch (err) {
			throw new Error(
				`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Every non-JSON config goes through jiti: Node 20 cannot strip types, and
	// jiti lets us alias the bare specifier "offshoot" to the copy that is
	// actually running. Without that alias, a template whose config says
	//   import {defineConfig} from "offshoot"
	// would fail on the user's machine, because the config is evaluated inside
	// the freshly downloaded template directory, where nothing is installed.
	const {createJiti} = await import('jiti');
	const selfEntry = fileURLToPath(new URL('./index.js', import.meta.url));
	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		alias: {offshoot: selfEntry},
	});
	const mod: unknown = await jiti.import(file);

	const value = (mod as {default?: unknown})?.default ?? mod;
	const resolved =
		typeof value === 'function' ? (value as () => OffshootConfig)() : value;
	if (!resolved || typeof resolved !== 'object') {
		throw new Error(
			`${file} must export a config object (use defineConfig()).`,
		);
	}
	return resolved as OffshootConfig;
}

/** Read the config out of a fetched template directory. Absent is fine. */
export async function loadTemplateConfig(
	dir: string,
): Promise<{config: OffshootConfig; file?: string}> {
	const file = findConfigFile(dir);
	if (!file) return {config: {}};
	return {config: await loadConfigFile(file), file};
}

export interface ResolveConfigOptions {
	/** Fallback source token, inferred from the template repo name. */
	inferredSourceName: string;
}

export function resolveConfig(
	config: OffshootConfig,
	options: ResolveConfigOptions,
): ResolvedConfig {
	const sourceName = config.sourceName ?? options.inferredSourceName;
	if (!sourceName) {
		throw new Error(
			'Could not determine the source token. Set `sourceName` in offshoot.config, or use a template whose repo name is the token.',
		);
	}

	const contentTags = config.contentTags ?? DEFAULT_CONTENT_TAGS;
	if (
		!Array.isArray(contentTags) ||
		contentTags.length !== 2 ||
		!contentTags[0] ||
		!contentTags[1]
	) {
		throw new Error(
			'`contentTags` must be a pair of non-empty strings, e.g. ["{{", "}}"].',
		);
	}

	return {
		sourceName,
		branch: config.branch ?? DEFAULT_BRANCH,
		transforms: config.transforms ?? [{type: 'rename'}],
		prompts: config.prompts ?? defaultPrompts(sourceName),
		contentTags: [contentTags[0], contentTags[1]],
		skipDirs: config.skipDirs ?? DEFAULT_SKIP_DIRS,
		skipFiles: config.skipFiles ?? DEFAULT_SKIP_FILES,
		skipIfExists: config.skipIfExists ?? [],
		exclude: config.exclude ?? [],
		pathInterpolationExclude: config.pathInterpolationExclude ?? [],
		eject: {
			exclude: config.eject?.exclude ?? [],
			packageJson: {
				dependencies: config.eject?.packageJson?.dependencies ?? [],
				devDependencies: config.eject?.packageJson?.devDependencies ?? [],
				scripts: config.eject?.packageJson?.scripts ?? [],
			},
		},
	};
}

/** Zero-config: one question, the project name. */
export function defaultPrompts(sourceName: string): PromptSpec[] {
	return [
		{
			name: 'name',
			type: 'text',
			message: 'Project name (kebab-case):',
			initial: sourceName,
			validate: '^[a-z0-9]+(-[a-z0-9]+)*$',
			validationMessage:
				'Project name must be kebab-case (e.g. my-awesome-app)',
		},
	];
}
