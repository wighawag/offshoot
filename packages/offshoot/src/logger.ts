import type {Logger} from "./types.js";

export function createLogger(options: {verbose?: boolean; silent?: boolean} = {}): Logger {
	return {
		info(msg) {
			if (!options.silent) console.log(msg);
		},
		warn(msg) {
			if (!options.silent) console.warn(msg);
		},
		debug(msg) {
			if (options.verbose && !options.silent) console.log(`  ${msg}`);
		},
	};
}

export const silentLogger: Logger = {
	info() {},
	warn() {},
	debug() {},
};
