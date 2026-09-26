/**
 * Argument parsing for every subcommand, in one place, so a parsing rule is a
 * rule for the whole CLI rather than something each command re-implements.
 */
import {existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {DEFAULT_CONFIG_BRANCH, DEFAULT_REMOTE} from './index.js';

export type OptDesc =
	| {
			type: 'string';
			short?: string;
			multiple?: boolean;
			default?: string | string[];
	  }
	| {type: 'boolean'; short?: string; default?: boolean};

export interface CommandSpec {
	options: Record<string, OptDesc>;
	/**
	 * How many positionals the command actually reads, and what they are.
	 * `folder`: the first one is an optional folder to scan, defaulting to cwd.
	 */
	positionals: {max: number; names: string; folder?: boolean};
	/** The list option an unconsumed positional most likely belonged to. */
	hint?: string;
}

export const COMMANDS: Record<string, CommandSpec> = {
	fanout: {
		options: {
			source: {type: 'string'},
			'base-dir': {type: 'string'},
			repos: {type: 'string', multiple: true},
			registry: {type: 'string'},
			branch: {type: 'string'},
			remote: {type: 'string', default: DEFAULT_REMOTE},
			'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
			'no-config': {type: 'boolean', default: false},
			verify: {type: 'boolean', default: false},
			ignore: {type: 'string', multiple: true},
			'dry-run': {type: 'boolean', default: false},
			'leave-conflicts': {type: 'boolean', default: false},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 0, names: ''},
		hint: 'repos',
	},
	discover: {
		options: {
			remote: {type: 'string', default: DEFAULT_REMOTE},
			'add-remotes': {type: 'boolean', default: false},
			root: {type: 'string'},
			yes: {type: 'boolean', default: false},
			save: {type: 'boolean', default: false},
			ignore: {type: 'string', multiple: true},
			'dry-run': {type: 'boolean', default: false},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '[folder]', folder: true},
		hint: 'ignore',
	},
	link: {
		options: {
			remote: {type: 'string', default: DEFAULT_REMOTE},
			to: {type: 'string', multiple: true},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '<parent>'},
		hint: 'to',
	},
	'rename-remote': {
		options: {
			'dry-run': {type: 'boolean', default: false},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 3, names: '<from> <to> [folder]'},
	},
	drift: {
		options: {
			registry: {type: 'string'},
			remote: {type: 'string', default: DEFAULT_REMOTE},
			branch: {type: 'string'},
			'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
			'no-config': {type: 'boolean', default: false},
			ignore: {type: 'string', multiple: true},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '[folder]', folder: true},
		hint: 'ignore',
	},
	backport: {
		options: {
			from: {type: 'string'},
			to: {type: 'string'},
			registry: {type: 'string'},
			remote: {type: 'string', default: DEFAULT_REMOTE},
			branch: {type: 'string'},
			cascade: {type: 'boolean', default: false},
			'dry-run': {type: 'boolean', default: false},
			'leave-conflicts': {type: 'boolean', default: false},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '<commit>'},
	},
	status: {
		options: {
			registry: {type: 'string'},
			remote: {type: 'string', default: DEFAULT_REMOTE},
			branch: {type: 'string'},
			'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
			'no-config': {type: 'boolean', default: false},
			ignore: {type: 'string', multiple: true},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '[folder]', folder: true},
		hint: 'ignore',
	},
	config: {
		options: {
			repo: {type: 'string'},
			file: {type: 'string'},
			set: {type: 'string'},
			root: {type: 'boolean', default: false},
			'from-remote': {type: 'boolean', default: false},
			remote: {type: 'string', default: DEFAULT_REMOTE},
			'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
			'no-config': {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '[show|set|stem]'},
	},
	clone: {
		options: {
			dir: {type: 'string'},
			remote: {type: 'string', default: DEFAULT_REMOTE},
			'config-branch': {type: 'string', default: DEFAULT_CONFIG_BRANCH},
			protocol: {type: 'string'},
			'prefer-https': {type: 'boolean', default: false},
			'require-auth': {type: 'boolean', default: false},
			'no-branches': {type: 'boolean', default: false},
			'dry-run': {type: 'boolean', default: false},
			'no-color': {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '<owner/name>'},
	},
	skills: {
		options: {
			project: {type: 'boolean', default: false},
		},
		positionals: {max: 1, names: '[list|install]'},
	},
};

/** A command line that cannot be read as written. The CLI prints it and exits 2. */
export class UsageError extends Error {
	override name = 'UsageError';
}

/**
 * Parse `rest` against `spec`, with two rules `parseArgs` does not have:
 *
 * 1. A LIST option (`multiple: true`) takes every following argument up to the
 *    next one starting with `--`, so `--repos a b c` is three repos. `parseArgs`
 *    reads `multiple` as "repeatable" only, which kept `a` and turned `b` and `c`
 *    into positionals. The repeated form (`--repos a --repos b`) still works and
 *    concatenates. `--` ends a list like any other `--` argument.
 * 2. A positional the command does not read is a UsageError naming it. An
 *    argument the user typed is never silently ignored.
 */
export function parseOpts(
	sub: string,
	rest: string[],
	spec: CommandSpec,
): {
	values: Record<string, unknown>;
	positionals: string[];
} {
	let r;
	try {
		r = parseArgs({
			options: spec.options,
			args: rest,
			strict: true,
			allowPositionals: true,
			tokens: true,
		});
	} catch (e) {
		throw new UsageError(
			`${sub}: ${e instanceof Error ? e.message : String(e)}\nSee \`offshoot-fanout ${sub} --help\`.`,
		);
	}

	const values = {...r.values} as Record<string, unknown>;
	// Lists are rebuilt from the tokens, so values keep command-line order
	// (`--repos a b --repos c` is a, b, c).
	const lists = new Map<string, string[]>();
	const positionals: {value: string; after: string | null}[] = [];
	// The option a bare argument would belong to: the last list option seen,
	// until any other option (or `--`) closes it.
	let list: string[] | null = null;
	let lastOption: string | null = null;
	for (const token of r.tokens) {
		if (token.kind === 'option') {
			const desc = spec.options[token.name];
			lastOption = token.name;
			list = null;
			if (desc?.type === 'string' && desc.multiple) {
				list = lists.get(token.name) ?? [];
				lists.set(token.name, list);
				if (token.value !== undefined) list.push(token.value);
			}
		} else if (token.kind === 'option-terminator') {
			list = null;
			lastOption = null;
		} else if (list) {
			list.push(token.value);
		} else {
			positionals.push({value: token.value, after: lastOption});
		}
	}

	for (const [name, items] of lists) values[name] = items;

	const extras = positionals.slice(spec.positionals.max);
	if (extras.length > 0) throw new UsageError(unusedMessage(sub, spec, extras));
	if (spec.positionals.folder && positionals.length === 0) {
		checkFolderNotSwallowed(sub, values);
	}
	return {values, positionals: positionals.map((p) => p.value)};
}

/**
 * `discover --ignore old ~/work` reads `~/work` as a second ignore entry, and
 * the scan silently falls back to cwd, which for `discover --add-remotes` means
 * wiring remotes across the wrong tree. An ignore entry names a REPO, and a
 * folder of repos is almost never a repo itself, so an entry that is an
 * existing directory with no `.git` is taken as a misplaced folder.
 */
function checkFolderNotSwallowed(
	sub: string,
	values: Record<string, unknown>,
): void {
	const ignore = (values.ignore as string[] | undefined) ?? [];
	const folder = ignore.find(isFolderNotRepo);
	if (folder === undefined) return;
	const others = ignore.filter((v) => v !== folder).join(' ');
	throw new UsageError(
		[
			`${sub}: \`${folder}\` was read as an \`--ignore\` value, but it is a folder, not a repo, and no [folder] was given, so ${sub} would scan the current directory instead.`,
			`did you mean \`${sub} ${folder} --ignore ${others || '...'}\`? A list option takes every value up to the next \`--\` option.`,
			`To really ignore it, name the folder to scan: \`${sub} . --ignore ${ignore.join(' ')}\`.`,
		].join('\n'),
	);
}

function isFolderNotRepo(value: string): boolean {
	const dir = path.resolve(value);
	try {
		return statSync(dir).isDirectory() && !existsSync(path.join(dir, '.git'));
	} catch {
		return false;
	}
}

function unusedMessage(
	sub: string,
	spec: CommandSpec,
	extras: {value: string; after: string | null}[],
): string {
	const names = extras.map((e) => `\`${e.value}\``).join(' ');
	const reads =
		spec.positionals.max === 0
			? `\`${sub}\` reads no positional arguments`
			: `\`${sub}\` reads at most ${spec.positionals.max} positional argument(s): ${spec.positionals.names}`;
	const lines = [`${sub}: unused argument(s): ${names}. ${reads}.`];

	const after = extras[0]?.after;
	const afterDesc = after ? spec.options[after] : undefined;
	if (afterDesc?.type === 'string' && !afterDesc.multiple) {
		lines.push(`\`--${after}\` takes a single value.`);
	} else if (spec.hint) {
		lines.push(
			`did you mean \`--${spec.hint} ${extras.map((e) => e.value).join(' ')}\`? ` +
				'A list option takes every value up to the next `--` option.',
		);
	}
	lines.push(`See \`offshoot-fanout ${sub} --help\`.`);
	return lines.join('\n');
}

/** Parse `rest` (argv after the subcommand) against that subcommand's spec. */
export function parseCommand(
	sub: string,
	rest: string[],
): {values: Record<string, unknown>; positionals: string[]} {
	const spec = COMMANDS[sub];
	if (!spec) throw new Error(`no argument spec for subcommand \`${sub}\``);
	return parseOpts(sub, rest, spec);
}
