-- ddl_lab v2：加列、加索引
ALTER TABLE ddl_lab.orders ADD COLUMN status integer NOT NULL DEFAULT 0;
CREATE INDEX orders_customer_idx ON ddl_lab.orders (customer_id);
ALTER TABLE ddl_lab.customers ADD COLUMN email varchar(128);
