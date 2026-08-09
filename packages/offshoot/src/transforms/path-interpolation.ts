/**
 * File and folder NAME interpolation. Fixed at `{{ }}`, deliberately NOT
 * configurable, and always active.
 *
 * Why fixed: `<` and `>` are reserved characters in Windows filenames. If path
 * delimiters were configurable, an author could set them to Eta's default
 * `<% %>` and produce a template repository that cannot be checked out on
 * Windows at all. The config field is therefore named `contentTags`, so its
 * scope is unambiguous: it governs file contents only.
 *
 * Why always active, independent of the `template` strategy opt-in: a path
 * containing `{{` is unambiguous intent. Nobody names a file `{{name}}.ts` by
 * accident. `pathInterpolationExclude` covers the pathological case.
 *
 * Simple variable substitution only, never logic: a filename never needs a
 * loop, and `/` in an expansion would silently create directories.
 */

import type {
	Answers,
	Transform,
	TransformContext,
	VirtualFile,
} from '../types.js';
import {matchesAny} from '../glob.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g;

export const PATH_TAGS: readonly [string, string] = ['{{', '}}'];

export function hasPathPlaceholder(path: string): boolean {
	PLACEHOLDER.lastIndex = 0;
	return PLACEHOLDER.test(path);
}

export function interpolatePath(path: string, answers: Answers): string {
	return path.replace(PLACEHOLDER, (_whole, key: string) => {
		if (!(key in answers)) {
			throw new Error(
				`path interpolation: "${path}" refers to {{${key}}}, which is not an answer. ` +
					`Add a prompt named "${key}" to offshoot.config, or rename the file.`,
			);
		}
		const value = answers[key];
		const text = value == null ? '' : String(value);
		if (text.includes('/') || text.includes('\\')) {
			throw new Error(
				`path interpolation: {{${key}}} expanded to "${text}", which contains a path separator. ` +
					`Names are substituted into a single path segment and may not create directories.`,
			);
		}
		if (text === '') {
			throw new Error(
				`path interpolation: {{${key}}} expanded to an empty string in "${path}"`,
			);
		}
		return text;
	});
}

export function createPathInterpolationTransform(exclude: string[]): Transform {
	return {
		name: 'path-interpolation',
		apply(
			files: VirtualFile[],
			answers: Answers,
			_ctx: TransformContext,
		): VirtualFile[] {
			return files.map((file) => {
				if (file.skip) return file;
				if (!hasPathPlaceholder(file.path)) return file;
				if (matchesAny(file.path, exclude)) return file;
				const newPath = interpolatePath(file.path, answers);
				if (newPath === file.path) return file;
				return {...file, path: newPath};
			});
		},
	};
}
