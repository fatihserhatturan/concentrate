CREATE TABLE shipments (
  id INT IDENTITY PRIMARY KEY,
  order_id INT NOT NULL,
  tracking_code NVARCHAR(64) NOT NULL,
  status NVARCHAR(16) NOT NULL
);
