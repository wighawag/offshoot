/**
 * Core vocabulary. Everything offshoot does is a function over an in-memory
 * file tree: fetch -> VirtualFile[] -> transforms -> write -> git.
 */

/**
 * A file in the in-memory tree, before it ever touches disk. Paths and
 * contents are transformed together, which is why transforms take the whole
 * tree rather than one file at a time.
 */
export interface VirtualFile {
	/** Relative POSIX path from the project root. Never absolute, never "..". */
	path: string;
	/** Raw bytes. Binary files must survive byte-identical. */
	content: Buffer;
	/** Executable bit, preserved from the template through to the output. */
	executable: boolean;
	/** True when the content must not be rewritten (real detection, not a try/catch). */
	binary: boolean;
	/**
	 * Skip-listed (lockfiles, build output, ...). Transforms must leave both
	 * the path and the content alone; the file is still committed.
	 */
	skip: boolean;
}

export type AnswerValue = string | number | boolean | null;
export type Answers = Record<string, AnswerValue>;

/** Context handed to every transform. */
export interface TransformContext {
	/** The token being replaced, e.g. "jolly-roger". */
	sourceName: string;
	/** Template source as written in the state file, e.g. "github:wighawag/jolly-roger". */
	template: string;
	/** Concrete commit SHA being transformed. */
	ref: string;
	/** Resolved template configuration. */
	config: ResolvedConfig;
	/** Content-only delimiters. Path interpolation is always `{{ }}`. */
	contentTags: [string, string];
	/** "scaffold" | "update" | "rename" | "doctor" */
	operation: Operation;
	/** `--force`: the user accepted the risk after a failed uniqueness gate. */
	force: boolean;
	/**
	 * `--eject`: this project will have NO link to the template. Custom
	 * transforms can use it to drop anything that only makes sense in a linked
	 * project.
	 */
	eject: boolean;
	log: Logger;
}

export type Operation = 'scaffold' | 'update' | 'rename' | 'doctor';

export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	debug(msg: string): void;
}

/**
 * The central abstraction. Transforms are ordered and composable; each one
 * takes the whole tree and returns the whole tree.
 */
export interface Transform {
	name: string;
	apply(
		files: VirtualFile[],
		answers: Answers,
		ctx: TransformContext,
	): VirtualFile[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Built-in strategy specs, declarable from JSON config. */
export type TransformSpec = RenameSpec | PatternsSpec | TemplateSpec;

export interface RenameSpec {
	type: 'rename';
	/** Overrides config.sourceName for this transform only. */
	from?: string;
	/** Answer key holding the target name. Default "name". */
	answer?: string;
	/**
	 * Case variants to replace. Defaults to the change-name set.
	 * Names are the change-case v4 names; v5 renames are mapped internally.
	 */
	variants?: CaseVariant[];
}

export type CaseVariant =
	| 'camelCase'
	| 'constantCase'
	| 'headerCase'
	| 'noCase'
	| 'paramCase'
	| 'pascalCase'
	| 'pathCase'
	| 'sentenceCase'
	| 'snakeCase'
	| 'capitalCase'
	| 'dotCase';

/** An explicit, context-anchored replacement pair. */
export interface PatternPair {
	from: string;
	/** Literal replacement, or a function of the answers (js/ts config only). */
	to: string | ((answers: Answers) => string);
}

export interface PatternsSpec {
	type: 'patterns';
	patterns: PatternPair[];
	/** Also apply the pairs to file and directory names. Default false. */
	paths?: boolean;
}

export interface TemplateSpec {
	type: 'template';
	/**
	 * Globs the placeholder expansion is restricted to. Required: opt-in only,
	 * so the rest of the template stays an unmarked working project.
	 */
	include: string[];
	exclude?: string[];
}

export interface PromptSpec {
	name: string;
	type?: 'text' | 'confirm' | 'select';
	message?: string;
	initial?: AnswerValue;
	choices?: {title: string; value: AnswerValue}[];
	/** Regex source string (JSON config) or a predicate (js/ts config). */
	validate?: string | ((value: string) => true | string);
	/** Error message used when `validate` is a regex string. */
	validationMessage?: string;
}

/**
 * What to strip when a project is scaffolded with `--eject`, i.e. with no
 * template branch and no way to update.
 *
 * offshoot always removes its own traces (a dependency on `offshoot`, and any
 * script that invokes it). This is for the rest: the files and package.json
 * entries a template ships purely to support updating.
 */
export interface EjectConfig {
	/** Globs removed from the output, on top of `exclude`. */
	exclude?: string[];
	/** Entries removed from every package.json in the tree. */
	packageJson?: {
		dependencies?: string[];
		devDependencies?: string[];
		/** Script NAMES to remove. */
		scripts?: string[];
	};
}

export interface OffshootConfig {
	/** Token replaced by the target name. Inferred from the repo name if absent. */
	sourceName?: string;
	/** Orphan branch holding the transformed template. Default "template". */
	branch?: string;
	/** Ordered strategies. Default [{type: "rename"}]. */
	transforms?: (TransformSpec | Transform)[];
	/** Questions asked at scaffold time and replayed from the state file after. */
	prompts?: PromptSpec[];
	/**
	 * File CONTENT delimiters for the `template` strategy. Default ["{{", "}}"].
	 * File and folder NAME interpolation is fixed at `{{ }}` and is NOT
	 * configurable: `<` and `>` are reserved on Windows.
	 */
	contentTags?: [string, string];
	/** Directory names skipped wholesale. */
	skipDirs?: string[];
	/** File basenames skipped wholesale. */
	skipFiles?: string[];
	/** Globs seeded once at scaffold and never updated afterwards. */
	skipIfExists?: string[];
	/** Globs that must never reach the generated project. */
	exclude?: string[];
	/** Globs whose file names keep a literal `{{`. */
	pathInterpolationExclude?: string[];
	/** What `--eject` strips, beyond offshoot's own traces. */
	eject?: EjectConfig;
}

export interface ResolvedConfig extends Required<
	Omit<OffshootConfig, 'sourceName' | 'transforms' | 'prompts' | 'eject'>
> {
	sourceName: string;
	transforms: (TransformSpec | Transform)[];
	prompts: PromptSpec[];
	eject: Required<EjectConfig>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * `.offshoot.json`, written into the transformed output so it lives on the
 * template branch and its `ref` reaches `main` through the merge.
 *
 * Deliberately not a key in package.json: the ref changes on every update,
 * package managers rewrite package.json formatting, and a dedicated file the
 * user never edits is guaranteed to merge cleanly.
 */
export interface OffshootState {
	/** e.g. "github:wighawag/jolly-roger" */
	template: string;
	/** Concrete commit SHA. Never a floating branch name. */
	ref: string;
	/** Floating ref this project tracks for `offshoot check`, e.g. "main". */
	track?: string;
	sourceName: string;
	answers: Answers;
	/** Orphan branch name, when it differs from the default. */
	branch?: string;
	/** Reserved for a future `adopt` command. */
	version?: number;
}
