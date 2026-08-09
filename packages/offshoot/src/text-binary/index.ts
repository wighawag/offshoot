// Ported from change-name/is-text-or-binary (MIT), itself derived from
// https://github.com/bevry/istextorbinary (MIT).
//
// Why this exists: `create-jolly-roger` guarded binary files with
//   try { readFileSync(path, 'utf-8') } catch { /* binary */ }
// which is dead code. Reading a binary file as utf-8 does not throw, it
// substitutes U+FFFD, so writing the result back corrupts the file whenever a
// replacement matches. Extension lists plus a content sniff is the real check.

import {basename} from "node:path";
import {TEXT_EXTENSIONS} from "./text-extensions.js";
import {BINARY_EXTENSIONS} from "./binary-extensions.js";

export type Encoding = "utf8" | "binary";

const TEXT = new Set(TEXT_EXTENSIONS);
const BINARY = new Set(BINARY_EXTENSIONS);

export interface EncodingOptions {
	chunkLength?: number;
	chunkBegin?: number;
}

/**
 * Sniff a buffer for binary content: NUL/control bytes or invalid utf-8
 * sequences (which decode to U+FFFD). Samples the start, middle and end.
 */
export function getEncoding(buffer: Buffer | undefined | null, opts?: EncodingOptions): Encoding | null {
	if (!buffer) return null;

	const textEncoding: Encoding = "utf8";
	const binaryEncoding: Encoding = "binary";
	const chunkLength = opts?.chunkLength ?? 24;
	let chunkBegin = opts?.chunkBegin ?? 0;

	if (opts?.chunkBegin == null) {
		// Start
		let encoding = getEncoding(buffer, {chunkLength, chunkBegin});
		if (encoding === textEncoding) {
			// Middle
			chunkBegin = Math.max(0, Math.floor(buffer.length / 2) - chunkLength);
			encoding = getEncoding(buffer, {chunkLength, chunkBegin});
			if (encoding === textEncoding) {
				// End
				chunkBegin = Math.max(0, buffer.length - chunkLength);
				encoding = getEncoding(buffer, {chunkLength, chunkBegin});
			}
		}
		return encoding;
	}

	const chunkEnd = Math.min(buffer.length, chunkBegin + chunkLength);
	const contentChunkUTF8 = buffer.toString(textEncoding, chunkBegin, chunkEnd);

	for (let i = 0; i < contentChunkUTF8.length; ++i) {
		const charCode = contentChunkUTF8.charCodeAt(i);
		// 65533 is the replacement character (invalid utf-8 sequence).
		// <= 8 are control characters (NUL, backspace, ...).
		if (charCode === 65533 || charCode <= 8) {
			return binaryEncoding;
		}
	}

	return textEncoding;
}

/**
 * Extension check first (authoritative), content sniff as fallback.
 * Returns null when neither the filename nor a buffer settles it.
 */
export function isText(filename?: string | null, buffer?: Buffer | null): boolean | null {
	if (filename) {
		// A file may have several extensions ("archive.tar.gz"); the most
		// specific one wins, so walk them right to left.
		const parts = basename(filename).split(".").reverse();
		for (const extension of parts) {
			if (TEXT.has(extension)) return true;
			if (BINARY.has(extension)) return false;
		}
	}

	if (buffer) {
		return getEncoding(buffer) === "utf8";
	}

	return null;
}

export function isBinary(filename?: string | null, buffer?: Buffer | null): boolean | null {
	const text = isText(filename, buffer);
	if (text == null) return null;
	return !text;
}

/**
 * The decision offshoot actually acts on: unknown (null) is treated as text
 * only when a content sniff agrees, so unrecognised extensions with binary
 * payloads are never rewritten.
 */
export function looksBinary(filename: string, buffer: Buffer): boolean {
	const verdict = isBinary(filename, buffer);
	if (verdict != null) return verdict;
	return getEncoding(buffer) !== "utf8";
}

export {TEXT_EXTENSIONS} from "./text-extensions.js";
export {BINARY_EXTENSIONS} from "./binary-extensions.js";
