#!/usr/bin/env node
/**
 * `npm create offshoot <template> [dir]`
 *
 * Two npm behaviours shape this entry point:
 *
 *  - `npm create` forwards positional args directly, but flags need a
 *    separator: `npm create offshoot user/repo -- --ref v2`. So positional
 *    args and interactive prompts are the primary path.
 *  - A globally installed `create-*` shadows the registry version, which is
 *    why READMEs should say `npm create offshoot@latest`.
 */

import {scaffold} from "offshoot";

const USAGE = `create-offshoot - scaffold a project from a git template

  npm create offshoot <template> [dir]
  npm create offshoot wighawag/jolly-roger my-app
  npm create offshoot wighawag/jolly-roger#v2 my-app

Flags need npm's separator:
  npm create offshoot wighawag/jolly-roger my-app -- --ref v2
  npm create offshoot wighawag/jolly-roger my-app -- --eject

  --eject   just the code: no template branch, no .offshoot.json, no way to
            pull in later template changes.
`;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);

	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		console.log(USAGE);
		process.exitCode = argv.length === 0 ? 1 : 0;
		return;
	}

	const template = argv[0] as string;
	await scaffold({template, argv: argv.slice(1)});
}

main().catch((err: unknown) => {
	console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
