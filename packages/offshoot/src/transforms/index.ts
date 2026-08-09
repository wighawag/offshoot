import type {Transform, TransformSpec} from "../types.js";
import {createRenameTransform} from "./rename.js";
import {createPatternsTransform} from "./patterns.js";
import {createTemplateTransform} from "./template.js";

export {createRenameTransform, applyRename, assertRoundTrip, RoundTripError} from "./rename.js";
export {createPatternsTransform} from "./patterns.js";
export {createTemplateTransform} from "./template.js";
export {createPathInterpolationTransform, interpolatePath, hasPathPlaceholder, PATH_TAGS} from "./path-interpolation.js";
export {
	createEjectTransform,
	stripPackageJsonSource,
	isPackageJson,
	emptyEjectReport,
	type EjectReport,
} from "./eject-integration.js";

/** A declared spec, or a ready-made custom Transform supplied by the template. */
export function isTransform(value: TransformSpec | Transform): value is Transform {
	return typeof (value as Transform).apply === "function" && typeof (value as Transform).name === "string";
}

/**
 * Turn config entries into Transform instances. Custom implementations pass
 * straight through, so template authors are not limited to the three
 * built-ins.
 */
export function resolveTransforms(entries: (TransformSpec | Transform)[]): Transform[] {
	return entries.map((entry) => {
		if (isTransform(entry)) return entry;
		switch (entry.type) {
			case "rename":
				return createRenameTransform(entry);
			case "patterns":
				return createPatternsTransform(entry);
			case "template":
				return createTemplateTransform(entry);
			default: {
				const unknown = entry as {type?: string};
				throw new Error(
					`Unknown transform type "${unknown.type}". Built-ins are "rename", "patterns" and "template"; ` +
						`custom transforms must be objects with a name and an apply() and require a js/ts config.`,
				);
			}
		}
	});
}
