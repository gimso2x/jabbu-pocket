import { isAbsolute } from "node:path";
import { asRecord, invalid } from "./config-validate";

const DASHBOARD_KEYS = new Set([
	"port",
	"bind",
	"herdrWebUrl",
	"allowedHosts",
	"opsStatus",
	"usageLimits",
	"peerHomes",
	"channelNames",
]);

/** Validates optional `dashboard` sub-blocks (`opsStatus`, `peerHomes`, `channelNames`) and rejects unknown keys. */
export function validateDashboardExtras(configPath: string, record: Record<string, unknown>): void {
	if (record.opsStatus !== undefined) {
		const ops = asRecord(record.opsStatus);
		if (ops === undefined) invalid(configPath, "dashboard.opsStatus");
		if (
			!Array.isArray(ops.command) ||
			ops.command.length === 0 ||
			!ops.command.every((part) => typeof part === "string" && part !== "")
		) {
			invalid(configPath, "dashboard.opsStatus.command");
		}
		if (ops.url !== undefined && (typeof ops.url !== "string" || !/^https?:\/\/\S+$/.test(ops.url))) {
			invalid(configPath, "dashboard.opsStatus.url");
		}
		for (const key of Object.keys(ops)) {
			if (key !== "command" && key !== "url") invalid(configPath, `dashboard.opsStatus.${key}`);
		}
	}
	if (record.peerHomes !== undefined) {
		if (!Array.isArray(record.peerHomes)) invalid(configPath, "dashboard.peerHomes");
		const names = new Set<string>();
		record.peerHomes.forEach((entry: unknown, i: number) => {
			const peer = asRecord(entry);
			if (peer === undefined) invalid(configPath, `dashboard.peerHomes.${i}`);
			for (const key of Object.keys(peer)) {
				if (key !== "name" && key !== "home") invalid(configPath, `dashboard.peerHomes.${i}.${key}`);
			}
			const { name, home } = peer;
			if (typeof name !== "string" || name === "" || name.length > 20 || /[:\s]/.test(name) || names.has(name)) {
				invalid(configPath, `dashboard.peerHomes.${i}.name`);
			}
			names.add(name);
			if (typeof home !== "string" || !isAbsolute(home)) invalid(configPath, `dashboard.peerHomes.${i}.home`);
		});
	}
	if (record.channelNames !== undefined) {
		const ch = asRecord(record.channelNames);
		if (!ch || Object.entries(ch).some(([k, v]) => !k || typeof v !== "string" || !v.trim() || v.length > 40)) {
			invalid(configPath, "dashboard.channelNames");
		}
	}
	for (const key of Object.keys(record)) if (!DASHBOARD_KEYS.has(key)) invalid(configPath, `dashboard.${key}`);
}
