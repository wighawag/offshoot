/**
 * The CLI end to end, driven in-process through `main(argv)`: the argument
 * parsing is only worth anything if the command it feeds sees every value.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {main} from '../src/main.js';
import {
	cleanupTempDirs,
	commit,
	git,
	initRepo,
	setRemote,
	tempDir,
	writeFile,
} from './helpers.js';

afterEach(() => {
	vi.restoreAllMocks();
	cleanupTempDirs();
});

function url(name: string): string {
	return `https://github.com/test/${name}.git`;
}

function cloneChild(
	parent: string,
	src: string,
	name: string,
	parentUrl: string,
): string {
	git(['clone', src, name], parent);
	const dir = `${parent}/${name}`;
	setRemote(dir, 'origin', url(name));
	setRemote(dir, 'stem', parentUrl);
	return dir;
}

/** Run `main`, capturing what it prints. */
async function run(argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((...a) => {
		out.push(a.join(' '));
	});
	vi.spyOn(console, 'error').mockImplementation((...a) => {
		err.push(a.join(' '));
	});
	const code = await main(argv);
	vi.restoreAllMocks();
	return {code, out: out.join('\n'), err: err.join('\n')};
}

describe('offshoot-fanout CLI', () => {
	it('fanout --dry-run --repos A B C cascades over all three repos', async () => {
		const base = tempDir();
		const alpha = initRepo(base, 'alpha', {'file.txt': 'v1\n'});
		setRemote(alpha.dir, 'origin', url('alpha'));
		const bravo = cloneChild(base, alpha.dir, 'bravo', url('alpha'));
		const charlie = cloneChild(base, bravo, 'charlie', url('bravo'));
		writeFile(alpha.dir, 'file.txt', 'v2\n');
		commit(alpha.dir, 'change in alpha');

		// `--source` is what "run from A" means (it defaults to cwd), without
		// changing process-wide state.
		const {code, out, err} = await run([
			'fanout',
			'--source',
			alpha.dir,
			'--dry-run',
			'--no-color',
			'--repos',
			alpha.dir,
			bravo,
			charlie,
		]);

		expect(err).toBe('');
		expect(out).toContain('alpha@main');
		expect(out).toContain('bravo@main');
		expect(out).toContain('charlie@main');
		expect(code).toBe(0);
	});

	it('an unknown option exits 2 with a message, not a stack trace', async () => {
		const {code, err} = await run(['status', '--bogus']);
		expect(code).toBe(2);
		expect(err).toContain("Unknown option '--bogus'");
		expect(err).not.toMatch(/\n\s+at /);
	});

	it('a mistyped subcommand is named as one, with no --repos hint', async () => {
		const {code, err} = await run(['statuss', '--dry-run']);
		expect(code).toBe(2);
		expect(err).toMatch(/^Unknown subcommand `statuss`/);
		expect(err).not.toContain('--repos');
	});

	it('link with <parent> written after --to says to move it', async () => {
		const {code, err} = await run(['link', '--to', 'child', 'parent-url']);
		expect(code).toBe(1);
		expect(err).toContain('put <parent> before `--to`');
	});

	it('an unused argument exits non-zero and names it', async () => {
		const {code, err} = await run(['fanout', '--dry-run', 'stray']);
		expect(code).not.toBe(0);
		expect(err).toContain('`stray`');
		expect(err).toContain('did you mean `--repos stray`');
	});

	it('--help says each list option takes one or more values and repeats', async () => {
		const cases: [string, string][] = [
			['fanout', '--repos'],
			['fanout', '--ignore'],
			['discover', '--ignore'],
			['drift', '--ignore'],
			['status', '--ignore'],
			['link', '--to'],
		];
		for (const [sub, opt] of cases) {
			const {out} = await run([sub, '--help']);
			const line = out.split('\n').find((l) => l.trim().startsWith(opt));
			expect(line, `${sub} ${opt}`).toBeDefined();
			expect(line, `${sub} ${opt}`).toMatch(/one or more/);
			expect(line, `${sub} ${opt}`).toMatch(/repeatable/);
		}
	});
});
