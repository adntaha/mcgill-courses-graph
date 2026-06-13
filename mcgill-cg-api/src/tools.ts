import { getAllCourses } from "./db";

type CourseLike = {
	id: string;
	prereqsText: string;
	coreqsText: string;
};

type Dependent = {
	id: string;
	relation: "prereq" | "coreq";
};

const COURSE_ID = /\b[A-Z]{4}\s?\d{3}[A-Z]?\d?\b/g;

const normalize = (raw: string) => raw.replace(/\s/g, "");

export async function getDownstreamCourses(
	courseId: string,
	env: Env
) {
	const courses = await getAllCourses(env.COURSE_DB);
	const dependents: Dependent[] = [];
	const target = normalize(courseId);

	for (const c of courses) {
		const prereqIds = (c.prereqsText.match(COURSE_ID) ?? []).map(normalize);
		if (prereqIds.includes(target)) {
			dependents.push({ id: c.id, relation: "prereq" });
		}

		const coreqIds = (c.coreqsText.match(COURSE_ID) ?? []).map(normalize);
		if (coreqIds.includes(target)) {
			dependents.push({ id: c.id, relation: "coreq" });
		}
	}

	return dependents;
}
