CREATE TABLE `forum_articles` (
	`signature` text PRIMARY KEY NOT NULL,
	`author` text NOT NULL,
	`title` text NOT NULL,
	`content_hash` text NOT NULL,
	`body` text NOT NULL,
	`format` text DEFAULT 'markdown' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forum_articles_author` ON `forum_articles` (`author`);