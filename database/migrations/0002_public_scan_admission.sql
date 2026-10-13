CREATE TABLE `investigation_scan_admission` (
	`client_key` char(64) NOT NULL,
	`window_hour` int unsigned NOT NULL,
	`accepted_count` int unsigned NOT NULL DEFAULT 1,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `investigation_scan_admission_client_key_window_hour_pk` PRIMARY KEY(`client_key`,`window_hour`),
	CONSTRAINT `investigation_scan_admission_key_chk` CHECK(`investigation_scan_admission`.`client_key` REGEXP '^[0-9a-f]{64}$' AND CAST(`investigation_scan_admission`.`client_key` AS BINARY) = CAST(LOWER(`investigation_scan_admission`.`client_key`) AS BINARY)),
	CONSTRAINT `investigation_scan_admission_count_chk` CHECK(`investigation_scan_admission`.`accepted_count` BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `investigation_scan_admission_expiry_idx` ON `investigation_scan_admission` (`expires_at`);