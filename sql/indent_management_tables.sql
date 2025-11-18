-- SQL definition for indent management feature

CREATE TABLE IF NOT EXISTS indent_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    filler_id BIGINT UNSIGNED NOT NULL,
    goods_description VARCHAR(255) NOT NULL,
    quantity_requested DECIMAL(12,2) NOT NULL,
    request_date DATE NOT NULL,
    used_last_month INT UNSIGNED DEFAULT 0,
    used_last_seven_days INT UNSIGNED DEFAULT 0,
    status ENUM('open', 'proceeding', 'arrived') DEFAULT 'open',
    proceeded_by BIGINT UNSIGNED DEFAULT NULL,
    proceed_date DATETIME DEFAULT NULL,
    arrived_by BIGINT UNSIGNED DEFAULT NULL,
    arrival_date DATETIME DEFAULT NULL,
    final_quantity DECIMAL(12,2) DEFAULT NULL,
    remark VARCHAR(500) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_indent_requests_filler FOREIGN KEY (filler_id) REFERENCES users(id),
    CONSTRAINT fk_indent_requests_proceeded FOREIGN KEY (proceeded_by) REFERENCES users(id),
    CONSTRAINT fk_indent_requests_arrived FOREIGN KEY (arrived_by) REFERENCES users(id),
    INDEX idx_indent_requests_status (status),
    INDEX idx_indent_requests_filler (filler_id),
    INDEX idx_indent_requests_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS indent_request_audit (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    request_id BIGINT UNSIGNED NOT NULL,
    changed_by BIGINT UNSIGNED NOT NULL,
    previous_status ENUM('open', 'proceeding', 'arrived') NOT NULL,
    new_status ENUM('open', 'proceeding', 'arrived') NOT NULL,
    note VARCHAR(500) DEFAULT NULL,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_indent_audit_request FOREIGN KEY (request_id) REFERENCES indent_requests(id),
    CONSTRAINT fk_indent_audit_user FOREIGN KEY (changed_by) REFERENCES users(id),
    INDEX idx_indent_audit_request (request_id)
);
