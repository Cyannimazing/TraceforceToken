CREATE TABLE `investigation_evidence` (
	`id` char(36) NOT NULL,
	`investigation_id` char(36) NOT NULL,
	`kind` enum('funding','transfer','swap','contract','metadata') NOT NULL,
	`source_event_id` varchar(191) NOT NULL,
	`transaction_hash` char(66),
	`block_number` bigint unsigned,
	`log_index` int unsigned,
	`observed_at` datetime(3) NOT NULL,
	`from_address` char(42),
	`to_address` char(42),
	`asset_address` char(42),
	`asset_symbol` varchar(64),
	`amount_raw` varchar(78),
	`description` text NOT NULL,
	`provenance` json NOT NULL,
	`details` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `investigation_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `evidence_investigation_source_uidx` UNIQUE(`investigation_id`,`source_event_id`),
	CONSTRAINT `evidence_transaction_hash_chk` CHECK(`investigation_evidence`.`transaction_hash` IS NULL OR (`investigation_evidence`.`transaction_hash` REGEXP '^0x[0-9a-f]{64}$' AND CAST(`investigation_evidence`.`transaction_hash` AS BINARY) = CAST(LOWER(`investigation_evidence`.`transaction_hash`) AS BINARY))),
	CONSTRAINT `evidence_from_address_chk` CHECK(`investigation_evidence`.`from_address` IS NULL OR (`investigation_evidence`.`from_address` REGEXP '^0x[0-9a-f]{40}$' AND CAST(`investigation_evidence`.`from_address` AS BINARY) = CAST(LOWER(`investigation_evidence`.`from_address`) AS BINARY))),
	CONSTRAINT `evidence_to_address_chk` CHECK(`investigation_evidence`.`to_address` IS NULL OR (`investigation_evidence`.`to_address` REGEXP '^0x[0-9a-f]{40}$' AND CAST(`investigation_evidence`.`to_address` AS BINARY) = CAST(LOWER(`investigation_evidence`.`to_address`) AS BINARY))),
	CONSTRAINT `evidence_asset_address_chk` CHECK(`investigation_evidence`.`asset_address` IS NULL OR (`investigation_evidence`.`asset_address` REGEXP '^0x[0-9a-f]{40}$' AND CAST(`investigation_evidence`.`asset_address` AS BINARY) = CAST(LOWER(`investigation_evidence`.`asset_address`) AS BINARY))),
	CONSTRAINT `evidence_amount_raw_chk` CHECK(`investigation_evidence`.`amount_raw` IS NULL OR (`investigation_evidence`.`amount_raw` REGEXP '^(0|[1-9][0-9]{0,77})$' AND (CHAR_LENGTH(`investigation_evidence`.`amount_raw`) < 78 OR `investigation_evidence`.`amount_raw` <= '115792089237316195423570985008687907853269984665640564039457584007913129639935')))
);
--> statement-breakpoint
CREATE TABLE `investigations` (
	`id` char(36) NOT NULL,
	`chain` enum('base') NOT NULL DEFAULT 'base',
	`chain_id` int unsigned NOT NULL DEFAULT 8453,
	`token_address` char(42) NOT NULL,
	`token_name` varchar(255),
	`token_symbol` varchar(64),
	`token_decimals` int unsigned,
	`total_supply_raw` varchar(78),
	`status` enum('draft','collecting','completed','failed') NOT NULL DEFAULT 'draft',
	`coverage` json,
	`provenance` json,
	`summary` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `investigations_id` PRIMARY KEY(`id`),
	CONSTRAINT `investigations_base_chain_id_chk` CHECK(`investigations`.`chain_id` = 8453),
	CONSTRAINT `investigations_token_address_chk` CHECK(`investigations`.`token_address` REGEXP '^0x[0-9a-f]{40}$' AND CAST(`investigations`.`token_address` AS BINARY) = CAST(LOWER(`investigations`.`token_address`) AS BINARY)),
	CONSTRAINT `investigations_token_decimals_chk` CHECK(`investigations`.`token_decimals` IS NULL OR `investigations`.`token_decimals` <= 255),
	CONSTRAINT `investigations_total_supply_raw_chk` CHECK(`investigations`.`total_supply_raw` IS NULL OR (`investigations`.`total_supply_raw` REGEXP '^(0|[1-9][0-9]{0,77})$' AND (CHAR_LENGTH(`investigations`.`total_supply_raw`) < 78 OR `investigations`.`total_supply_raw` <= '115792089237316195423570985008687907853269984665640564039457584007913129639935')))
);
--> statement-breakpoint
ALTER TABLE `investigation_evidence` ADD CONSTRAINT `investigation_evidence_investigation_id_investigations_id_fk` FOREIGN KEY (`investigation_id`) REFERENCES `investigations`(`id`) ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `evidence_investigation_observed_idx` ON `investigation_evidence` (`investigation_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `evidence_transaction_hash_idx` ON `investigation_evidence` (`transaction_hash`);--> statement-breakpoint
CREATE INDEX `evidence_from_address_idx` ON `investigation_evidence` (`from_address`);--> statement-breakpoint
CREATE INDEX `evidence_to_address_idx` ON `investigation_evidence` (`to_address`);--> statement-breakpoint
CREATE INDEX `investigations_chain_token_created_idx` ON `investigations` (`chain`,`token_address`,`created_at`);--> statement-breakpoint
CREATE INDEX `investigations_status_created_idx` ON `investigations` (`status`,`created_at`);