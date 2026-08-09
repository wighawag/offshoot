/**
 * change-name pins change-case@4. We use v5, which renamed two exports:
 *
 *   v4 paramCase  -> v5 kebabCase
 *   v4 headerCase -> v5 trainCase
 *
 * The v4 names are kept as offshoot's vocabulary (they are what a template
 * author reading change-name would expect) and mapped here, so behaviour is
 * identical. `test/case-variants.test.ts` proves the mapping against a real
 * change-case@4 installed as a dev dependency.
 */

import {
	camelCase,
	capitalCase,
	constantCase,
	dotCase,
	kebabCase,
	noCase,
	pascalCase,
	pathCase,
	sentenceCase,
	snakeCase,
	trainCase,
} from 'change-case';
import type {CaseVariant} from './types.js';

export const CASE_FUNCTIONS: Record<CaseVariant, (input: string) => string> = {
	camelCase,
	constantCase,
	headerCase: trainCase, // renamed in change-case v5
	noCase,
	paramCase: kebabCase, // renamed in change-case v5
	pascalCase,
	pathCase,
	sentenceCase,
	snakeCase,
	capitalCase,
	dotCase,
};

/** The exact list, and order, change-name uses. */
export const DEFAULT_VARIANTS: CaseVariant[] = [
	'camelCase',
	'constantCase',
	'headerCase',
	'noCase',
	'paramCase',
	'pascalCase',
	'pathCase',
	'sentenceCase',
	'snakeCase',
	'capitalCase',
	'dotCase',
];

export function variantsOf(
	name: string,
	variants: CaseVariant[] = DEFAULT_VARIANTS,
): string[] {
	return variants.map((v) => CASE_FUNCTIONS[v](name));
}

/**
 * The (from, to) pairs for one rename, in the order they are applied.
 * Duplicates are dropped: several variants can collapse to the same string
 * (e.g. paramCase and dotCase of a single word), and replacing twice would
 * double-count occurrences in the round-trip gate.
 */
export function variantPairs(
	from: string,
	to: string,
	variants: CaseVariant[] = DEFAULT_VARIANTS,
): {variant: CaseVariant; from: string; to: string}[] {
	const seen = new Set<string>();
	const pairs: {variant: CaseVariant; from: string; to: string}[] = [];
	for (const variant of variants) {
		const fn = CASE_FUNCTIONS[variant];
		if (!fn) continue;
		const f = fn(from);
		const t = fn(to);
		if (f === '' || seen.has(f)) continue;
		seen.add(f);
		pairs.push({variant, from: f, to: t});
	}
	return pairs;
}
