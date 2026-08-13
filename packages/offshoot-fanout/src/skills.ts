import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {resolvePackageResource} from './resources.js';

/**
 * Installing the agent skill(s) that ship with this package.
 *
 * `~/.agents/skills/<name>` is the convention, and the only target here. A framework exists that
 * fans out to twenty-odd agent directories; until that settles, this does the one thing and says
 * exactly what it did. (Mirrors the `portolan skills` command.)
 */

export interface Skill {
	name: string;
	description: string;
	from: string;
}

export type Scope = 'user' | 'project';

/** Where skills live, by convention. `project` keeps them beside the code that needs them. */
export function destinationFor(scope: Scope, cwd = process.cwd()): string {
	return scope === 'user'
		? join(homedir(), '.agents', 'skills')
		: join(cwd, '.agents', 'skills');
}

export function skillsSource(): string | undefined {
	return resolvePackageResource('skills/');
}

export function availableSkills(): Skill[] {
	const root = skillsSource();
	if (!root) return [];
	const skills: Skill[] = [];
	for (const entry of readdirSync(root, {withFileTypes: true})) {
		if (!entry.isDirectory()) continue;
		const manifest = join(root, entry.name, 'SKILL.md');
		if (!existsSync(manifest)) continue;
		const text = readFileSync(manifest, 'utf8');
		skills.push({
			name: /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name,
			description: /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '',
			from: join(root, entry.name),
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface Installed {
	name: string;
	to: string;
	replaced: boolean;
}

/**
 * Copies rather than symlinks, so an installed skill survives `node_modules` being deleted.
 *
 * The cost is that upgrading the package does not upgrade the skill, which is why the report names
 * every path written: a skill that is quietly stale is worse than one you know you have to refresh.
 */
export function installSkills(scope: Scope, cwd = process.cwd()): Installed[] {
	const destination = destinationFor(scope, cwd);
	const installed: Installed[] = [];
	for (const skill of availableSkills()) {
		const to = join(destination, skill.name);
		const replaced = existsSync(to);
		if (replaced) rmSync(to, {recursive: true, force: true});
		mkdirSync(destination, {recursive: true});
		cpSync(skill.from, to, {recursive: true});
		installed.push({name: skill.name, to, replaced});
	}
	return installed;
}

export function isInstalled(
	skill: Skill,
	scope: Scope,
	cwd = process.cwd(),
): boolean {
	return existsSync(join(destinationFor(scope, cwd), skill.name));
}
