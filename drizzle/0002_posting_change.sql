CREATE TABLE `posting_change` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`posting_id` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`kind` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`notified_at` integer,
	FOREIGN KEY (`posting_id`) REFERENCES `posting`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "posting_change_kind_ck" CHECK(kind IN ('locations', 'compensation', 'title', 'verdict'))
);
--> statement-breakpoint
CREATE INDEX `posting_change_pending_idx` ON `posting_change` (`notified_at`);