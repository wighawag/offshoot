/**
 * The template's branch graph, seen from a PROJECT.
 *
 * A template that ships optional features publishes them as branches: a base
 * (`main`), one branch per feature, and one branch per combination it is
 * willing to support. Which branch contains which features is not derivable
 * from the names - it is the `stem` graph the maintainer already declares for
 * `offshoot-fanout`, on the template's config branch. So that is what is read
 * here, and nothing in this file knows about any naming convention.
 *
 * Everything below is pure: a graph in, a plan out. All I/O lives in
 * `commands/add.ts`, so the interesting judgement (which branch has exactly
 * the feature set I want) is testable without a network or a repository.
 */

/** Branch holding the template's graph. Matches `offshoot-fanout`'s default. */
export const DEFAULT_GRAPH_BRANCH = 'offshoot';

/** File read from that branch. Matches `offshoot-fanout`'s. */
export const GRAPH_FILE = 'fanout.config.json';

export interface BranchGraph {
	/** branch -> its stems in config order. Every stem is itself a key. */
	stems: Map<string, string[]>;
	/**
	 * Branches marked `"feature": true`: the optional features a project can
	 * adopt. Opt-in, because the graph is the MAINTAINER's cascade graph and
	 * most of what is in it is not a feature - a `website` branch, a docs
	 * branch, an integration branch that only combines others. Defaulting to
	 * "every non-root branch is a feature" offers projects things that were
	 * never meant to be adopted.
	 */
	features: Set<string>;
}

/**
 * Parse `fanout.config.json`.
 *
 * Stricter than fanout's own reader on one point: a stem naming a branch that
 * is not in `branches` is rejected. fanout can tolerate that (the branch is
 * simply not a node); here it would silently shrink a feature set and send the
 * project to the wrong branch.
 */
export function parseBranchGraph(text: string, origin: string): BranchGraph {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`${origin} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${origin} must be a JSON object.`);
	}
	const branches = (raw as Record<string, unknown>).branches;
	if (branches === undefined) {
		throw new Error(
			`${origin} has no \`branches\`, so the template does not declare which branch contains which feature.`,
		);
	}
	if (
		branches === null ||
		typeof branches !== 'object' ||
		Array.isArray(branches)
	) {
		throw new Error(`${origin}: \`branches\` must be an object.`);
	}

	const stems = new Map<string, string[]>();
	const features = new Set<string>();
	for (const [name, value] of Object.entries(
		branches as Record<string, unknown>,
	)) {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`${origin}: \`branches.${name}\` must be an object.`);
		}
		const entry = value as Record<string, unknown>;

		const stem = entry.stem;
		if (stem === undefined) {
			stems.set(name, []);
		} else {
			const list = Array.isArray(stem) ? stem : [stem];
			if (list.length === 0 || !list.every((s) => typeof s === 'string')) {
				throw new Error(
					`${origin}: \`branches.${name}.stem\` must be a branch name or a non-empty array of them.`,
				);
			}
			stems.set(name, list as string[]);
		}

		if (entry.feature !== undefined) {
			if (typeof entry.feature !== 'boolean') {
				throw new Error(
					`${origin}: \`branches.${name}.feature\` must be true or false.`,
				);
			}
			if (entry.feature) {
				if (stem === undefined) {
					throw new Error(
						`${origin}: \`branches.${name}\` has no stem, so it is the base every project already has, and cannot be an optional feature.`,
					);
				}
				features.add(name);
			}
		}
	}

	for (const [name, list] of stems) {
		for (const stem of list) {
			if (!stems.has(stem)) {
				throw new Error(
					`${origin}: \`branches.${name}.stem\` names "${stem}", which is not listed in \`branches\`.`,
				);
			}
		}
	}

	const graph: BranchGraph = {stems, features};
	for (const name of stems.keys()) assertAcyclic(graph, name, origin);
	return graph;
}

function assertAcyclic(
	graph: BranchGraph,
	start: string,
	origin: string,
): void {
	const path: string[] = [];
	const seen = new Set<string>();
	const walk = (branch: string): void => {
		if (path.includes(branch)) {
			throw new Error(
				`${origin}: stem cycle: ${[...path.slice(path.indexOf(branch)), branch].join(' -> ')}.`,
			);
		}
		if (seen.has(branch)) return;
		path.push(branch);
		for (const stem of graph.stems.get(branch) ?? []) walk(stem);
		path.pop();
		seen.add(branch);
	};
	walk(start);
}

export function knownBranches(graph: BranchGraph): string[] {
	return [...graph.stems.keys()];
}

/** A branch with no stem: the base everything else is built on. */
export function isRoot(graph: BranchGraph, branch: string): boolean {
	return (graph.stems.get(branch) ?? []).length === 0;
}

/** Declared adoptable with `"feature": true`. */
export function isFeature(graph: BranchGraph, branch: string): boolean {
	return graph.features.has(branch);
}

export function featureBranches(graph: BranchGraph): string[] {
	return knownBranches(graph).filter((name) => isFeature(graph, name));
}

/**
 * The features a branch carries: every DECLARED feature among itself and the
 * branches it transitively stems from. A branch that stems from a feature
 * carries that feature too, which is what makes "add messaging" pull in
 * local-signer without anyone saying so; and a branch that declares nothing
 * itself (a base, an integration branch, a `website` branch) contributes
 * exactly the union of its stems.
 */
export function featuresOf(graph: BranchGraph, branch: string): Set<string> {
	const out = new Set<string>();
	const seen = new Set<string>();
	const walk = (name: string): void => {
		if (seen.has(name)) return;
		seen.add(name);
		if (isFeature(graph, name)) out.add(name);
		for (const stem of graph.stems.get(name) ?? []) walk(stem);
	};
	walk(branch);
	return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

function sorted(set: Set<string>): string[] {
	return [...set].sort();
}

/**
 * Resolve what the user typed to a branch.
 *
 * Exact branch name first, then a unique match on the LAST path segment, so
 * `messaging` finds `with/messaging` without this file ever knowing that
 * `with/` exists. Matching the segment rather than the suffix is what keeps
 * `messaging` from also matching `with/foo-messaging`.
 */
export type FeatureLookup =
	| {kind: 'found'; branch: string}
	| {kind: 'unknown'; candidates: string[]}
	| {kind: 'ambiguous'; candidates: string[]};

export function resolveFeature(
	graph: BranchGraph,
	request: string,
): FeatureLookup {
	if (graph.stems.has(request)) return {kind: 'found', branch: request};

	const matches = knownBranches(graph).filter((name) => {
		const cut = name.lastIndexOf('/');
		return (cut === -1 ? name : name.slice(cut + 1)) === request;
	});
	if (matches.length === 1) return {kind: 'found', branch: matches[0]!};
	if (matches.length > 1) return {kind: 'ambiguous', candidates: matches};
	return {kind: 'unknown', candidates: featureBranches(graph)};
}

export interface Superset {
	branch: string;
	/**
	 * Features it would bring that were not asked for. The branch itself is
	 * never listed: switching to `with/all` trivially brings `with/all`, and
	 * saying so in the refusal message is noise.
	 */
	extra: string[];
}

export type AddPlan =
	/** Exactly one branch carries the wanted set: switch the project to it. */
	| {kind: 'switch'; feature: string; target: string; adds: string[]}
	/** The project already has it. */
	| {kind: 'already-have'; feature: string; track: string}
	/** A real branch, but not one a project adopts (no `"feature": true`). */
	| {kind: 'not-a-feature'; branch: string; candidates: string[]}
	/** No published branch carries exactly that combination. */
	| {
			kind: 'no-combination';
			feature: string;
			wanted: string[];
			supersets: Superset[];
	  }
	/** Several branches carry it; the template has to say which is canonical. */
	| {
			kind: 'ambiguous-target';
			feature: string;
			wanted: string[];
			targets: string[];
	  }
	| {kind: 'unknown-feature'; feature: string; candidates: string[]}
	| {kind: 'ambiguous-feature'; feature: string; candidates: string[]}
	/** The branch the project follows is not in the graph at all. */
	| {kind: 'unknown-track'; track: string; candidates: string[]};

/**
 * Adding a feature is never a merge of two branches: it is a switch to the one
 * branch that already carries everything the project has PLUS the new feature.
 * That branch was built and tested upstream, which is exactly why the project
 * is allowed to want it.
 */
export function planAdd(
	graph: BranchGraph,
	track: string,
	request: string,
): AddPlan {
	if (!graph.stems.has(track)) {
		return {
			kind: 'unknown-track',
			track,
			candidates: knownBranches(graph),
		};
	}

	const lookup = resolveFeature(graph, request);
	if (lookup.kind === 'unknown') {
		return {
			kind: 'unknown-feature',
			feature: request,
			candidates: lookup.candidates,
		};
	}
	if (lookup.kind === 'ambiguous') {
		return {
			kind: 'ambiguous-feature',
			feature: request,
			candidates: lookup.candidates,
		};
	}

	const feature = lookup.branch;
	const current = featuresOf(graph, track);
	const wanted = new Set([...current, ...featuresOf(graph, feature)]);

	if (sameSet(wanted, current)) {
		// Nothing to add. Either the project has it, or the branch is not
		// something a project adopts at all - a distinction worth making, since
		// "already on website" would be nonsense.
		return isFeature(graph, feature)
			? {kind: 'already-have', feature, track}
			: {
					kind: 'not-a-feature',
					branch: feature,
					candidates: featureBranches(graph),
				};
	}

	const targets = knownBranches(graph).filter((name) =>
		sameSet(featuresOf(graph, name), wanted),
	);
	if (targets.length === 1) {
		const adds = sorted(wanted).filter((f) => !current.has(f));
		return {kind: 'switch', feature, target: targets[0]!, adds};
	}
	if (targets.length > 1) {
		return {
			kind: 'ambiguous-target',
			feature,
			wanted: sorted(wanted),
			targets,
		};
	}

	const supersets: Superset[] = knownBranches(graph)
		.filter((name) => isSubset(wanted, featuresOf(graph, name)))
		.map((name) => ({
			branch: name,
			extra: sorted(featuresOf(graph, name)).filter(
				(f) => !wanted.has(f) && f !== name,
			),
		}))
		.sort((a, b) => a.extra.length - b.extra.length);

	return {kind: 'no-combination', feature, wanted: sorted(wanted), supersets};
}

export interface Addable {
	feature: string;
	/** The branch to switch to, when the template publishes that combination. */
	target?: string;
	/** What switching would bring in, including prerequisites. */
	adds: string[];
}

/**
 * What this project could add. Used by `offshoot add` with no argument, so
 * discovery is the command itself rather than a wrong guess and an error.
 */
export function addableFrom(graph: BranchGraph, track: string): Addable[] {
	if (!graph.stems.has(track)) return [];
	const current = featuresOf(graph, track);
	const out: Addable[] = [];
	for (const feature of knownBranches(graph)) {
		if (isRoot(graph, feature) || current.has(feature)) continue;
		// planAdd rejects anything that adds nothing, so a branch that is not a
		// feature and combines none of them (`website`) drops out here rather
		// than being offered as something to adopt.
		const plan = planAdd(graph, track, feature);
		if (plan.kind === 'switch') {
			out.push({feature, target: plan.target, adds: plan.adds});
		} else if (plan.kind === 'no-combination') {
			out.push({
				feature,
				adds: plan.wanted.filter((f) => !current.has(f)),
			});
		}
	}
	return out;
}
