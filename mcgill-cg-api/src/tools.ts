import { getAllCourses, type LogicalReq } from "./db";

type Dependent = {
	id: string;
	relation: "prereq" | "coreq";
};

const COURSE_ID = /\b[A-Z]{4}\s?\d{3}[A-Z]?\d?\b/g;

export const normalize = (courseId: string) => courseId.replace(/\s/g, "");

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




// for the following code, thanks claude!
// ---------------------------------------------------------------------------

function isCourseLeaf(r: LogicalReq): r is Extract<LogicalReq, { type: "course" }> {
	return r.type === "course";
}

function readGroup(r: LogicalReq): { op: "AND" | "OR"; children: LogicalReq[] } {
	const g = r as Extract<LogicalReq, { type: "group" }>;
	return { op: g.data.operator, children: g.data.groups };
}

type PrereqCourse = {
	id: string;
	logicalPrerequisites: LogicalReq | null;
};

type CourseNode = {
	kind: "course";
	id: string;
	taken?: boolean; // eligibility mode only: is it in `completed`?
	missing?: boolean; // id not present in the course set
	cycle?: boolean; // id is already an ancestor (loop guard tripped)
	requires?: TreeNode | null; // expansion of THIS course's own prerequisites
};

type GroupNode = {
	kind: "group";
	op: "AND" | "OR";
	satisfied?: boolean; // eligibility mode only
	children: TreeNode[];
};

type TreeNode = CourseNode | GroupNode;

export type PrereqTreeResult = {
	course: string;
	found: boolean;
	tree: TreeNode | null; // null => the course has no prerequisites
	allCourses: string[]; // every distinct course id referenced in the tree
	eligible?: boolean; // only set when `completed` is provided
	truncated: boolean; // depth or node-budget cap was hit
};

const MAX_DEPTH = 8;
const NODE_BUDGET = 300;

const isSat = (n: TreeNode): boolean =>
	n.kind === "group" ? !!n.satisfied : !!n.taken;

/**
 * Build the full prerequisite tree of `courseId`, expanding transitively through
 * each prerequisite's own prerequisites.
 *
 * If `completed` is given, the tree is annotated for eligibility:
 *   - course nodes get `taken` (in `completed`?),
 *   - group nodes get `satisfied` (AND => all children; OR => any child),
 *   - a top-level `eligible` flag reports whether the course can be taken now.
 * In eligibility mode, expansion stops under courses you've already taken (their
 * own chain is moot); it keeps expanding under not-taken courses so the caller
 * can see what would be needed to unlock them.
 */
export async function getPrerequisiteTree(
	courseId: string,
	env: Env,
	completed?: string[],
) {
	const courses = await getAllCourses(env.COURSE_DB);
	const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();
	const byId = new Map(courses.map((c) => [norm(c.id), c]));
	const done = completed ? new Set(completed.map(norm)) : null;

	const allCourses = new Set<string>();
	let truncated = false;
	let budget = NODE_BUDGET;

	function expandCourse(id: string, ancestors: Set<string>, depth: number): CourseNode {
		const key = norm(id);
		const display = byId.get(key)?.id ?? id; // prefer canonical casing
		allCourses.add(display);

		const node: CourseNode = { kind: "course", id: display };
		if (done) node.taken = done.has(key);

		// Already taken: satisfied, no need to expand its chain.
		if (done?.has(key)) return node;

		if (ancestors.has(key)) {
			node.cycle = true;
			return node;
		}
		const course = byId.get(key);
		if (!course) {
			node.missing = true;
			return node;
		}
		if (depth <= 0 || budget <= 0) {
			truncated = true;
			return node;
		}
		const req = course.logicalPrerequisites;
		if (req == null) {
			node.requires = null;
			return node;
		}
		const next = new Set(ancestors);
		next.add(key);
		node.requires = expandReq(req, next, depth - 1);
		return node;
	}

	function expandReq(req: LogicalReq, ancestors: Set<string>, depth: number): TreeNode {
		if (budget-- <= 0) {
			truncated = true;
			return { kind: "group", op: "AND", children: [] };
		}
		if (isCourseLeaf(req)) return expandCourse(req.data, ancestors, depth);

		const { op, children } = readGroup(req);
		const kids = children.map((ch) => expandReq(ch, ancestors, depth));
		if (!done) return { kind: "group", op, children: kids };

		const satisfied = op === "AND" ? kids.every(isSat) : kids.some(isSat);
		return { kind: "group", op, children: kids, satisfied };
	}

	const rootKey = norm(courseId);
	const root = byId.get(rootKey);
	if (!root) {
		return { course: courseId, found: false, tree: null, allCourses: [], truncated: false };
	}

	const req = root.logicalPrerequisites;
	const tree = req == null ? null : expandReq(req, new Set([rootKey]), MAX_DEPTH);

	const result: PrereqTreeResult = {
		course: root.id,
		found: true,
		tree,
		allCourses: [...allCourses].sort(),
		truncated,
	};
	if (done) result.eligible = tree == null ? true : isSat(tree);
	return result;
}
