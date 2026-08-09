/**
 * offshoot: scaffold projects from git templates, then pull in template
 * improvements later via real git merges.
 *
 * The whole design in one paragraph: the transformed template lives on an
 * orphan `template` branch, the user's work branches off it, and an update
 * re-transforms the new template version onto that branch and merges. Git does
 * the merging; there is no diff algorithm here to get wrong, and the user's
 * history contains zero commits from the template repository.
 */

export {scaffold, parseScaffoldArgs} from "./commands/scaffold.js";
export type {ScaffoldOptions, ScaffoldResult, ParsedScaffoldArgs} from "./commands/scaffold.js";

export {update, assertNoNameDrift} from "./commands/update.js";
export type {UpdateOptions, UpdateResult} from "./commands/update.js";

export {check} from "./commands/check.js";
export type {CheckOptions, CheckResult} from "./commands/check.js";

export {rename} from "./commands/rename.js";
export type {RenameOptions, RenameResult} from "./commands/rename.js";

export {doctor} from "./commands/doctor.js";
export type {DoctorOptions, DoctorResult, DoctorOccurrence} from "./commands/doctor.js";

export {eject} from "./commands/eject.js";
export type {EjectOptions, EjectResult} from "./commands/eject.js";

// --- authoring surface -----------------------------------------------------

export {
	defineConfig,
	resolveConfig,
	loadTemplateConfig,
	findConfigFile,
	DEFAULT_SKIP_DIRS,
	DEFAULT_SKIP_FILES,
	DEFAULT_CONTENT_TAGS,
	DEFAULT_BRANCH,
} from "./config.js";

export {
	resolveTransforms,
	createRenameTransform,
	createPatternsTransform,
	createTemplateTransform,
	createPathInterpolationTransform,
	createEjectTransform,
	stripPackageJsonSource,
	applyRename,
	assertRoundTrip,
	RoundTripError,
	interpolatePath,
	hasPathPlaceholder,
	PATH_TAGS,
} from "./transforms/index.js";

export {buildTree} from "./pipeline.js";
export type {BuildTreeOptions} from "./pipeline.js";

export {readTree, writeTree} from "./vfs.js";
export {isText, isBinary, looksBinary, getEncoding} from "./text-binary/index.js";
export {CASE_FUNCTIONS, DEFAULT_VARIANTS, variantsOf, variantPairs} from "./case-variants.js";
export {readState, serializeState, stateFile, STATE_FILE, STATE_VERSION} from "./state.js";
export {parseSource, resolveRef, downloadTemplate} from "./source.js";
export {createLogger, silentLogger} from "./logger.js";
export {detectPackageManager, refreshLockfile} from "./package-manager.js";
export type {PackageManager, PackageManagerName} from "./package-manager.js";

export type {
	Answers,
	AnswerValue,
	CaseVariant,
	EjectConfig,
	Logger,
	OffshootConfig,
	OffshootState,
	Operation,
	PatternPair,
	PatternsSpec,
	PromptSpec,
	RenameSpec,
	ResolvedConfig,
	TemplateSpec,
	Transform,
	TransformContext,
	TransformSpec,
	VirtualFile,
} from "./types.js";
