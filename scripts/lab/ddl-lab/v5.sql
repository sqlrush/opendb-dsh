-- ddl_lab v5：再改一次 + 视图
ALTER TABLE ddl_lab.shipments ADD COLUMN eta date;
ALTER TABLE ddl_lab.products ALTER COLUMN sku TYPE varchar(64);
CREATE VIEW ddl_lab.order_summary AS SELECT o.id, o.customer_id, o.amount, o.status, c.name AS customer_name FROM ddl_lab.orders o JOIN ddl_lab.customers c ON c.id = o.customer_id;
