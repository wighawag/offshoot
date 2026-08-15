export {DEFAULT_REMOTE} from './core.js';
export type {
	Repo,
	Tree,
	LinkedWorktree,
	PropagateOptions,
	PropagateResult,
	PropagateStatus,
	VerifyOutcome,
	LinkStatus,
	LinkResult,
	RenameStatus,
	RenameResult,
	AncestryRepo,
	DiscoveredEdge,
	FamilyTree,
	Registry,
	RegistryRepo,
	DriftResult,
	DriftOptions,
	BackportResult,
	BackportOptions,
	RootStatus,
	StatusOptions,
} from './core.js';
export {
	normalizeUrl,
	discoverRepos,
	discoverLinkedWorktrees,
	asLinkedWorktree,
	matchIgnore,
	buildTree,
	childrenOf,
	propagate,
	linkRemote,
	renameRemotes,
	ancestryRepo,
	discoverAncestry,
	registryDir,
	registryPath,
	saveRegistry,
	loadRegistry,
	driftTree,
	backport,
	statusTree,
} from './core.js';
export type {
	BranchConfig,
	ConfigSource,
	FanoutConfig,
	ResolveConfigOptions,
	ResolvedConfig,
	WriteConfigOptions,
	WriteConfigResult,
} from './config.js';
export {
	CONFIG_FILE,
	DEFAULT_CONFIG_BRANCH,
	resolveConfig,
	writeConfig,
} from './config.js';
export type {
	BranchNode,
	ChildNode,
	EdgeKind,
	NodeRef,
	PlanOptions,
	RepoPlan,
} from './nodes.js';
export {childNodes, createPlanner, nodeLabel, planRepo} from './nodes.js';
export type {Workspace} from './workspace.js';
export type {CommitLog} from './git.js';
export type {Summary} from './report.js';
export {
	formatReport,
	summarize,
	formatAncestryReport,
	formatRenameResults,
	formatLinkResults,
	formatDriftReport,
	formatStatusReport,
} from './report.js';
