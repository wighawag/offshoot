/**
 * `offshoot add`: adding an optional template feature.
 *
 * The mechanism is deliberately not new. A template publishes its features as
 * branches AND publishes the combinations it supports as branches, so adding a
 * feature is a switch to the branch that carries "what I have, plus that", and
 * the switch is the one `offshoot update --ref` has always done. What is new is
 * finding that branch, which needs the stem graph the maintainer already
 * declares for `offshoot-fanout` on the template's config branch.
 *
 * The fixture is jolly-roger's shape:
 *
 *   main
 *    └─ with/local-signer
 *        ├─ with/messaging
 *        ├─ with/sync
 *        └─ with/hosted-account
 *   with/all = messaging + sync + hosted-account (an integration branch)
 *
 * Note there is deliberately NO branch for "local-signer + messaging + sync":
 * a combination the template does not publish is a combination nobody built or
 * tested, and refusing it (with the supersets that do exist) is the point.
 */

import {afterAll, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scaffold} from '../src/commands/scaffold.js';
import {add} from '../src/commands/add.js';
import {
	addableFrom,
	featuresOf,
	parseBranchGraph,
	planAdd,
	resolveFeature,
} from '../src/features.js';
import type {OffshootState} from '../src/types.js';
import {
	cleanupTempDirs,
	createTemplateRepo,
	exists,
	git,
	quietLog,
	readFile,
	tempDir,
	writeFile,
} from './helpers.js';

afterAll(cleanupTempDirs);

const GRAPH = {
	branches: {
		main: {},
		'with/local-signer': {stem: 'main', feature: true},
		'with/messaging': {stem: 'with/local-signer', feature: true},
		'with/sync': {stem: 'with/local-signer', feature: true},
		'with/hosted-account': {stem: 'with/local-signer', feature: true},
		// An integration branch: it combines features, it is not one.
		'with/all': {
			stem: ['with/messaging', 'with/sync', 'with/hosted-account'],
		},
		// In the maintainer's cascade graph, but nothing a project adopts.
		website: {stem: 'main'},
	},
};

function stateOf(root: string): OffshootState {
	return JSON.parse(
		readFileSync(join(root, '.offshoot.json'), 'utf8'),
	) as OffshootState;
}

/**
 * Write the graph onto an orphan branch with plumbing, exactly as
 * `offshoot-fanout config set` does: no checkout, no working tree changes.
 */
function setGraph(dir: string, config: unknown, branch = 'offshoot'): void {
	const run = (args: string[], input?: string) =>
		execFileSync('git', args, {cwd: dir, input, encoding: 'utf8'}).trim();
	const blob = run(
		['hash-object', '-w', '--stdin'],
		`${JSON.stringify(config, null, 2)}\n`,
	);
	const tree = run(['mktree'], `100644 blob ${blob}\tfanout.config.json\n`);
	const commit = run(['commit-tree', tree, '-m', 'graph']);
	run(['update-ref', `refs/heads/${branch}`, commit]);
}

function featureTemplate() {
	const template = createTemplateRepo({
		'package.json': '{"name": "demo-template"}\n',
		'src/index.ts': 'export const NAME = "demo-template";\n',
	});
	const branch = (name: string, from: string, file: string) => {
		git(['checkout', '-q', '-b', name, from], template.dir);
		writeFile(template.dir, file, `export const from = "demo-template";\n`);
		template.commit(`${name}: initial`);
	};

	branch('with/local-signer', 'main', 'src/signer.ts');
	branch('with/messaging', 'with/local-signer', 'src/messaging.ts');
	branch('with/sync', 'with/local-signer', 'src/sync.ts');
	branch('with/hosted-account', 'with/local-signer', 'src/hosted.ts');

	git(['checkout', '-q', '-b', 'with/all', 'with/messaging'], template.dir);
	for (const other of ['with/sync', 'with/hosted-account']) {
		git(['merge', '--no-edit', '-m', `merge ${other}`, other], template.dir);
	}

	git(['checkout', '-q', 'main'], template.dir);
	setGraph(template.dir, GRAPH);
	return template;
}

async function scaffoldFrom(spec: string, name = 'my-app') {
	const cwd = tempDir('offshoot-work-');
	const result = await scaffold({
		template: spec,
		argv: [name],
		cwd,
		nonInteractive: true,
		log: quietLog,
	});
	git(['config', 'user.name', 'Test User'], result.dir);
	git(['config', 'user.email', 'user@example.com'], result.dir);
	return result;
}

describe('the branch graph (pure)', () => {
	const graph = parseBranchGraph(JSON.stringify(GRAPH), 'test');

	it('reads features off the stem graph, not off branch names', () => {
		expect([...featuresOf(graph, 'main')]).toEqual([]);
		expect([...featuresOf(graph, 'with/local-signer')].sort()).toEqual([
			'with/local-signer',
		]);
		// A feature carries its prerequisites, because its stem is one.
		expect([...featuresOf(graph, 'with/messaging')].sort()).toEqual([
			'with/local-signer',
			'with/messaging',
		]);
		// An integration branch declares nothing itself: it is exactly the union
		// of its stems.
		expect([...featuresOf(graph, 'with/all')].sort()).toEqual([
			'with/hosted-account',
			'with/local-signer',
			'with/messaging',
			'with/sync',
		]);
		// A branch in the cascade graph that is not a feature carries none.
		expect([...featuresOf(graph, 'website')]).toEqual([]);
	});

	it('offers only branches declared `feature: true`', () => {
		const plan = planAdd(graph, 'with/local-signer', 'website');
		expect(plan).toEqual({
			kind: 'not-a-feature',
			branch: 'website',
			candidates: [
				'with/local-signer',
				'with/messaging',
				'with/sync',
				'with/hosted-account',
			],
		});
		expect(
			addableFrom(graph, 'with/local-signer').map((a) => a.feature),
		).not.toContain('website');
	});

	it('refuses to call the base a feature', () => {
		expect(() =>
			parseBranchGraph(
				JSON.stringify({branches: {main: {feature: true}}}),
				'cfg',
			),
		).toThrow(/has no stem[\s\S]*cannot be an optional feature/);
		expect(() =>
			parseBranchGraph(
				JSON.stringify({
					branches: {main: {}, a: {stem: 'main', feature: 'yes'}},
				}),
				'cfg',
			),
		).toThrow(/must be true or false/);
	});

	it('resolves a bare last segment, but never a partial one', () => {
		expect(resolveFeature(graph, 'messaging')).toEqual({
			kind: 'found',
			branch: 'with/messaging',
		});
		expect(resolveFeature(graph, 'with/messaging')).toEqual({
			kind: 'found',
			branch: 'with/messaging',
		});
		// `messaging` must not match `with/foo-messaging`.
		const odd = parseBranchGraph(
			JSON.stringify({
				branches: {main: {}, 'with/foo-messaging': {stem: 'main'}},
			}),
			'test',
		);
		expect(resolveFeature(odd, 'messaging').kind).toBe('unknown');
	});

	it('reports an ambiguous last segment instead of guessing', () => {
		const two = parseBranchGraph(
			JSON.stringify({
				branches: {
					main: {},
					'with/messaging': {stem: 'main'},
					'legacy/messaging': {stem: 'main'},
				},
			}),
			'test',
		);
		expect(resolveFeature(two, 'messaging')).toEqual({
			kind: 'ambiguous',
			candidates: ['with/messaging', 'legacy/messaging'],
		});
	});

	it('plans a switch to the branch carrying exactly the wanted set', () => {
		expect(planAdd(graph, 'with/local-signer', 'messaging')).toEqual({
			kind: 'switch',
			feature: 'with/messaging',
			target: 'with/messaging',
			adds: ['with/messaging'],
		});
		// From the base, adding messaging brings its prerequisite too.
		expect(planAdd(graph, 'main', 'messaging')).toEqual({
			kind: 'switch',
			feature: 'with/messaging',
			target: 'with/messaging',
			adds: ['with/local-signer', 'with/messaging'],
		});
	});

	it('refuses a combination the template does not publish, and names the supersets', () => {
		const plan = planAdd(graph, 'with/messaging', 'sync');
		expect(plan.kind).toBe('no-combination');
		if (plan.kind !== 'no-combination') throw new Error('unreachable');
		expect(plan.wanted).toEqual([
			'with/local-signer',
			'with/messaging',
			'with/sync',
		]);
		// `with/all` itself is not listed as something it "also brings".
		expect(plan.supersets).toEqual([
			{branch: 'with/all', extra: ['with/hosted-account']},
		]);
	});

	it('knows what is already there', () => {
		expect(planAdd(graph, 'with/all', 'sync')).toEqual({
			kind: 'already-have',
			feature: 'with/sync',
			track: 'with/all',
		});
	});

	it('lists what a project can add, marking unpublished combinations', () => {
		expect(addableFrom(graph, 'with/local-signer')).toEqual([
			{
				feature: 'with/messaging',
				target: 'with/messaging',
				adds: ['with/messaging'],
			},
			{feature: 'with/sync', target: 'with/sync', adds: ['with/sync']},
			{
				feature: 'with/hosted-account',
				target: 'with/hosted-account',
				adds: ['with/hosted-account'],
			},
			// The integration branch stays discoverable: it is a reachable
			// combination even though it is not itself a feature.
			{
				feature: 'with/all',
				target: 'with/all',
				adds: ['with/hosted-account', 'with/messaging', 'with/sync'],
			},
		]);
		// From messaging, sync alone has no home.
		const fromMessaging = addableFrom(graph, 'with/messaging');
		expect(fromMessaging.find((a) => a.feature === 'with/sync')).toEqual({
			feature: 'with/sync',
			adds: ['with/sync'],
		});
	});

	it('rejects a graph that cannot mean anything', () => {
		expect(() =>
			parseBranchGraph(JSON.stringify({branches: {a: {stem: 'ghost'}}}), 'cfg'),
		).toThrow(/not listed in `branches`/);
		expect(() =>
			parseBranchGraph(
				JSON.stringify({branches: {a: {stem: 'b'}, b: {stem: 'a'}}}),
				'cfg',
			),
		).toThrow(/stem cycle/);
		expect(() => parseBranchGraph('{}', 'cfg')).toThrow(/no `branches`/);
	});
});

describe('offshoot add', () => {
	it('adds a feature by switching to the branch that carries it', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/local-signer`);

		expect(exists(project.dir, 'src/signer.ts')).toBe(true);
		expect(exists(project.dir, 'src/messaging.ts')).toBe(false);

		// The user's own work must survive it, like any other update.
		writeFile(project.dir, 'src/mine.ts', 'export const mine = 1;\n');
		git(['add', '-A'], project.dir);
		git(['commit', '--no-verify', '-m', 'my work'], project.dir);

		const result = await add({
			cwd: project.dir,
			feature: 'messaging',
			log: quietLog,
		});

		expect(result.kind).toBe('added');
		if (result.kind !== 'added') throw new Error('unreachable');
		expect(result.plan.target).toBe('with/messaging');
		expect(result.update.conflicted).toEqual([]);

		expect(exists(project.dir, 'src/messaging.ts')).toBe(true);
		expect(exists(project.dir, 'src/signer.ts')).toBe(true);
		expect(readFile(project.dir, 'src/mine.ts')).toBe(
			'export const mine = 1;\n',
		);
		// Transformed like everything else.
		expect(readFile(project.dir, 'src/messaging.ts')).toBe(
			'export const from = "my-app";\n',
		);
		// And the project now follows the feature branch.
		expect(stateOf(project.dir).track).toBe('with/messaging');
	});

	it('takes the full branch name too', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/local-signer`);
		const result = await add({
			cwd: project.dir,
			feature: 'with/sync',
			log: quietLog,
		});
		expect(result.kind).toBe('added');
		expect(stateOf(project.dir).track).toBe('with/sync');
	});

	it('brings prerequisites with it', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(template.dir); // on main
		expect(exists(project.dir, 'src/signer.ts')).toBe(false);

		await add({cwd: project.dir, feature: 'messaging', log: quietLog});

		expect(exists(project.dir, 'src/signer.ts')).toBe(true);
		expect(exists(project.dir, 'src/messaging.ts')).toBe(true);
	});

	it('refuses a combination that exists nowhere upstream', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/messaging`);

		await expect(
			add({cwd: project.dir, feature: 'sync', log: quietLog}),
		).rejects.toThrow(/publishes no branch carrying exactly/);
		await expect(
			add({cwd: project.dir, feature: 'sync', log: quietLog}),
		).rejects.toThrow(/with\/all \(also brings/);

		// Nothing happened.
		expect(exists(project.dir, 'src/sync.ts')).toBe(false);
		expect(stateOf(project.dir).track).toBe('with/messaging');
	});

	it('is a no-op when the project already has the feature', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/all`);
		const result = await add({
			cwd: project.dir,
			feature: 'sync',
			log: quietLog,
		});
		expect(result.kind).toBe('planned');
		expect(stateOf(project.dir).track).toBe('with/all');
	});

	it('--dry-run resolves the target and changes nothing', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/local-signer`);
		const result = await add({
			cwd: project.dir,
			feature: 'messaging',
			dryRun: true,
			log: quietLog,
		});
		expect(result.kind).toBe('planned');
		expect(exists(project.dir, 'src/messaging.ts')).toBe(false);
		expect(stateOf(project.dir).track).toBe('with/local-signer');
	});

	it('with no argument, lists what can be added', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/local-signer`);
		const result = await add({cwd: project.dir, log: quietLog});

		expect(result.kind).toBe('listed');
		if (result.kind !== 'listed') throw new Error('unreachable');
		expect(result.track).toBe('with/local-signer');
		expect(result.features).toEqual(['with/local-signer']);
		expect(result.addable.map((a) => a.feature)).toEqual([
			'with/messaging',
			'with/sync',
			'with/hosted-account',
			'with/all',
		]);
	});

	it('will not adopt a branch the template did not declare a feature', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/local-signer`);
		await expect(
			add({cwd: project.dir, feature: 'website', log: quietLog}),
		).rejects.toThrow(
			/not an optional feature[\s\S]*Available: with\/local-signer/,
		);
	});

	it('names the alternatives when the feature does not exist', async () => {
		const template = featureTemplate();
		const project = await scaffoldFrom(`${template.dir}#with/local-signer`);
		await expect(
			add({cwd: project.dir, feature: 'nope', log: quietLog}),
		).rejects.toThrow(/no feature "nope"[\s\S]*Available: with\/local-signer/);
	});

	it('says what is missing when the template publishes no graph', async () => {
		const template = createTemplateRepo({
			'package.json': '{"name": "demo-template"}\n',
		});
		const project = await scaffoldFrom(template.dir);
		await expect(
			add({cwd: project.dir, feature: 'messaging', log: quietLog}),
		).rejects.toThrow(/has no "offshoot" branch/);
	});

	it('reports a graph the template cannot mean', async () => {
		const template = featureTemplate();
		setGraph(template.dir, {branches: {'with/x': {stem: 'gone'}}});
		const project = await scaffoldFrom(`${template.dir}#with/local-signer`);
		await expect(
			add({cwd: project.dir, feature: 'x', log: quietLog}),
		).rejects.toThrow(/not listed in `branches`/);
	});
});
