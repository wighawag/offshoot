/**
 * Strategy 2: `patterns`.
 *
 * Ported from create-jolly-roger's buildReplacements(): an ordered list of
 * explicit, context-anchored [from, to] pairs. The anchoring is the point -
 * `"jolly-roger"` with the quotes matches a package.json name field and
 * nothing else.
 *
 * This is the precision escape hatch for templates where blind token
 * replacement is unsafe. Composes with `rename`, in either order.
 */

import type {
	Answers,
	PatternsSpec,
	Transform,
	TransformContext,
	VirtualFile,
} from '../types.js';

export function createPatternsTransform(spec: PatternsSpec): Transform {
	return {
		name: 'patterns',
		apply(
			files: VirtualFile[],
			answers: Answers,
			_ctx: TransformContext,
		): VirtualFile[] {
			const pairs = spec.patterns.map((p) => {
				const to = typeof p.to === 'function' ? p.to(answers) : p.to;
				if (typeof to !== 'string') {
					throw new Error(
						`patterns transform: replacement for "${p.from}" did not produce a string`,
					);
				}
				return {from: p.from, to};
			});

			const replace = (input: string): string => {
				let output = input;
				for (const pair of pairs) {
					if (pair.from === '') continue;
					output = output.split(pair.from).join(pair.to);
				}
				return output;
			};

			return files.map((file) => {
				if (file.skip) return file;

				let next = file;

				if (spec.paths === true) {
					const newPath = file.path.split('/').map(replace).join('/');
					if (newPath !== file.path) next = {...next, path: newPath};
				}

				if (!file.binary) {
					const before = file.content.toString('utf8');
					const after = replace(before);
					if (after !== before)
						next = {...next, content: Buffer.from(after, 'utf8')};
				}

				return next;
			});
		},
	};
}
