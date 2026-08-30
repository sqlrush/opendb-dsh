-- 2026-08-30 表结构变更追溯 R2：字典除签名外存下定义原文（表=列清单 name:type:notnull，索引=indexdef，视图=定义），
-- 变更记录同时存旧/新定义，报告才能给出列/索引级 diff 与"某生命时段里表结构变了什么"。升级后首次快照回填 definition，不记为变更。
ALTER TABLE opendb_dict_objects ADD COLUMN IF NOT EXISTS definition text;
ALTER TABLE opendb_dict_changes ADD COLUMN IF NOT EXISTS old_definition text;
ALTER TABLE opendb_dict_changes ADD COLUMN IF NOT EXISTS new_definition text;
