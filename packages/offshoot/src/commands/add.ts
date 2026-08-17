/**
 * `offshoot add [<feature>]`
 *
 * A template that ships optional features publishes them as branches, and
 * publishes the combinations it supports as branches too (`with/all`). Adding
 * a feature is therefore not a new merge mechanism: it is `offshoot update
 * --ref <the branch that carries what I have plus that feature>`, which is the
 * switch that has always worked. All this command adds is finding that branch.
 *
 * It matters that the target is a real, published branch: something upstream
 * built and tested that combination. A project is never handed a combination
 * nobody has ever run.
 *
 * With no argument it lists what can be added, so discovery is the command
 * itself rather than a wrong guess and an error message.
 */

import {readFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {Logger} from '../types.js';
import {createLogger} from '../logger.js';
import {parseSource, resolveRef, downloadTemplate} from '../source.js';
import {
	type Addable,
	type AddPlan,
	type BranchGraph,
	DEFAULT_GRAPH_BRANCH,
	GRAPH_FILE,
	addableFrom,
	featuresOf,
	isRoot,
	knownBranches,
	parseBranchGraph,
	planAdd,
} from '../features.js';
import {openProject} from './common.js';
import {update, type UpdateResult} from './update.js';

export interface AddOptions {
	cwd: string;
	/** Branch name, or its last segment. Omit to list what can be added. */
	feature?: string;
	/** Resolve and report, change nothing. */
	dryRun?: boolean;
	force?: boolean;
	/** Template branch holding the graph. Default `offshoot`. */
	graphBranch?: string;
	log?: Logger;
}

export type AddResult =
	| {kind: 'listed'; track: string; features: string[]; addable: Addable[]}
	| {kind: 'planned'; plan: AddPlan}
	| {
			kind: 'added';
			plan: Extract<AddPlan, {kind: 'switch'}>;
			update: UpdateResult;
	  };

export async function add(options: AddOptions): Promise<AddResult> {
	const log = options.log ?? createLogger();
	const project = openProject(resolve(options.cwd));
	const {root, state} = project;

	const graphBranch = options.graphBranch ?? DEFAULT_GRAPH_BRANCH;
	const graph = await fetchGraph(state.template, graphBranch);
	const track = trackOf(state.track, graph, log);

	if (options.feature === undefined) {
		const features = [...featuresOf(graph, track)].sort();
		const addable = addableFrom(graph, track);
		report(log, track, features, addable);
		return {kind: 'listed', track, features, addable};
	}

	const plan = planAdd(graph, track, options.feature);
	if (plan.kind !== 'switch') {
		if (plan.kind === 'already-have') {
			log.info(`Already on ${plan.feature} (tracking ${plan.track}).`);
			return {kind: 'planned', plan};
		}
		throw new Error(explain(plan));
	}

	const brings = plan.adds.filter((f) => f !== plan.feature);
	log.info(
		brings.length > 0
			? `Switching to ${plan.target}, bringing ${brings.join(', ')}.`
			: `Switching to ${plan.target}.`,
	);
	if (options.dryRun) {
		log.info(`--dry-run: would run \`offshoot update --ref ${plan.target}\`.`);
		return {kind: 'planned', plan};
	}

	const result = await update({
		cwd: root,
		ref: plan.target,
		force: options.force,
		log,
	});
	return {kind: 'added', plan, update: result};
}

/**
 * The graph is read from the template's config branch, the same file
 * `offshoot-fanout` already maintains, so the maintainer declares the stem
 * graph once and the template's working tree still carries no offshoot file.
 *
 * The branch is an orphan holding one small file, so fetching it costs about
 * as much as a `ls-remote` plus a tiny tarball.
 */
async function fetchGraph(
	template: string,
	graphBranch: string,
): Promise<BranchGraph> {
	const source = parseSource(template);
	let sha: string;
	try {
		sha = (await resolveRef(source, graphBranch)).sha;
	} catch {
		throw new Error(
			`${template} has no "${graphBranch}" branch, so it does not declare which branch carries which feature.\n` +
				`\`offshoot add\` needs that graph: it is \`${GRAPH_FILE}\` on the template's config branch, ` +
				`written by \`offshoot-fanout config set\`.\n` +
				`Without it, switch by hand: \`offshoot update --ref <branch>\`.`,
		);
	}

	const dir = await downloadTemplate(source, sha);
	try {
		let text: string;
		try {
			text = readFileSync(join(dir, GRAPH_FILE), 'utf8');
		} catch {
			throw new Error(
				`Branch "${graphBranch}" of ${template} has no ${GRAPH_FILE}.\n` +
					`That branch name is an ordinary word, so this is most likely a name collision rather than a broken config.`,
			);
		}
		return parseBranchGraph(text, `${template}#${graphBranch}:${GRAPH_FILE}`);
	} finally {
		try {
			rmSync(dir, {recursive: true, force: true});
		} catch {
			/* temp dir, best effort */
		}
	}
}

/**
 * A project scaffolded from the template's default branch may have no `track`
 * recorded. A graph with exactly one root says what that was, unambiguously.
 */
function trackOf(
	track: string | undefined,
	graph: BranchGraph,
	log: Logger,
): string {
	if (track) return track;
	const roots = knownBranches(graph).filter((b) => isRoot(graph, b));
	if (roots.length === 1) {
		log.debug(
			`No tracked branch recorded; assuming the graph root ${roots[0]}.`,
		);
		return roots[0]!;
	}
	throw new Error(
		`This project records no tracked branch, and the template has ${roots.length} root branches ` +
			`(${roots.join(', ')}), so there is no way to tell which one it came from.\n` +
			`Run \`offshoot update --ref <branch>\` once to pin it.`,
	);
}

function report(
	log: Logger,
	track: string,
	features: string[],
	addable: Addable[],
): void {
	log.info(`Tracking ${track}.`);
	log.info(
		features.length > 0
			? `  has: ${features.join(', ')}`
			: '  has: nothing beyond the base',
	);
	if (addable.length === 0) {
		log.info('  nothing left to add.');
		return;
	}
	log.info('');
	log.info('Can add:');
	for (const entry of addable) {
		const extra = entry.adds.filter((f) => f !== entry.feature);
		const withText =
			extra.length > 0 ? ` (also brings ${extra.join(', ')})` : '';
		log.info(
			entry.target
				? `  ${entry.feature}${withText} -> ${entry.target}`
				: `  ${entry.feature}${withText} - no published branch for that combination`,
		);
	}
}

function available(candidates: string[]): string {
	return candidates.length > 0
		? `Available: ${candidates.join(', ')}.`
		: 'The template declares no features at all.';
}

/** The message IS the feature for every plan that cannot proceed. */
export function explain(plan: AddPlan): string {
	switch (plan.kind) {
		case 'unknown-feature':
			return (
				`The template has no feature "${plan.feature}".\n` +
				available(plan.candidates)
			);
		case 'not-a-feature':
			return (
				`"${plan.branch}" is a branch of the template, but not an optional feature ` +
				`a project adopts (it is not marked \`"feature": true\` in the template's graph).\n` +
				available(plan.candidates)
			);
		case 'ambiguous-feature':
			return (
				`"${plan.feature}" is ambiguous: ${plan.candidates.join(', ')}.\n` +
				`Use the full branch name.`
			);
		case 'unknown-track':
			return (
				`This project follows "${plan.track}", which the template's graph does not list ` +
				`(it has: ${plan.candidates.join(', ')}).\n` +
				`The branch was probably renamed or removed upstream.`
			);
		case 'ambiguous-target':
			return (
				`Several branches carry exactly ${plan.wanted.join(' + ')}: ${plan.targets.join(', ')}.\n` +
				`Pick one with \`offshoot update --ref <branch>\`.`
			);
		case 'no-combination': {
			const lines = [
				`The template publishes no branch carrying exactly ${plan.wanted.join(' + ')}.`,
				`Adding ${plan.feature} to this project would need that combination to exist upstream, ` +
					`where it can be built and tested.`,
			];
			if (plan.supersets.length > 0) {
				lines.push('', 'Branches that carry it, plus more:');
				for (const s of plan.supersets) {
					lines.push(`  ${s.branch} (also brings ${s.extra.join(', ')})`);
				}
				lines.push('', `Switch with \`offshoot update --ref <branch>\`.`);
			} else {
				lines.push('', 'Ask the template to publish it.');
			}
			return lines.join('\n');
		}
		case 'already-have':
			return `Already on ${plan.feature} (tracking ${plan.track}).`;
		case 'switch':
			return `${plan.feature} lives on ${plan.target}.`;
	}
}
