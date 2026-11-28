// Validation and types for `channels.web` (separated from `src/config.ts` to keep it within the LOC ratchet).
import { asRecord, invalid } from "./config-validate";

/** Synthetic owner user id used on the web chat platform (never matches a Discord snowflake). */
export const WEB_OWNER_USER_ID = "web:owner";

export interface WebChannelConfig {
	enabled: boolean;
	ownerEmails: string[];
	accessTeamDomain: string;
	accessAud: string;
}

const WEB_KEYS: Record<string, true> = {
	enabled: true,
	ownerEmails: true,
	accessTeamDomain: true,
	accessAud: true,
};

const EMAIL_PATTERN = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/** Parses and validates `channels.web`; enforces required fields whenever `enabled` is true. */
export function parseWebChannel(configPath: string, value: unknown): WebChannelConfig {
	const record = asRecord(value);
	if (record === undefined) invalid(configPath, "channels.web");
	for (const key of Object.keys(record)) {
		if (!Object.hasOwn(WEB_KEYS, key)) invalid(configPath, `channels.web.${key}`);
	}
	const enabled = record.enabled;
	if (typeof enabled !== "boolean") invalid(configPath, "channels.web.enabled");

	let ownerEmails: string[] = [];
	if (record.ownerEmails !== undefined) {
		if (!Array.isArray(record.ownerEmails)) invalid(configPath, "channels.web.ownerEmails");
		ownerEmails = record.ownerEmails.map((entry, index) => {
			if (typeof entry !== "string") invalid(configPath, `channels.web.ownerEmails.${index}`);
			const normalized = entry.trim().toLowerCase();
			// A disabled block keeps its stale values unread: re-enabling re-validates them at the next load.
			if (enabled && !EMAIL_PATTERN.test(normalized)) invalid(configPath, `channels.web.ownerEmails.${index}`);
			return normalized;
		});
	}
	if (enabled && ownerEmails.length === 0) invalid(configPath, "channels.web.ownerEmails");

	let accessTeamDomain = "";
	if (record.accessTeamDomain !== undefined) {
		if (typeof record.accessTeamDomain !== "string") invalid(configPath, "channels.web.accessTeamDomain");
		const domain = record.accessTeamDomain.trim().toLowerCase();
		if (enabled) {
			if (!DOMAIN_PATTERN.test(domain) || domain.includes("..")) invalid(configPath, "channels.web.accessTeamDomain");
			accessTeamDomain = domain;
		} else if (domain !== "") {
			accessTeamDomain = domain;
		}
	} else if (enabled) {
		invalid(configPath, "channels.web.accessTeamDomain");
	}

	let accessAud = "";
	if (record.accessAud !== undefined) {
		if (typeof record.accessAud !== "string") invalid(configPath, "channels.web.accessAud");
		const aud = record.accessAud.trim();
		if (enabled) {
			if (aud === "" || /[\s\p{Cc}]/u.test(aud)) invalid(configPath, "channels.web.accessAud");
			accessAud = aud;
		} else if (aud !== "") {
			accessAud = aud;
		}
	} else if (enabled) {
		invalid(configPath, "channels.web.accessAud");
	}

	return { enabled, ownerEmails, accessTeamDomain, accessAud };
}
