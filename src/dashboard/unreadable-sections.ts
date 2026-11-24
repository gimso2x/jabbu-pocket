import type { DashboardSnapshot } from "./snapshot";

/** The snapshot sections the owner is waiting on that could not be read, with the reason; never read as "nothing to do". */
export function unreadableSections(snapshot: DashboardSnapshot): Array<{ label: string; error: string }> {
	const { gates, alerts, approvals, turns, tasks } = snapshot;
	const named = { 게이트: gates, 알림: alerts, 승인: approvals, 턴: turns, TASK: tasks };
	return Object.entries(named).flatMap(([label, section]) => (section.ok ? [] : [{ label, error: section.error }]));
}
