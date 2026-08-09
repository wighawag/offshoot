/**
 * Strategy 1: `rename` (the default).
 *
 * Ported from change-name: replace a source token with the target name across
 * every case variant, in file CONTENTS and in file and directory NAMES.
 *
 * This is what makes "the template is a working project" possible: the
 * template contains a real, compiling, testable token (`jolly-roger`), not
 * `{{project_name}}`.
 */

import type {
	Answers,
	CaseVariant,
	RenameSpec,
	Transform,
	TransformContext,
	VirtualFile,
} from '../types.js';
import {DEFAULT_VARIANTS, variantPairs} from '../case-variants.js';

export interface RenameCountResult {
	files: VirtualFile[];
	/** Total replacements, across paths and contents. */
	count: number;
	/** Replacements per file, keyed by the file's path in `files`. */
	perFile: Map<string, number>;
}

export interface RenameOptions {
	variants?: CaseVariant[];
	/** Count what would change without changing it (the round-trip pass). */
	countOnly?: boolean;
}

/**
 * The core replacement pass. Returns a new tree; never mutates the input.
 */
export function applyRename(
	files: VirtualFile[],
	from: string,
	to: string,
	options: RenameOptions = {},
): RenameCountResult {
	const pairs = variantPairs(from, to, options.variants ?? DEFAULT_VARIANTS);
	const countOnly = options.countOnly === true;
	const perFile = new Map<string, number>();
	let total = 0;

	const replaceCounting = (input: string): {output: string; count: number} => {
		let output = input;
		let count = 0;
		for (const pair of pairs) {
			if (!output.includes(pair.from)) continue;
			const splits = output.split(pair.from);
			count += splits.length - 1;
			output = splits.join(pair.to);
		}
		return {output, count};
	};

	const out: VirtualFile[] = files.map((file) => {
		if (file.skip) {
			perFile.set(file.path, 0);
			return file;
		}

		let count = 0;

		// Paths: every segment, so nested directories are renamed too.
		const segments = file.path.split('/');
		const newSegments = segments.map((segment) => {
			const r = replaceCounting(segment);
			count += r.count;
			return r.output;
		});
		const newPath = countOnly ? file.path : newSegments.join('/');

		// Contents: text only. Binary files pass through byte-identical, but
		// their paths above were still renamed.
		let content = file.content;
		if (!file.binary) {
			const r = replaceCounting(content.toString('utf8'));
			count += r.count;
			if (!countOnly && r.count > 0) {
				content = Buffer.from(r.output, 'utf8');
			}
		}

		total += count;
		perFile.set(newPath, (perFile.get(newPath) ?? 0) + count);

		if (count === 0 || countOnly)
			return file.path === newPath ? file : {...file, path: newPath};
		return {...file, path: newPath, content};
	});

	return {files: out, count: total, perFile};
}

export interface RoundTripOccurrence {
	path: string;
	line: number;
	text: string;
	match: string;
}

export class RoundTripError extends Error {
	readonly forward: number;
	readonly reverse: number;
	readonly files: string[];
	readonly occurrences: RoundTripOccurrence[];

	constructor(args: {
		from: string;
		to: string;
		forward: number;
		reverse: number;
		files: string[];
		occurrences: RoundTripOccurrence[];
	}) {
		const direction =
			args.reverse > args.forward
				? `"${args.to}" already occurs in the template where it does not mean the project`
				: `"${args.from}" occurs in the template where it does not mean the project, or the replacement collapsed distinct strings`;
		super(
			`Uniqueness check failed for "${args.from}" -> "${args.to}".\n` +
				`  ${args.forward} replacement(s) applied, ${args.reverse} found when reversing.\n` +
				`  ${direction}, so this transform is not round-trippable and an update could silently corrupt the project.`,
		);
		this.name = 'RoundTripError';
		this.forward = args.forward;
		this.reverse = args.reverse;
		this.files = args.files;
		this.occurrences = args.occurrences;
	}

	get report(): string {
		const lines = [this.message, ''];
		if (this.files.length > 0) {
			lines.push('Files where the counts disagree:');
			for (const f of this.files) lines.push(`  ${f}`);
			lines.push('');
		}
		if (this.occurrences.length > 0) {
			lines.push('Offending occurrences:');
			for (const o of this.occurrences) {
				lines.push(`  ${o.path}:${o.line}: ${o.text.trim()}`);
			}
			if (this.occurrences.length >= MAX_REPORTED) {
				lines.push(`  ... (truncated)`);
			}
			lines.push('');
		}
		lines.push(
			'Pick a different name, add a `patterns` transform for the ambiguous spots,',
		);
		lines.push('or re-run with --force to accept the risk.');
		return lines.join('\n');
	}
}

const MAX_REPORTED = 40;

/**
 * The hard gate. change-name only detected this once, interactively; offshoot
 * runs it on every transform (scaffold, update and rename), because a new
 * template ref can introduce occurrences that collide with a name chosen
 * months earlier, and silently corrupting an update is the worst possible
 * failure mode.
 */
export function assertRoundTrip(
	original: VirtualFile[],
	from: string,
	to: string,
	options: RenameOptions = {},
): RenameCountResult {
	const variants = options.variants ?? DEFAULT_VARIANTS;
	const forward = applyRename(original, from, to, {variants});
	const reverse = applyRename(forward.files, to, from, {
		variants,
		countOnly: true,
	});

	if (forward.count === reverse.count) return forward;

	const disagreeing: string[] = [];
	for (const [path, forwardCount] of forward.perFile) {
		const reverseCount = reverse.perFile.get(path) ?? 0;
		if (forwardCount !== reverseCount) disagreeing.push(path);
	}

	const occurrences = collectOccurrences(
		forward.files,
		disagreeing,
		to,
		variants,
	);

	throw new RoundTripError({
		from,
		to,
		forward: forward.count,
		reverse: reverse.count,
		files: disagreeing,
		occurrences,
	});
}

function collectOccurrences(
	files: VirtualFile[],
	paths: string[],
	needle: string,
	variants: CaseVariant[],
): RoundTripOccurrence[] {
	const wanted = new Set(paths);
	const terms = variantPairs(needle, needle, variants).map((p) => p.from);
	const out: RoundTripOccurrence[] = [];
	for (const file of files) {
		if (!wanted.has(file.path) || file.binary || file.skip) continue;
		const lines = file.content.toString('utf8').split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			for (const term of terms) {
				if (term !== '' && line.includes(term)) {
					out.push({path: file.path, line: i + 1, text: line, match: term});
					break;
				}
			}
			if (out.length >= MAX_REPORTED) return out;
		}
	}
	return out;
}

export function createRenameTransform(spec: RenameSpec): Transform {
	return {
		name: 'rename',
		apply(
			files: VirtualFile[],
			answers: Answers,
			ctx: TransformContext,
		): VirtualFile[] {
			const from = spec.from ?? ctx.sourceName;
			const answerKey = spec.answer ?? 'name';
			const raw = answers[answerKey];
			if (typeof raw !== 'string' || raw === '') {
				throw new Error(
					`rename transform: answer "${answerKey}" is missing or not a string`,
				);
			}
			if (from === raw) return files;
			const variants = spec.variants ?? DEFAULT_VARIANTS;
			// The gate is inside the transform on purpose: any pipeline that
			// renames is checked, every time it runs.
			if (!ctx.force) {
				return assertRoundTrip(files, from, raw, {variants}).files;
			}
			return applyRename(files, from, raw, {variants}).files;
		},
	};
}
