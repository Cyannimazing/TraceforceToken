CREATE TABLE `investigation_jobs` (
	`id` char(36) NOT NULL,
	`status` enum('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
	`parameters` json NOT NULL,
	`stage` varchar(120) NOT NULL DEFAULT 'queued',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 3,
	`available_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`lease_token` char(36),
	`lease_expires_at` datetime(3),
	`report` json,
	`error` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `investigation_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `investigation_jobs_attempts_chk` CHECK(`investigation_jobs`.`attempts` <= 3 AND `investigation_jobs`.`max_attempts` BETWEEN 1 AND 3),
	CONSTRAINT `investigation_jobs_lease_chk` CHECK((`investigation_jobs`.`status` = 'running' AND `investigation_jobs`.`lease_token` IS NOT NULL AND `investigation_jobs`.`lease_expires_at` IS NOT NULL) OR (`investigation_jobs`.`status` <> 'running' AND `investigation_jobs`.`lease_token` IS NULL AND `investigation_jobs`.`lease_expires_at` IS NULL)),
	CONSTRAINT `investigation_jobs_report_chk` CHECK((`investigation_jobs`.`status` = 'completed' AND `investigation_jobs`.`report` IS NOT NULL) OR (`investigation_jobs`.`status` <> 'completed' AND `investigation_jobs`.`report` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `investigation_queue_guard` (
	`id` int unsigned NOT NULL,
	CONSTRAINT `investigation_queue_guard_id` PRIMARY KEY(`id`),
	CONSTRAINT `investigation_queue_guard_singleton_chk` CHECK(`investigation_queue_guard`.`id` = 1)
);
--> statement-breakpoint
CREATE INDEX `investigation_jobs_queue_idx` ON `investigation_jobs` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `investigation_jobs_recovery_idx` ON `investigation_jobs` (`status`,`lease_expires_at`);