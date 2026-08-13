import {describe, it, expect} from 'vitest';
import {normalizeUrl} from '../src/core.js';

describe('normalizeUrl', () => {
	it('maps SSH/HTTPS forms to the same canonical URL', () => {
		expect(normalizeUrl('git@github.com:wighawag/template-svelte')).toBe(
			'https://github.com/wighawag/template-svelte',
		);
		expect(normalizeUrl('git@github.com:wighawag/template-svelte.git')).toBe(
			'https://github.com/wighawag/template-svelte',
		);
		expect(
			normalizeUrl('https://github.com/wighawag/template-svelte.git'),
		).toBe('https://github.com/wighawag/template-svelte');
		expect(
			normalizeUrl('ssh://git@github.com/wighawag/template-svelte.git'),
		).toBe('https://github.com/wighawag/template-svelte');
		expect(normalizeUrl('ssh://git@github.com/wighawag/template-svelte')).toBe(
			'https://github.com/wighawag/template-svelte',
		);
	});

	it('treats a child SSH `original` and parent HTTPS `origin` as equal', () => {
		expect(normalizeUrl('git@github.com:wighawag/template-svelte.git')).toBe(
			normalizeUrl('https://github.com/wighawag/template-svelte'),
		);
	});

	it('lowercases host and path for case-insensitive matching', () => {
		expect(normalizeUrl('https://GitHub.COM/Wighawag/Foo')).toBe(
			'https://github.com/wighawag/foo',
		);
	});

	it('strips a trailing .git on git:// too', () => {
		expect(normalizeUrl('git://github.com/wighawag/foo.git')).toBe(
			'https://github.com/wighawag/foo',
		);
	});
});
