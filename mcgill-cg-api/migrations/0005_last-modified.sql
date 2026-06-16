ALTER TABLE courses ADD COLUMN last_modified DATETIME;
UPDATE courses SET last_modified = unixepoch();
