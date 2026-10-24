-- GBRA-156: does keeping search_vector in the main heap (STORAGE MAIN) remove the
-- ts_rank detoast reads of a first-touch keyword statement? A copy of the
-- columns the keyword statement's candidate step reads, stored MAIN, with the
-- same GIN index. Run once; the experiment queries are in toast-main-probe.sh.
DROP TABLE IF EXISTS cc_main;
CREATE TABLE cc_main (id bigint PRIMARY KEY, page_id int, modality text, search_vector tsvector);
ALTER TABLE cc_main ALTER COLUMN search_vector SET STORAGE MAIN;
INSERT INTO cc_main SELECT id, page_id, modality, search_vector FROM content_chunks;
CREATE INDEX cc_main_sv ON cc_main USING gin (search_vector);
DROP TABLE IF EXISTS cc_ext;
CREATE TABLE cc_ext (id bigint PRIMARY KEY, page_id int, modality text, search_vector tsvector);
INSERT INTO cc_ext SELECT id, page_id, modality, search_vector FROM content_chunks;
CREATE INDEX cc_ext_sv ON cc_ext USING gin (search_vector);
VACUUM ANALYZE cc_main; VACUUM ANALYZE cc_ext;
SELECT relname, pg_size_pretty(pg_relation_size(oid)) heap, pg_size_pretty(pg_relation_size(reltoastrelid)) toast FROM pg_class WHERE relname IN ('cc_main','cc_ext','content_chunks');
