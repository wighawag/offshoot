#!/usr/bin/env node
// The bin entry, and nothing else: it always runs. `main` lives in main.ts so
// the tests can import it without starting the CLI.
import {main} from './main.js';

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((e) => {
		console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
		process.exitCode = 1;
	});
