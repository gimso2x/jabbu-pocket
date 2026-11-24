/**
 * Written by older versions (delivery pinning): nothing reads or writes this table now. Its rows still go with their
 * delivery in `gc`.
 */
export const LEGACY_FEEDBACK_DDL = `
CREATE TABLE IF NOT EXISTS delivery_posts (
	channel TEXT NOT NULL,
	ts TEXT NOT NULL,
	delivery_id INTEGER NOT NULL REFERENCES deliveries(delivery_id),
	part INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (channel, ts)
);
`;
