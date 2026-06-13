export type LogicalReq =
	| { type: "course"; data: string }
	| { type: "group"; data: { operator: "AND" | "OR"; groups: LogicalReq[] } };

export type Course = {
	id: string;
	name: string;
	description: string;
	instructors_and_semesters: string[];
	prereqsText: string;
	coreqsText: string;
	restrictionsText: string;
	logicalPrerequisites: LogicalReq | null;
	logicalCorequisites: LogicalReq | null;
};

type CourseRow = {
	id: string;
	name: string;
	description: string;
	instructors_and_semesters: string;
	prerequisites: string;
	corequisites: string;
	restrictions_text: string;
	logical_prerequisites: string | null;
	logical_corequisites: string | null;
	content_hash: string;
};

const parseLogical = (raw: string | null): LogicalReq | null =>
	raw === null ? null : JSON.parse(raw);

const rowToCourse = (r: CourseRow): Course => ({
	id: r.id,
	name: r.name,
	description: r.description,
	instructors_and_semesters: JSON.parse(r.instructors_and_semesters),
	prereqsText: r.prerequisites,
	coreqsText: r.corequisites,
	restrictionsText: r.restrictions_text,
	logicalPrerequisites: parseLogical(r.logical_prerequisites),
	logicalCorequisites: parseLogical(r.logical_corequisites),
});

export const courseToYaml = (c: Course): string => {
	const lines = [
		`id: ${c.id}`,
		`name: ${c.name}`,
		`description: ${JSON.stringify(c.description)}`, // quote for newlines/colons
		`instructors_and_semesters:`,
		...c.instructors_and_semesters.map((s) => `  - ${JSON.stringify(s)}`),
		`prerequisites: ${JSON.stringify(c.prereqsText)}`,
		`corequisites: ${JSON.stringify(c.coreqsText)}`,
		`restrictions: ${JSON.stringify(c.restrictionsText)}`,
	];
	if (c.logicalPrerequisites) {
		lines.push(`logical_prerequisites: ${JSON.stringify(c.logicalPrerequisites)}`);
	}
	if (c.logicalCorequisites) {
		lines.push(`logical_corequisites: ${JSON.stringify(c.logicalCorequisites)}`);
	}
	return lines.join("\n");
};

const D1_PARAM_CHUNK = 100;

export async function getExistingHashes(
	db: D1Database,
	ids: string[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (let i = 0; i < ids.length; i += D1_PARAM_CHUNK) {
		const chunk = ids.slice(i, i + D1_PARAM_CHUNK);
		const placeholders = chunk.map(() => "?").join(",");
		const { results } = await db
			.prepare(`SELECT id, content_hash FROM courses WHERE id IN (${placeholders})`)
			.bind(...chunk)
			.all<{ id: string; content_hash: string }>();
		for (const r of results) map.set(r.id, r.content_hash);
	}
	return map;
}

export async function upsertCourses(
	db: D1Database,
	entries: { course: Course; hash: string }[],
): Promise<void> {
	if (entries.length === 0) return;
	const stmt = db.prepare(
		`INSERT INTO courses (id, name, description, instructors_and_semesters, prerequisites, corequisites, restrictions_text, logical_prerequisites, logical_corequisites, content_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name,
		   description = excluded.description,
		   instructors_and_semesters = excluded.instructors_and_semesters,
		   prerequisites = excluded.prerequisites,
		   corequisites = excluded.corequisites,
		   restrictions_text = excluded.restrictions_text,
		   logical_prerequisites = excluded.logical_prerequisites,
		   logical_corequisites = excluded.logical_corequisites,
		   content_hash = excluded.content_hash`,
	);
	const batch = entries.map(({ course, hash }) =>
		stmt.bind(
			course.id,
			course.name,
			course.description,
			JSON.stringify(course.instructors_and_semesters),
			course.prereqsText,
			course.coreqsText,
			course.restrictionsText,
			course.logicalPrerequisites === null ? null : JSON.stringify(course.logicalPrerequisites),
			course.logicalCorequisites === null ? null : JSON.stringify(course.logicalCorequisites),
			hash,
		),
	);
	await db.batch(batch);
}

export async function getAllCourses(db: D1Database): Promise<Course[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, description, instructors_and_semesters, prerequisites, corequisites, restrictions_text, logical_prerequisites, logical_corequisites, content_hash
			 FROM courses`,
		)
		.all<CourseRow>();
	return results.map(rowToCourse);
}

export async function getCoursesByIds(
	db: D1Database,
	ids: string[],
): Promise<Map<string, Course>> {
	const map = new Map<string, Course>();
	for (let i = 0; i < ids.length; i += D1_PARAM_CHUNK) {
		const chunk = ids.slice(i, i + D1_PARAM_CHUNK);
		const placeholders = chunk.map(() => "?").join(",");
		const { results } = await db
			.prepare(
				`SELECT id, name, description, instructors_and_semesters, prerequisites, corequisites, restrictions_text, logical_prerequisites, logical_corequisites, content_hash
				 FROM courses WHERE id IN (${placeholders})`,
			)
			.bind(...chunk)
			.all<CourseRow>();
		for (const r of results) map.set(r.id, rowToCourse(r));
	}
	return map;
}
