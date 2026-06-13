import { chat, CohereToolCall, embed, isCohereError, rerank } from "./cohere";
import {
	courseToYaml,
	getAllCourses,
	getCoursesByIds,
	getExistingHashes,
	upsertCourses,
	type Course,
	type LogicalReq,
} from "./db";
import { getDownstreamCourses } from "./tools";

const SYSTEM_PROMPT =
	"You are an assistant integrated into McGill University's (albeit unofficial) course exploration tool. Be brief, as the window you're located in is very small. Avoid using markdown (to AVOID: **bold**, *italics*, etc.). When referring to courses, ONLY mention their course id. When highlighting a course, DO NOT REPEAT ITS CONTENTS. Nor the description, nor the profs. Once selected, the user will have access to that data so it will be REDUNDANT. You were made by Aidan Taha. His second first name is Aidan. His GitHub profile is https://github.com/adntaha, your source code lives at https://github.com/adntaha/mcgill-course-graph. When spoken to in Gen Z slang, pirate, or any other variant of the English or French languages, reply back using a toned-down version of the same slang. You are ONLY allowed to do 5 tool calls.";

const SEMESTERS = ["Fall 2026", "Winter 2027"];
const SUBJECTS = ["MATH", "COMP", "ECSE", "PHIL", "PHYS", "MIMM", "BIOL", "CHEM", "PHAR", "PHGY"];

type McGillCourse = {
	_id: string;
	title: string;
	credits: string;
	subject: string;
	code: string;
	url: string;
	department: string;
	faculty: string;
	terms: string[];
	description: string;
	instructors: { name: string; term: string }[];
	prerequisitesText?: string;
	corequisitesText?: string;
	prerequisites: string[];
	corequisites: string[];
	leadingTo: string[];
	logicalPrerequisites?: LogicalReq;
	logicalCorequisites?: LogicalReq;
	restrictions: string | null;
	restrictionsText?: string;
	avgRating?: number;
	avgDifficulty?: number;
	reviewCount?: number;
};
type McGillCoursesResponse = { courses: McGillCourse[] };

type ChatMessage = {
	role: "user" | "tool" | "assistant" | "system";
	content: string;
};

type APIRequest = {
	query: string;
	// excludes the above query
	conversation_history?: ChatMessage[];
	// courses?: Course[];
};

type APIResponse =
	| {
		success: true;
		data: {
			response: string;
			// includes the above query
			conversation_history: ChatMessage[];
			highlight_course: string | null;
		};
	}
	| {
		success: false;
		message: string;
	};

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "https://adntaha.github.io",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, cf-turnstile-response",
	"Access-Control-Max-Age": "86400",
};

function jsonResponse(data: APIResponse, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...CORS_HEADERS,
			...(init?.headers ?? {}),
		},
	});
}

async function verifyTurnstile(token: string | null, env: Env) {
	if (!token) return false;
	const form = new FormData();
	form.append("secret", env.CF_TURNSTILE_SECRET_KEY);
	form.append("response", token);
	const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		body: form,
	});
	const data = await res.json<{ success: boolean }>();
	return data.success;
}

async function hashString(text: string) {
	const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ingestCourses(courses: Course[], env: Env) {
	// returns a response if there's an error
	const hashed = await Promise.all(
		courses.map(async (c) => ({ course: c, hash: await hashString(JSON.stringify(c)) })),
	);
	// console.log("hashed", hashed.length);
	const existing = await getExistingHashes(env.COURSE_DB, hashed.map((h) => h.course.id));
	const toEmbed = hashed.filter((h) => existing.get(h.course.id) !== h.hash);
	// console.log("to embed", toEmbed);
	if (toEmbed.length === 0) return null;

	const vectors: VectorizeVector[] = [];
	for (let i = 0; i < toEmbed.length; i += 96) {
		// console.log(`batch ${i}...`);
		const batch = toEmbed.slice(i, i + 96);
		const data = await embed(batch.map((b) => courseToYaml(b.course)), "search_document", env);
		if (isCohereError(data)) {
			return jsonResponse({ success: false, message: data.message }, { status: 424 });
		}
		data.embeddings.float.forEach((emb, j) => {
			vectors.push({ id: batch[j].course.id, values: emb });
		});
	}

	// console.log("uploading...");
	await env.VECTORIZE.upsert(vectors);
	await upsertCourses(env.COURSE_DB, toEmbed);
	return null;
}

async function retrieveCoursesFromQuery(query: string, env: Env): Promise<{ success: true; topDocuments: Course[] } | { success: false, message: string }> {
	const queryEmbed = await embed([query], "search_query", env);
	if (isCohereError(queryEmbed)) {
		return { success: false, message: queryEmbed.message };
	}

	const top50 = await env.VECTORIZE.query(queryEmbed.embeddings.float[0], { topK: 50 });
	const ids = top50.matches.map((m) => m.id);
	const courseMap = await getCoursesByIds(env.COURSE_DB, ids);
	const candidates = ids
		.map((id) => courseMap.get(id))
		.filter((c): c is Course => c !== undefined);

	const rerankDocs = await rerank(query, candidates, env);
	if (isCohereError(rerankDocs)) {
		return { success: false, message: rerankDocs.message };
	}

	const topDocuments = rerankDocs.results
		.filter((d) => d.relevance_score >= 0.1)
		.map((d) => candidates[d.index]);

	return { success: true, topDocuments };
}

/* start tool calling/chat harness */
const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_downstream_courses",
			description:
				"Given an EXACT course ID, return the courses that list it as a direct prerequisite or corequisite — i.e. the courses 'downstream' of it in the prerequisite graph. Use this to answer questions like 'what does this course unlock?' or 'what can I take after X?'. This is an exact-ID lookup, NOT a search: if you only have a topic, a partial name, or an unverified ID, call query_courses first to resolve it. Returns an empty array if no course depends on this one.",
			parameters: {
				type: "object",
				properties: {
					courseId: {
						type: "string",
						description:
							"Exact course ID in catalog format, e.g. \"COMP 250\". Must match a real course ID exactly (subject code + number) — it is not a free-text search term.",
					},
				},
				required: ["courseId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "highlight_course",
			description:
				"Highlight a single course in the user's graph view, revealing its description, instructors, prerequisites, and corequisites to the user. This is a visual UI action: it changes what the USER sees but returns no course data to you, so do not call it to look something up for yourself. At most one course can be highlighted at a time — each call replaces the previously highlighted course. Call this only when the user wants to focus on or inspect a specific course, and only when you already know its exact ID (use query_courses first if you don't).",
			parameters: {
				type: "object",
				properties: {
					courseId: {
						type: "string",
						description:
							"Exact course ID of the single course to highlight, e.g. \"COMP 250\".",
					},
				},
				required: ["courseId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "query_courses",
			description:
				"Semantic search over the course catalog. Returns the 8 courses whose embeddings are nearest to your query, which can be any keyword, topic, phrase, or full sentence (e.g. \"machine learning\", \"introductory probability\", \"courses about databases\"). Use this to discover courses by topic, or to turn a vague or partial reference into concrete course IDs before calling highlight_course or get_downstream_courses. Always returns up to 8 course records.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Natural-language description of the topic or course to find, e.g. \"reinforcement learning\" or \"first-year calculus\".",
					},
				},
				required: ["query"],
			},
		},
	},
];

const SERVER_TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

type ToolContext = {
	highlight: { id: string | null };
	env: Env;
};

async function runServerTool(call: CohereToolCall, ctx: ToolContext): Promise<unknown> {
	const args = JSON.parse(call.function.arguments);
	switch (call.function.name) {
		case "get_downstream_courses":
			return await getDownstreamCourses(args.courseId, ctx.env);
		case "highlight_course":
			ctx.highlight.id = args.courseId;
			return { highlighted: args.courseId };
		case "query_courses":
			const res = await retrieveCoursesFromQuery(args.query, ctx.env);
			return res.success ? res.topDocuments : { error: res.message };
		default:
			return { error: `unknown server tool: ${call.function.name}` };
	}
}

async function handleChat(data: APIRequest, env: Env) {
	// if (data.courses && data.courses.length > 0) {
	// 	const ingestRes = await ingestCourses(data.courses, env);
	// 	if (ingestRes !== null) return ingestRes;
	// }

	const topDocumentsRes = await retrieveCoursesFromQuery(data.query, env);
	if (!topDocumentsRes.success) {
		return jsonResponse(topDocumentsRes, { status: 424 });
	}

	const system_messages = data.conversation_history?.filter((m) => m.role === "system");
	let history: ChatMessage[] =
		data.conversation_history && data.conversation_history.length > 0 && system_messages?.length === 1 && system_messages[0].content === SYSTEM_PROMPT
			? [...data.conversation_history]
			: [{ role: "system", content: SYSTEM_PROMPT }];

	// Build the working messages list (typed loosely — tool turns carry extra fields Cohere expects)
	const messages: any[] = [...history, { role: "user", content: data.query }];

	// Lazy-load full course list only if a tool actually fires.
	// let coursesForTools: Course[] | undefined = data.courses;
	const highlight = { id: null as string | null };

	let round = 0;
	let toolCalls: CohereToolCall[] = []
	let response = "";
	do {
		const chatRes = await chat(messages, topDocumentsRes.topDocuments, TOOLS, env);
		if (isCohereError(chatRes)) {
			return jsonResponse({ success: false, message: chatRes.message }, { status: 424 });
		}

		toolCalls = chatRes.message.tool_calls ?? [];
		response =
			chatRes.message.content?.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("") ?? "";

		if (toolCalls.length === 0) break;

		if (round > 9) {
			return jsonResponse(
				{ success: false, message: "Exceeded max tool-call rounds." },
				{ status: 500 },
			);
		}

		const ctx: ToolContext = { env, highlight };

		const results: { id: string; output: unknown }[] = [];
		for (const call of toolCalls) {
			const output = SERVER_TOOL_NAMES.has(call.function.name)
				? round < 5
					? await runServerTool(call, ctx)
					: { error: "you have exceeded your maximum amount of tool calls. please return a response with the information you already have." }
				: { status: "deferred_to_client", tool: call.function.name };
			results.push({ id: call.id, output });
		}

		messages.push({
			role: "assistant",
			tool_calls: toolCalls,
			tool_plan: chatRes.message.tool_plan,
		});
		for (const r of results) {
			messages.push({
				role: "tool",
				tool_call_id: r.id,
				content: JSON.stringify(r.output),
			});
		}
		round++;
	} while (toolCalls.length !== 0);

	return jsonResponse({
		success: true,
		data: {
			response,
			conversation_history: [
				...history,
				{ role: "user", content: data.query },
				{ role: "assistant", content: response },
			],
			highlight_course: highlight.id,
		},
	});
}
/* end tool calling/chat harness */

function transformCourse(c: McGillCourse) {
	const instructorsForSemesters = c.instructors
		.filter((i) => SEMESTERS.includes(i.term))
		.map((i) => `Prof. ${i.name} (${i.term})`);

	const instructors_and_semesters =
		instructorsForSemesters.length > 0
			? instructorsForSemesters
			: c.terms.filter((t) => SEMESTERS.includes(t));

	const prereqsText = c.prerequisitesText
		? c.prerequisitesText === "This course has no prerequisites."
			? `Prerequisites: ${c.prerequisitesText}`
			: c.prerequisitesText
		: "Prerequisites: This course has no prerequisites.";

	const coreqsText = c.corequisitesText
		? c.corequisitesText === "This course has no corequisites."
			? `Corequisites: ${c.corequisitesText}`
			: c.corequisitesText
		: "Corequisites: This course has no corequisites.";

	return <Course>{
		id: c._id,
		name: c.title,
		description: c.description,
		instructors_and_semesters,
		prereqsText,
		coreqsText,
		restrictionsText: c.restrictionsText ?? "This course has no restrictions.",
		logicalPrerequisites: c.logicalPrerequisites ?? null,
		logicalCorequisites: c.logicalCorequisites ?? null,
	};
}

async function handleSync(env: Env) {
	const url = `https://mcgill.courses/api/courses?terms=${SEMESTERS.join(",")}&subjects=${SUBJECTS.join(",")}`;
	const res = await fetch(url);
	if (!res.ok) {
		return jsonResponse(
			{ success: false, message: `mcgill.courses returned ${res.status}` },
			{ status: 424 },
		);
	}
	const payload = await res.json<McGillCoursesResponse>();
	// console.log(payload.courses.length);
	const courses = payload.courses
		.sort((a, b) => a._id.localeCompare(b._id))
		.map(transformCourse);

	// console.log("now ingesting..");
	const ingestErr = await ingestCourses(courses, env);
	if (ingestErr !== null) return ingestErr;

	return new Response(JSON.stringify({ success: true, ingested: courses.length }), {
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

async function handleCoursesGet(env: Env) {
	const all = await getAllCourses(env.COURSE_DB);
	return new Response(JSON.stringify({ success: true, data: all }), {
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

export default {
	async fetch(request, env, _ctx) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (url.pathname === "/courses" && request.method === "GET") {
			return handleCoursesGet(env);
		}

		if (url.pathname === "/sync" && request.method === "POST") {
			if (request.headers.get("x-sync-secret") !== env.SYNC_SECRET) return new Response("403", { status: 403 });

			return handleSync(env);
		}

		if (request.headers.get("content-type") !== "application/json") {
			return jsonResponse(
				{ success: false, message: "only JSON is supported" },
				{ status: 400 },
			);
		}

		if (url.pathname === "/chat" && request.method === "POST") {
			const token = request.headers.get("cf-turnstile-response");
			if (!(await verifyTurnstile(token, env))) {
				return jsonResponse(
					{ success: false, message: "Turnstile verification failed" },
					{ status: 403 },
				);
			}

			let data: APIRequest;
			try {
				data = await request.json<APIRequest>();
			} catch {
				return jsonResponse(
					{ success: false, message: "Misconstructed body" },
					{ status: 400 },
				);
			}
			return handleChat(data, env);
		}

		return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
	},
} satisfies ExportedHandler<Env>;
