/*
 * Ending a spawned process tree. The group signal (`kill(-pgid)`) reaches everything that stayed in the leader's
 * process group; a descendant that left it (`setsid`, its own `detached` spawn) is reached by pid instead. Those are
 * read from `/proc` once, before the first signal, and kept with their start time: the leader may be gone by the
 * SIGKILL wave, and a pid that now is another process is left alone. Where `/proc` cannot be read, the group signal
 * alone goes out, as it always did.
 */

import { readdirSync, readFileSync } from "node:fs";

/** One process as `/proc/<pid>/stat` shows it; `starttime` (field 22) tells the recorded process from a later one on its pid. */
export interface ProcStat {
	pid: number;
	ppid: number;
	starttime: string;
}

/** `/proc` as the tree helpers read it; tests hand in their own. */
export interface ProcSource {
	/** Every process there is right now; `[]` when there is nothing to read (no `/proc`). */
	list(): ProcStat[];
	/** One process by pid, `undefined` when it is gone or cannot be read. */
	get(pid: number): ProcStat | undefined;
}

/** `process.kill`'s shape: it throws when the signal was not sent. */
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;

/** A leader's descendants as they were when the tree was read, in its process group or out of it. */
export interface ProcessTree {
	/** The leader, whose process group (`-leaderPid`) is signalled as a whole; not a member itself. */
	readonly leaderPid: number;
	readonly members: readonly ProcStat[];
}

/** 0-based index of field 22 (`starttime`) among what follows `pid (comm) ` in `/proc/<pid>/stat`. */
const STARTTIME = 22 - 3;

/**
 * One line of `/proc/<pid>/stat` as `ProcStat`, `undefined` for what is not one. `comm` (field 2) may hold spaces
 * and parentheses, so the fields count from its last `)`: `pid (comm) state ppid pgrp …`.
 */
export function parseStat(pid: number, line: string): ProcStat | undefined {
	const close = line.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = line.slice(close + 2).split(" ");
	const ppid = Number(fields[1]);
	const starttime = fields[STARTTIME];
	if (!Number.isInteger(ppid) || starttime === undefined) return undefined;
	return { pid, ppid, starttime };
}

function readStat(pid: number): ProcStat | undefined {
	try {
		return parseStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return undefined; // gone, or nothing to read here
	}
}

/** The real `/proc`; an empty source elsewhere (no `/proc`, or no Linux layout in it). */
export const linuxProc: ProcSource = {
	get: readStat,
	list() {
		if (process.platform !== "linux") return [];
		let names: string[];
		try {
			names = readdirSync("/proc");
		} catch {
			return [];
		}
		const stats: ProcStat[] = [];
		for (const name of names) {
			if (!/^[1-9]\d*$/.test(name)) continue;
			const stat = readStat(Number(name));
			if (stat !== undefined) stats.push(stat);
		}
		return stats;
	},
};

/**
 * Every descendant of `leaderPid` at this moment, whatever session or process group it is in. Empty where `/proc`
 * cannot be read: the callers then signal the group alone.
 */
export function captureTree(leaderPid: number, proc: ProcSource = linuxProc): ProcessTree {
	const kids = new Map<number, ProcStat[]>();
	for (const stat of proc.list()) {
		const siblings = kids.get(stat.ppid);
		if (siblings === undefined) kids.set(stat.ppid, [stat]);
		else siblings.push(stat);
	}
	const members: ProcStat[] = [];
	const seen = new Set([leaderPid]);
	const walk = (ppid: number): void => {
		for (const kid of kids.get(ppid) ?? []) {
			// Seen once is enough: `/proc` lists a pid once; a table that loops ends here.
			if (seen.has(kid.pid)) continue;
			seen.add(kid.pid);
			members.push(kid);
			walk(kid.pid);
		}
	};
	walk(leaderPid);
	return { leaderPid, members };
}

const sendSignal: SignalSender = (pid, signal) => process.kill(pid, signal);

/**
 * Signals the leader's whole process group, then every recorded member by pid: one whose start time is not the
 * recorded one any more is a reused pid, a process that is not ours, and is left alone. Never throws: what is
 * already gone, or not ours to signal, costs nothing, and the callers run from timers and exit paths.
 */
export function signalTree(
	tree: ProcessTree,
	signal: NodeJS.Signals,
	proc: ProcSource = linuxProc,
	send: SignalSender = sendSignal,
): void {
	try {
		send(-tree.leaderPid, signal);
	} catch {
		// the group is gone, or not ours to signal
	}
	for (const member of tree.members) {
		if (proc.get(member.pid)?.starttime !== member.starttime) continue;
		try {
			send(member.pid, signal);
		} catch {
			// gone between the read and the signal, or not ours to signal
		}
	}
}

/** Reads the tree of `leaderPid` and signals it right away (the one-wave callers). */
export function killTree(
	leaderPid: number,
	signal: NodeJS.Signals,
	proc: ProcSource = linuxProc,
	send: SignalSender = sendSignal,
): void {
	signalTree(captureTree(leaderPid, proc), signal, proc, send);
}
