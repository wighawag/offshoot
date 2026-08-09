#!/usr/bin/env node
/**
 * One name per command. There is no `graft` alias.
 */

import {scaffold} from "./commands/scaffold.js";
import {update} from "./commands/update.js";
import {check} from "./commands/check.js";
import {rename} from "./commands/rename.js";
import {doctor} from "./commands/doctor.js";
import {eject} from "./commands/eject.js";
import {createLogger} from "./logger.js";
import {RoundTripError} from "./transforms/rename.js";

const USAGE = `offshoot - scaffold from a git template, then merge template improvements later

Usage
  offshoot new <template> [dir]     scaffold a new project
  offshoot update [--ref <ref>]     merge template improvements into this project
  offshoot check                    is a newer template ref available? (non-zero exit if yes)
  offshoot rename <newName>         rename the project on both branches
  offshoot doctor                   lint a template repository (for template authors)
  offshoot eject                    delete the template branch and .offshoot.json, permanently

Template sources
  user/repo            github:user/repo      user/repo#ref
  gitlab:user/repo     ./path/to/local/repo  file:/abs/path

Options
  --ref <ref>          template ref (branch, tag or commit)
  --answer key=value   supply an answer without prompting (repeatable)
  --eject              (new) no template link: no template branch, no
                       .offshoot.json, integration stripped. Just the code.
  --force              proceed despite a failed uniqueness check
  --yes                never prompt; use defaults
  --verbose            more detail
  --help, --version
`;

function flag(argv: string[], name: string): boolean {
	return argv.includes(name);
}

function option(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index !== -1) return argv[index + 1];
	const prefixed = argv.find((a) => a.startsWith(`${name}=`));
	return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);

	if (argv.length === 0 || flag(argv, "--help") || flag(argv, "-h")) {
		console.log(USAGE);
		return argv.length === 0 ? 1 : 0;
	}
	if (flag(argv, "--version") || flag(argv, "-v")) {
		const {readFileSync} = await import("node:fs");
		const {fileURLToPath} = await import("node:url");
		const {dirname, join} = await import("node:path");
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {version: string};
		console.log(pkg.version);
		return 0;
	}

	const command = argv[0];
	const rest = argv.slice(1);
	const log = createLogger({verbose: flag(rest, "--verbose")});
	const cleaned = rest.filter((a) => a !== "--verbose");

	switch (command) {
		case "new": {
			const template = cleaned.find((a) => !a.startsWith("-"));
			if (!template) {
				console.error("offshoot new <template> [dir]");
				return 1;
			}
			const index = cleaned.indexOf(template);
			const forwarded = [...cleaned.slice(0, index), ...cleaned.slice(index + 1)];
			await scaffold({template, argv: forwarded, log});
			return 0;
		}

		case "update": {
			const result = await update({
				cwd: process.cwd(),
				ref: option(cleaned, "--ref"),
				force: flag(cleaned, "--force"),
				log,
			});
			return result.conflicted.length > 0 ? 1 : 0;
		}

		case "check": {
			const result = await check({cwd: process.cwd(), ref: option(cleaned, "--ref"), log});
			return result.behind ? 1 : 0;
		}

		case "rename": {
			const newName = cleaned.find((a) => !a.startsWith("-"));
			if (!newName) {
				console.error("offshoot rename <newName>");
				return 1;
			}
			const result = await rename({
				cwd: process.cwd(),
				newName,
				force: flag(cleaned, "--force"),
				log,
			});
			return result.conflicted.length > 0 ? 1 : 0;
		}

		case "doctor": {
			const result = await doctor({
				cwd: option(cleaned, "--cwd") ?? process.cwd(),
				sourceName: option(cleaned, "--source-name"),
				name: option(cleaned, "--name"),
				strict: flag(cleaned, "--strict"),
				log,
			});
			return result.ok ? 0 : 1;
		}

		case "eject": {
			await eject({cwd: process.cwd(), noCommit: flag(cleaned, "--no-commit"), log});
			return 0;
		}

		default:
			console.error(`Unknown command "${command}".\n`);
			console.error(USAGE);
			return 1;
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err: unknown) => {
		if (err instanceof RoundTripError) {
			console.error(`\n${err.report}\n`);
		} else if (err instanceof Error) {
			console.error(`\nerror: ${err.message}\n`);
		} else {
			console.error(err);
		}
		process.exitCode = 1;
	});
