-- +goose Up
CREATE TABLE orders (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  KEY idx_orders_user (user_id)
) ENGINE=InnoDB;

CREATE TABLE legacy_audit (id INT);
DROP TABLE legacy_audit;

-- +goose Down
DROP TABLE orders;
