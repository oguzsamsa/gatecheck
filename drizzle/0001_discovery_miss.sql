CREATE TABLE `discovery_miss` (
	`name_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`last_tried_at` integer NOT NULL
);
