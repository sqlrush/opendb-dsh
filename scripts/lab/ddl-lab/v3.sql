-- ddl_lab v3：改列类型、换索引、中途新建表
ALTER TABLE ddl_lab.orders ALTER COLUMN amount TYPE numeric(18,2);
DROP INDEX ddl_lab.orders_customer_idx;
CREATE INDEX orders_status_idx ON ddl_lab.orders (status, customer_id);
CREATE TABLE ddl_lab.shipments (id bigint NOT NULL, order_id bigint NOT NULL, carrier varchar(64), shipped_at timestamp, CONSTRAINT shipments_pkey PRIMARY KEY (id));
