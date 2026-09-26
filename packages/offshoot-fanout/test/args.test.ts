/**
 * List-valued options take every following value, and nothing is dropped.
 *
 * `node:util` `parseArgs` reads `multiple: true` as REPEATABLE, so
 * `--repos a b c` used to keep `a` and turn `b` and `c` into positionals that
 * `fanout` never reads: a cascade over one repo, reported as a clean run.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {parseCommand} from '../src/args.js';
import {cleanupTempDirs, initRepo, tempDir} from './helpers.js';

afterEach(cleanupTempDirs);

describe('list options consume every value up to the next `--` option', () => {
	it('--repos a b c yields three repos', () => {
		const {values} = parseCommand('fanout', ['--repos', 'a', 'b', 'c']);
		expect(values.repos).toEqual(['a', 'b', 'c']);
	});

	it('--repos a --repos b yields two (the repeated form still concatenates)', () => {
		const {values} = parseCommand('fanout', ['--repos', 'a', '--repos', 'b']);
		expect(values.repos).toEqual(['a', 'b']);
	});

	it('--repos a b --dry-run yields two, with dry-run set', () => {
		const {values} = parseCommand('fanout', ['--repos', 'a', 'b', '--dry-run']);
		expect(values.repos).toEqual(['a', 'b']);
		expect(values['dry-run']).toBe(true);
	});

	it('mixes both forms, and the inline `--repos=a` form too', () => {
		const {values} = parseCommand('fanout', [
			'--repos=a',
			'b',
			'--verify',
			'--repos',
			'c',
			'd',
		]);
		expect(values.repos).toEqual(['a', 'b', 'c', 'd']);
		expect(values.verify).toBe(true);
	});

	it('--ignore x y z yields three, on every command that has it', () => {
		for (const sub of ['fanout', 'drift', 'status', 'discover']) {
			const {values} = parseCommand(sub, ['--ignore', 'x', 'y', 'z']);
			expect(values.ignore, sub).toEqual(['x', 'y', 'z']);
		}
	});

	it('--ignore x --ignore y yields two', () => {
		const {values} = parseCommand('fanout', ['--ignore', 'x', '--ignore', 'y']);
		expect(values.ignore).toEqual(['x', 'y']);
	});

	it('--ignore x y --no-color yields two, with no-color set', () => {
		const {values} = parseCommand('status', [
			'--ignore',
			'x',
			'y',
			'--no-color',
		]);
		expect(values.ignore).toEqual(['x', 'y']);
		expect(values['no-color']).toBe(true);
	});

	it('a positional before the list option stays a positional', () => {
		const {values, positionals} = parseCommand('drift', [
			'folder',
			'--ignore',
			'x',
			'y',
		]);
		expect(positionals).toEqual(['folder']);
		expect(values.ignore).toEqual(['x', 'y']);
	});

	it('link <parent> --to a b c yields three children and keeps the parent', () => {
		const {values, positionals} = parseCommand('link', [
			'parent-url',
			'--to',
			'a',
			'b',
			'c',
		]);
		expect(positionals).toEqual(['parent-url']);
		expect(values.to).toEqual(['a', 'b', 'c']);
	});

	it('--to a --to b yields two', () => {
		const {values} = parseCommand('link', ['p', '--to', 'a', '--to', 'b']);
		expect(values.to).toEqual(['a', 'b']);
	});

	it('--to a b --no-color yields two, with no-color set', () => {
		const {values} = parseCommand('link', [
			'p',
			'--to',
			'a',
			'b',
			'--no-color',
		]);
		expect(values.to).toEqual(['a', 'b']);
		expect(values['no-color']).toBe(true);
	});
});

describe('an argument no command reads is an error, never dropped', () => {
	it('fanout rejects a bare positional and suggests --repos', () => {
		expect(() => parseCommand('fanout', ['a', 'b', 'c'])).toThrow(
			/unused argument\(s\): `a` `b` `c`.*did you mean `--repos a b c`/s,
		);
	});

	it('a positional stranded after a boolean flag names it', () => {
		expect(() =>
			parseCommand('fanout', ['--repos', 'a', '--dry-run', 'b']),
		).toThrow(/`b`.*did you mean `--repos b`/s);
	});

	it('an unused positional on an --ignore command is named', () => {
		expect(() => parseCommand('fanout', ['--verify', 'x'])).toThrow(/`x`/);
		expect(() => parseCommand('drift', ['folder', 'x', 'y'])).toThrow(
			/unused argument\(s\): `x` `y`.*did you mean `--ignore x y`/s,
		);
		expect(() => parseCommand('status', ['folder', 'x'])).toThrow(/`x`/);
	});

	it('link keeps <parent> and rejects extras, suggesting --to', () => {
		expect(() => parseCommand('link', ['parent-url', 'a', 'b'])).toThrow(
			/unused argument\(s\): `a` `b`.*did you mean `--to a b`/s,
		);
	});

	it('a single-valued option followed by extra values says it takes one', () => {
		expect(() =>
			parseCommand('backport', ['sha', '--from', 'x', '--to', 'a', 'b']),
		).toThrow(/`b`.*`--to` takes a single value/s);
	});

	it('commands with fixed positionals keep them and reject extras', () => {
		expect(
			parseCommand('backport', ['sha', '--from', 'x']).positionals,
		).toEqual(['sha']);
		expect(() =>
			parseCommand('backport', ['sha', 'extra', '--from', 'x']),
		).toThrow(/`extra`/);
		expect(parseCommand('discover', ['folder']).positionals).toEqual([
			'folder',
		]);
		expect(() => parseCommand('discover', ['folder', 'extra'])).toThrow(
			/`extra`/,
		);
		expect(
			parseCommand('rename-remote', ['from', 'to', 'folder']).positionals,
		).toEqual(['from', 'to', 'folder']);
		expect(() =>
			parseCommand('rename-remote', ['from', 'to', 'folder', 'extra']),
		).toThrow(/`extra`/);
		expect(() => parseCommand('clone', ['o/n', 'extra'])).toThrow(/`extra`/);
		expect(() => parseCommand('config', ['show', 'extra'])).toThrow(/`extra`/);
		expect(() => parseCommand('skills', ['install', 'extra'])).toThrow(
			/`extra`/,
		);
	});
});

describe('a positional after a list option belongs to the list', () => {
	it('drift --ignore x folder makes folder an ignore entry', () => {
		const {values, positionals} = parseCommand('drift', [
			'--ignore',
			'x',
			'no-such-path',
		]);
		expect(values.ignore).toEqual(['x', 'no-such-path']);
		expect(positionals).toEqual([]);
	});

	it('`--` ends the list, so drift --ignore x -- folder keeps the folder', () => {
		const {values, positionals} = parseCommand('drift', [
			'--ignore',
			'x',
			'--',
			'folder',
		]);
		expect(values.ignore).toEqual(['x']);
		expect(positionals).toEqual(['folder']);
	});

	it('a swallowed folder (a directory that is not a repo) is an error, not a scan of cwd', () => {
		const work = tempDir();
		for (const sub of ['discover', 'drift', 'status']) {
			expect(() => parseCommand(sub, ['--ignore', 'old', work]), sub).toThrow(
				new RegExp(
					`\`${work}\` was read as an \`--ignore\` value.*did you mean \`${sub} ${work} --ignore old\``,
					's',
				),
			);
		}
	});

	it('ignoring a real repo by path, or naming the folder explicitly, is fine', () => {
		const base = tempDir();
		const repo = initRepo(base, 'old');
		expect(
			parseCommand('discover', ['--ignore', repo.dir]).values.ignore,
		).toEqual([repo.dir]);
		expect(
			parseCommand('discover', [base, '--ignore', base]).positionals,
		).toEqual([base]);
	});
});
