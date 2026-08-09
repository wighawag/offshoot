/**
 * Answer collection. `npm create` forwards positional args directly but needs
 * a `--` separator for flags, so positional args and interactive prompts are
 * the primary path; `--answer key=value` exists for CI.
 */

import type {AnswerValue, Answers, PromptSpec} from "./types.js";

export interface AskOptions {
	prompts: PromptSpec[];
	/** Pre-supplied answers (positional args, --answer flags, saved state). */
	provided: Answers;
	/** Never prompt; fail if an answer is missing and has no initial value. */
	nonInteractive?: boolean;
}

export async function askAnswers(options: AskOptions): Promise<Answers> {
	const answers: Answers = {...options.provided};
	const missing = options.prompts.filter((p) => answers[p.name] === undefined);

	for (const spec of missing) {
		if (options.nonInteractive || !process.stdin.isTTY) {
			if (spec.initial !== undefined) {
				answers[spec.name] = spec.initial;
				continue;
			}
			throw new Error(
				`Missing answer "${spec.name}" and stdin is not interactive. Pass it positionally or with --answer ${spec.name}=<value>.`,
			);
		}

		const prompts = (await import("prompts")).default;
		const response = await prompts(
			{
				type: spec.type === "confirm" ? "confirm" : spec.type === "select" ? "select" : "text",
				name: spec.name,
				message: spec.message ?? `${spec.name}:`,
				initial: spec.initial as string | undefined,
				choices: spec.choices?.map((c) => ({title: c.title, value: c.value})),
				validate: toValidator(spec),
			},
			{
				onCancel: () => {
					throw new Error("Cancelled.");
				},
			},
		);
		if (response[spec.name] === undefined) throw new Error("Cancelled.");
		answers[spec.name] = response[spec.name] as AnswerValue;
	}

	for (const spec of options.prompts) {
		const value = answers[spec.name];
		if (typeof value === "string") {
			const check = validateValue(spec, value);
			if (check !== true) throw new Error(`Invalid value for "${spec.name}": ${check}`);
		}
	}

	return answers;
}

function toValidator(spec: PromptSpec): ((value: string) => true | string) | undefined {
	if (!spec.validate) return undefined;
	return (value: string) => validateValue(spec, value);
}

export function validateValue(spec: PromptSpec, value: string): true | string {
	if (!spec.validate) return true;
	if (typeof spec.validate === "function") return spec.validate(value);
	const re = new RegExp(spec.validate);
	return re.test(value) ? true : (spec.validationMessage ?? `must match ${spec.validate}`);
}

/** `--answer key=value` and `key=value` positional pairs. */
export function parseAnswerAssignment(text: string): [string, AnswerValue] | undefined {
	const eq = text.indexOf("=");
	if (eq <= 0) return undefined;
	const key = text.slice(0, eq).trim();
	const raw = text.slice(eq + 1);
	if (!/^[A-Za-z_$][\w$]*$/.test(key)) return undefined;
	if (raw === "true") return [key, true];
	if (raw === "false") return [key, false];
	if (raw !== "" && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) return [key, Number(raw)];
	return [key, raw];
}
