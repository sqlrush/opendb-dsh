-- ddl_lab v1：建 schema 与四张表
CREATE SCHEMA ddl_lab;
CREATE TABLE ddl_lab.orders (id bigint NOT NULL, customer_id bigint NOT NULL, amount numeric(12,2) NOT NULL, created_at timestamp NOT NULL DEFAULT now(), CONSTRAINT orders_pkey PRIMARY KEY (id));
CREATE TABLE ddl_lab.customers (id bigint NOT NULL, name varchar(96), region_id integer NOT NULL, CONSTRAINT customers_pkey PRIMARY KEY (id));
CREATE TABLE ddl_lab.products (id integer NOT NULL, sku varchar(32) NOT NULL, name varchar(96), CONSTRAINT products_pkey PRIMARY KEY (id));
CREATE TABLE ddl_lab.audit_log (id bigint NOT NULL, msg text, logged_at timestamp NOT NULL DEFAULT now());
