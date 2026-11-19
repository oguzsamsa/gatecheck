CREATE TABLE `company` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`ats` text NOT NULL,
	`org_slug` text NOT NULL,
	`careers_url` text,
	`discovered_from` text,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_ats_org_slug_uq` ON `company` (`ats`,`org_slug`);--> statement-breakpoint
CREATE TABLE `compensation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`posting_id` integer NOT NULL,
	`min` real,
	`max` real,
	`currency` text,
	`period` text,
	`source` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `posting`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `compensation_posting_idx` ON `compensation` (`posting_id`);--> statement-breakpoint
CREATE TABLE `eligibility` (
	`posting_id` integer PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`reason` text NOT NULL,
	`evaluated_at` integer NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `posting`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "eligibility_verdict_ck" CHECK(verdict IN ('open', 'closed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE `location_claim` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`posting_id` integer NOT NULL,
	`kind` text NOT NULL,
	`country_code` text,
	`region` text,
	`city` text,
	`raw` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `posting`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "location_claim_kind_ck" CHECK(kind IN ('office', 'remote_region', 'applicant_requirement')),
	CONSTRAINT "location_claim_country_or_region_ck" CHECK(country_code IS NULL OR region IS NULL)
);
--> statement-breakpoint
CREATE INDEX `location_claim_posting_idx` ON `location_claim` (`posting_id`);--> statement-breakpoint
CREATE TABLE `notification` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`posting_id` integer NOT NULL,
	`channel` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `posting`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_posting_channel_uq` ON `notification` (`posting_id`,`channel`);--> statement-breakpoint
CREATE TABLE `posting` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`ats_posting_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`department` text,
	`employment_type` text,
	`posted_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posting_company_ats_id_uq` ON `posting` (`company_id`,`ats_posting_id`);--> statement-breakpoint
CREATE INDEX `posting_open_idx` ON `posting` (`closed_at`);--> statement-breakpoint
CREATE TABLE `posting_version` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`posting_id` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`content_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `posting`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `posting_version_posting_idx` ON `posting_version` (`posting_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	CONSTRAINT "run_status_ck" CHECK(status IN ('running', 'ok', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `run_source` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`company_id` integer NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`error` text,
	`postings_seen` integer,
	`etag` text,
	`last_modified` text,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `company`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_source_status_ck" CHECK(status IN ('ok', 'not_modified', 'error'))
);
--> statement-breakpoint
CREATE INDEX `run_source_company_idx` ON `run_source` (`company_id`,`started_at`);