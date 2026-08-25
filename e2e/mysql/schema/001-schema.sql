CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  profile JSON NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE projects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  budget DECIMAL(14, 2),
  CONSTRAINT projects_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE codec_fidelity (
  id INT NOT NULL PRIMARY KEY,
  boolean_value TINYINT(1) NOT NULL,
  tinyint_value TINYINT NOT NULL,
  smallint_value SMALLINT NOT NULL,
  mediumint_value MEDIUMINT NOT NULL,
  integer_value INT NOT NULL,
  bigint_value BIGINT NOT NULL,
  decimal_value DECIMAL(30, 10) NOT NULL,
  float_value FLOAT NOT NULL,
  double_value DOUBLE NOT NULL,
  bit_value BIT(8) NOT NULL,
  text_value TEXT NOT NULL,
  varchar_value VARCHAR(40) NOT NULL,
  binary_value VARBINARY(8) NOT NULL,
  blob_value BLOB NOT NULL,
  date_value DATE NOT NULL,
  datetime_value DATETIME(3) NOT NULL,
  timestamp_value TIMESTAMP(3) NOT NULL,
  time_value TIME NOT NULL,
  year_value YEAR NOT NULL,
  json_value JSON NOT NULL,
  enum_value ENUM('ready', 'waiting') NOT NULL,
  set_value SET('read', 'write') NOT NULL,
  nullable_text TEXT
);

CREATE FUNCTION user_count() RETURNS BIGINT DETERMINISTIC
RETURN (SELECT COUNT(*) FROM users);
