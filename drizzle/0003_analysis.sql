CREATE TABLE `analysis` (
	`posting_id` integer PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`model` text NOT NULL,
	`analyzed_at` integer NOT NULL,
	`fit` text NOT NULL,
	`summary` text NOT NULL,
	`ungrounded_count` integer NOT NULL,
	`draft_path` text,
	`result_json` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `posting`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analysis_fit_ck" CHECK(fit IN ('strong', 'possible', 'weak'))
);
