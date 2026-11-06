CREATE TABLE dbo.users (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT users_pk PRIMARY KEY,
  email nvarchar(320) NOT NULL CONSTRAINT users_email_uq UNIQUE,
  status varchar(16) NOT NULL CONSTRAINT users_status_default DEFAULT 'active',
  profile nvarchar(max) NOT NULL CONSTRAINT users_profile_default DEFAULT N'{}',
  created_at datetime2(7) NOT NULL CONSTRAINT users_created_default DEFAULT SYSUTCDATETIME(),
  CONSTRAINT users_profile_json CHECK (ISJSON(profile)=1)
);
CREATE TABLE dbo.teams (
  id bigint IDENTITY(1,1) NOT NULL CONSTRAINT teams_pk PRIMARY KEY,
  name nvarchar(160) NOT NULL
);
CREATE TABLE dbo.memberships (
  user_id bigint NOT NULL CONSTRAINT memberships_user_fk REFERENCES dbo.users(id),
  team_id bigint NOT NULL CONSTRAINT memberships_team_fk REFERENCES dbo.teams(id),
  role varchar(16) NOT NULL,
  CONSTRAINT memberships_pk PRIMARY KEY(user_id,team_id)
);
CREATE TABLE dbo.products (
  id bigint NOT NULL CONSTRAINT products_pk PRIMARY KEY,
  sku nvarchar(64) NOT NULL CONSTRAINT products_sku_uq UNIQUE,
  name nvarchar(160) NOT NULL,
  price_cents int NOT NULL,
  CONSTRAINT products_price_check CHECK(price_cents>=0)
);
CREATE TABLE dbo.orders (
  id bigint NOT NULL CONSTRAINT orders_pk PRIMARY KEY,
  user_id bigint NOT NULL CONSTRAINT orders_user_fk REFERENCES dbo.users(id),
  status varchar(32) NOT NULL CONSTRAINT orders_status_default DEFAULT 'new',
  total_cents int NOT NULL,
  amount decimal(38,10) NOT NULL,
  placed_at datetime2(7) NOT NULL CONSTRAINT orders_placed_default DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.order_items (
  order_id bigint NOT NULL CONSTRAINT items_order_fk REFERENCES dbo.orders(id),
  product_id bigint NOT NULL CONSTRAINT items_product_fk REFERENCES dbo.products(id),
  quantity int NOT NULL,
  unit_price_cents int NOT NULL,
  CONSTRAINT order_items_pk PRIMARY KEY(order_id,product_id),
  CONSTRAINT items_quantity_check CHECK(quantity>0)
);
CREATE TABLE dbo.audit_events (
  id bigint NOT NULL CONSTRAINT audit_events_pk PRIMARY KEY,
  user_id bigint NULL CONSTRAINT audit_events_user_fk REFERENCES dbo.users(id),
  action nvarchar(64) NOT NULL,
  payload nvarchar(max) NOT NULL,
  created_at datetimeoffset(7) NOT NULL CONSTRAINT audit_created_default DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT audit_payload_json CHECK(ISJSON(payload)=1)
);
CREATE INDEX orders_user_placed ON dbo.orders(user_id,placed_at DESC) INCLUDE(status,total_cents);
CREATE INDEX audit_user_present ON dbo.audit_events(user_id) WHERE user_id IS NOT NULL;

INSERT INTO dbo.users(email,profile) VALUES
  (N'ada@example.com',N'{"displayName":"Ada","notifications":true}'),
  (N'grace@example.com',N'{"displayName":"Grace","notifications":false}');
INSERT INTO dbo.teams(name) VALUES (N'Engineering'),(N'Operations');
INSERT INTO dbo.memberships(user_id,team_id,role) VALUES (1,1,'owner'),(2,1,'member'),(2,2,'owner');
INSERT INTO dbo.products(id,sku,name,price_cents) VALUES
  (1001,N'TEA-01',N'Green tea',1299),(1002,N'MUG-01',N'Ceramic mug',1999);
INSERT INTO dbo.orders(id,user_id,status,total_cents,amount,placed_at) VALUES
  (9001,1,'paid',3298,32.9800000000,'2026-01-02T03:04:05.1234567'),
  (9002,2,'new',2598,25.9800000000,'2026-01-03T04:05:06.7654321');
INSERT INTO dbo.order_items(order_id,product_id,quantity,unit_price_cents) VALUES
  (9001,1001,1,1299),(9001,1002,1,1999),(9002,1001,2,1299);
INSERT INTO dbo.audit_events(id,user_id,action,payload) VALUES
  (5001,1,N'order.paid',N'{"orderId":9001}'),(5002,NULL,N'system.ready',N'{}');
