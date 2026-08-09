/**
 * fetched directory -> in-memory tree -> ordered transforms -> tree.
 *
 * Every command (scaffold, update, rename) goes through exactly this, which is
 * what makes an update reproducible: the same inputs always produce the same
 * transformed snapshot.
 */

import type {
	Answers,
	Logger,
	Operation,
	ResolvedConfig,
	TransformContext,
	VirtualFile,
} from './types.js';
import {readTree} from './vfs.js';
import {
	resolveTransforms,
	createPathInterpolationTransform,
} from './transforms/index.js';
import {
	createEjectTransform,
	type EjectReport,
} from './transforms/eject-integration.js';

export interface BuildTreeOptions {
	/** Directory the template was fetched into. */
	dir: string;
	config: ResolvedConfig;
	answers: Answers;
	template: string;
	ref: string;
	operation: Operation;
	force?: boolean;
	/** Scaffold with no link to the template: strip the integration. */
	eject?: boolean;
	/** Filled in with what the eject transform removed, when ejecting. */
	ejectReport?: EjectReport;
	log: Logger;
}

export function buildTree(options: BuildTreeOptions): VirtualFile[] {
	const {config} = options;

	const eject = options.eject === true;

	let files = readTree(options.dir, {
		skipDirs: config.skipDirs,
		skipFiles: config.skipFiles,
		exclude: eject
			? [...config.exclude, ...config.eject.exclude]
			: config.exclude,
	});

	const ctx: TransformContext = {
		sourceName: config.sourceName,
		template: options.template,
		ref: options.ref,
		config,
		contentTags: config.contentTags,
		operation: options.operation,
		force: options.force === true,
		eject,
		log: options.log,
	};

	const transforms = resolveTransforms(config.transforms);
	// After the template's own transforms, so a custom transform can still add
	// integration bits and have them stripped here.
	if (eject)
		transforms.push(createEjectTransform(config.eject, options.ejectReport));
	// Path interpolation runs last and always: by then no other strategy can
	// reintroduce or consume a `{{name}}` path segment.
	transforms.push(
		createPathInterpolationTransform(config.pathInterpolationExclude),
	);

	for (const transform of transforms) {
		const before = files.length;
		files = transform.apply(files, options.answers, ctx);
		if (!Array.isArray(files)) {
			throw new Error(
				`Transform "${transform.name}" did not return a file array.`,
			);
		}
		options.log.debug(
			`transform ${transform.name}: ${before} -> ${files.length} file(s)`,
		);
	}

	assertSanePaths(files);
	return files;
}

function assertSanePaths(files: VirtualFile[]): void {
	const seen = new Map<string, string>();
	for (const file of files) {
		if (
			file.path === '' ||
			file.path.startsWith('/') ||
			file.path.includes('..')
		) {
			throw new Error(`Transform produced an unsafe path: "${file.path}"`);
		}
		const existing = seen.get(file.path);
		if (existing !== undefined) {
			throw new Error(
				`Transform produced two files at "${file.path}". ` +
					`Two template files collapsed onto the same name; check your rename target or path placeholders.`,
			);
		}
		seen.set(file.path, file.path);
	}
}
