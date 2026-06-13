CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructors_and_semesters TEXT NOT NULL,
    prerequisites TEXT NOT NULL,
    corequisites TEXT NOT NULL,
    content_hash TEXT NOT NULL
);
