CREATE TABLE `visitor_admission` (
	`visitor_key` char(64) NOT NULL,
	`window_started_at` datetime(3) NOT NULL,
	`request_count` int unsigned NOT NULL DEFAULT 0,
	`lease_token` char(36),
	`lease_expires_at` datetime(3),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `visitor_admission_visitor_key` PRIMARY KEY(`visitor_key`),
	CONSTRAINT `visitor_admission_key_chk` CHECK(`visitor_admission`.`visitor_key` REGEXP '^[0-9a-f]{64}$' AND CAST(`visitor_admission`.`visitor_key` AS BINARY) = CAST(LOWER(`visitor_admission`.`visitor_key`) AS BINARY)),
	CONSTRAINT `visitor_admission_count_chk` CHECK(`visitor_admission`.`request_count` BETWEEN 0 AND 30),
	CONSTRAINT `visitor_admission_lease_chk` CHECK((`visitor_admission`.`lease_token` IS NULL AND `visitor_admission`.`lease_expires_at` IS NULL) OR (`visitor_admission`.`lease_token` IS NOT NULL AND `visitor_admission`.`lease_expires_at` IS NOT NULL AND `visitor_admission`.`expires_at` >= `visitor_admission`.`lease_expires_at`))
);
--> statement-breakpoint
CREATE INDEX `visitor_admission_expiry_idx` ON `visitor_admission` (`expires_at`);