// cgroup 가상 파일 해석: `mountinfo`·`cgroup` 텍스트에서 마운트와 소속 경로를 찾고,
// 한도·사용량·통계 텍스트를 예산(한도와 여유)으로 바꾼다. 실제 읽기는 부르는 쪽이 맡는다.

import { join } from "node:path";

/** 한 조상 cgroup에 걸린 한도 하나와 그 여유. */
type Headroom = {
	readonly path: string;
	readonly limitBytes: number;
	readonly currentBytes: number;
	readonly reclaimableBytes: number;
	readonly chargedFreePct: number;
	readonly freePct: number;
};
/** 이 프로세스가 보는 cgroup 계층의 메모리 예산. */
export type CgroupMemory = {
	readonly version: 1 | 2 | null;
	hard: Headroom | null;
	high: Headroom | null;
	incomplete: boolean;
};
export type Mount = { readonly root: string; readonly point: string };
type Limit = number | "unlimited" | "unknown";

/** v1이 무제한을 적는 값(페이지 정렬된 LONG_MAX). 이 밖의 큰 수는 한도로 읽지 않는다. */
const V1_UNLIMITED = 9223372036854771712n;
const MAX_SAFE = 9007199254740991;
const PATH_SEGMENTS = (path: string): string[] => path.split("/").filter((part) => part !== "" && part !== ".");

/** 수 텍스트. 수가 아니면 undefined. */
const safe = (text: string | undefined): number | undefined => {
	const value = text?.trim() ?? "";
	return /^\d+$/.test(value) ? Number(value) : undefined;
};
/** 한도 텍스트: v2 `max`와 v1 무제한 표식은 무제한, 수가 아니거나 0·안전 범위 밖이면 알 수 없음. */
export const parseLimit = (text: string, v2: boolean): Limit => {
	const value = text.trim();
	if (v2 ? value === "max" : /^\d+$/.test(value) && BigInt(value) === V1_UNLIMITED) return "unlimited";
	const parsed = safe(value);
	return parsed === undefined || parsed === 0 || parsed > MAX_SAFE ? "unknown" : parsed;
};
/** `memory.stat`의 한 항목(`file 100`). */
export const statField = (text: string | undefined, field: string): number | undefined =>
	safe(
		text
			?.split("\n")
			.find((line) => line.startsWith(`${field} `))
			?.slice(field.length + 1),
	);

/** 한도·사용량·회수 가능 캐시로 여유 비율(충전 기준·캐시 포함). 캐시는 쓴 만큼 안으로 자른다. */
export const budget = (path: string, limit: number, used: number, cache: number): Headroom => {
	const reclaimable = Math.min(used, Math.max(0, cache));
	const pct = (bytes: number): number => Math.min(100, Math.max(0, (bytes / limit) * 100));
	return {
		path,
		limitBytes: limit,
		currentBytes: used,
		reclaimableBytes: reclaimable,
		chargedFreePct: pct(limit - used),
		freePct: pct(limit - used + reclaimable),
	};
};

/** `mountinfo`에서 cgroup2 마운트와 memory 컨트롤러를 단 v1 마운트를 고른다. */
export const parseMounts = (text: string): { v2: Mount[]; v1: Mount[] } => {
	const out = { v2: [] as Mount[], v1: [] as Mount[] };
	for (const line of text.split("\n")) {
		const f = line.split(" ");
		const dash = f.indexOf("-");
		const root = f[3];
		const point = f[4];
		if (dash < 0 || root === undefined || point === undefined) continue;
		const kind = f[dash + 1];
		if (kind === "cgroup2") out.v2.push({ root, point });
		else if (kind === "cgroup" && (f[dash + 3] ?? "").split(",").includes("memory")) out.v1.push({ root, point });
	}
	return out;
};
/** root가 짧은 마운트가 계층을 넓게 본다(subtree 바인드보다 위). */
export const widest = (list: readonly Mount[]): Mount | undefined =>
	[...list].sort((a, b) => PATH_SEGMENTS(a.root).length - PATH_SEGMENTS(b.root).length)[0];

/** `/proc/self/cgroup`에서 이 버전 계층의 소속 경로. 절대 경로가 아니면 잘못된 줄이다. */
export const membership = (text: string, version: 1 | 2): string | undefined => {
	for (const line of text.split("\n")) {
		const first = line.indexOf(":");
		const second = line.indexOf(":", first + 1);
		if (first < 0 || second < 0) continue;
		const controllers = line.slice(first + 1, second);
		const mine =
			version === 2 ? line.slice(0, first) === "0" && controllers === "" : controllers.split(",").includes("memory");
		const path = line.slice(second + 1);
		if (mine && path.startsWith("/")) return path;
	}
	return undefined;
};

/** 마운트 안에서 소속 경로의 조상들. `..`는 마운트 루트 밖으로 나가지 못하고, 안쪽부터 돌려준다. */
export const chain = (mount: Mount, path: string): { dir: string; label: string }[] => {
	const base = PATH_SEGMENTS(mount.root);
	const trail = [...base];
	let inside = path;
	if (mount.root !== "/" && base.length > 0) {
		const root = `/${base.join("/")}`;
		if (path === root) inside = "";
		else if (path.startsWith(`${root}/`)) inside = path.slice(root.length);
		else return [];
	}
	for (const part of inside.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") trail.push(part);
		else if (trail.length > base.length) trail.pop();
	}
	const out: { dir: string; label: string }[] = [];
	for (let depth = trail.length; depth >= base.length; depth -= 1)
		out.push({
			dir: join(mount.point, ...trail.slice(base.length, depth)),
			label: `/${trail.slice(0, depth).join("/")}`,
		});
	return out;
};
