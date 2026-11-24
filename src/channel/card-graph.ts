// The element-id rules of a card spec: reserved ids and a reference graph json-render can draw without losing content.
import { isRecord } from "../omp/type-guards";

/** Ids json-render would store with `out[id] = …`, where they hit the prototype instead of an own key. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** The reserved ids the spec uses as its root, an element key or a child reference, each once in order. */
export function reservedIds(spec: Record<string, unknown>): string[] {
	const elements = isRecord(spec.elements) ? spec.elements : {};
	const ids = [spec.root, ...Object.keys(elements)];
	for (const element of Object.values(elements))
		if (isRecord(element) && Array.isArray(element.children)) for (const child of element.children) ids.push(child);
	return [...new Set(ids.filter((id): id is string => typeof id === "string" && RESERVED_IDS.has(id)))];
}

/**
 * One issue per element id the spec cannot express without losing content. json-render keeps each output key once and
 * drops a revisit silently, so a reference to an element already reached (a cycle, a self reference, a second parent)
 * and an id with `#` (the key `repeat` gives its n-th copy, `id#n`) would make part of the card vanish.
 */
export function graphIssues(spec: Record<string, unknown>): string[] {
	const elements = isRecord(spec.elements) ? spec.elements : {};
	const issues = Object.keys(elements)
		.filter((id) => id.includes("#"))
		.map((id) => `element id "${id}" must not contain "#"`);
	// `children` is a list of element ids; a string would be read as one reference per character.
	for (const [id, element] of Object.entries(elements))
		if (isRecord(element) && !(Array.isArray(element.children) && element.children.every((c) => typeof c === "string")))
			issues.push(`element "${id}": children must be an array of element ids`);
	// A `repeat` parent draws its child once per item under `id#n` keys, so that child may also have one plain parent;
	// two plain parents, or two `repeat` ones (their `id#n` keys collide), would drop content. `reached`: id → via repeat.
	const reached = new Map<string, boolean>();
	// Walked with a stack, not recursion: a card nested tens of thousands deep must not overflow the call stack.
	const pending: Array<[id: unknown, viaRepeat: boolean]> = [[spec.root, false]];
	while (pending.length > 0) {
		const [id, viaRepeat] = pending.pop() ?? [];
		if (typeof id !== "string") continue;
		const first = reached.get(id);
		if (first !== undefined) {
			if (viaRepeat === first) issues.push(`element "${id}" is referenced more than once (cycle or shared child)`);
			continue;
		}
		reached.set(id, viaRepeat === true);
		const element = elements[id];
		if (!isRecord(element) || !Array.isArray(element.children)) continue;
		for (let i = element.children.length - 1; i >= 0; i--)
			pending.push([element.children[i], isRecord(element.repeat)]);
	}
	return [...new Set(issues)];
}
