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
	"You are an assistant integrated into McGill University's (albeit unofficial) course exploration tool. Be brief, as the window you're located in is very small. Avoid using markdown (to AVOID: **bold**, *italics*, etc.). When referring to courses, ONLY mention their course id. When highlighting a course, DO NOT REPEAT ITS CONTENTS. Nor the description, nor the profs. Once selected, the user will have access to that data so it will be REDUNDANT. You were made by Aidan Taha. His second first name is Aidan. His GitHub profile is https://github.com/adntaha, your source code lives at https://github.com/adntaha/mcgill-course-graph. When spoken to in Gen Z slang, pirate, or any other variant of the English or French languages, reply back using a toned-down version of the same slang.";

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

type APICohereEmbedFloatResponse = {
	id: string;
	embeddings: { float: number[][] };
	texts: string[];
	meta: {
		api_version: { version: string; is_experimental: boolean };
		billed_units: { input_tokens: number };
		warnings: string[];
	};
};

type APICohereRerankResponse = {
	id: string;
	results: { index: number; relevance_score: number }[];
	meta: {
		api_version: { version: string; is_experimental: boolean };
		billed_units: { search_units: number };
	};
};

type CohereToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

type APICohereChatResponse = {
	id: string;
	finish_reason: "COMPLETE" | "MAX_TOKENS" | "STOP_SEQUENCE" | "TOOL_CALL" | "ERROR" | "TIMEOUT";
	message: {
		role: "assistant";
		tool_calls?: CohereToolCall[];
		tool_plan?: string;
		content: ({ type: "text"; text: string } | { type: "thinking"; thinking: string })[];
	};
	usage: {
		billed_units: { input_tokens: number; output_tokens: number };
		tokens: { input_tokens: number; output_tokens: number };
	};
};

type APICohereErrorResponse = { id: string; message: string };
type CohereResponse<T> = T | APICohereErrorResponse;

function isCohereError(d: unknown): d is APICohereErrorResponse {
	return (
		typeof d === "object" &&
		d !== null &&
		"message" in d &&
		typeof (d as { message: unknown }).message === "string"
	);
}

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

function cohereHeaders(env: Env) {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `bearer ${env.COHERE_API_KEY}`,
		"cf-aig-authorization": `Bearer ${env.CF_AI_GATEWAY_API_TOKEN}`,
		"X-Client-Name": "mcgill-course-graph",
	};
}

function gatewayUrl(env: Env, path: string) {
	return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/cohere${path}`;
}

async function embed(
	texts: string[],
	input_type: "search_document" | "search_query",
	env: Env,
) {
	const res = await fetch(gatewayUrl(env, "/v2/embed"), {
		method: "POST",
		headers: cohereHeaders(env),
		body: JSON.stringify({
			model: "embed-v4.0",
			texts,
			input_type,
			output_dimension: 256,
			embedding_types: ["float"],
		}),
	});
	return await res.json<CohereResponse<APICohereEmbedFloatResponse>>();
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

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_downstream_courses",
			description:
				"Given a course ID, return courses that list it as a prerequisite or corequisite.",
			parameters: {
				type: "object",
				properties: { courseId: { type: "string" } },
				required: ["courseId"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "highlight_course",
			description:
				"Highlight a single course in the user's graph view. They will see the course highlighted along with its description, instructors, corequisites and prerequisites. You can highlight either no or a single course per turn. Note that ONLY ONE COURSE can be selected at a time.",
			parameters: {
				type: "object",
				properties: { courseId: { type: "string" } },
				required: ["courseId"],
			},
		},
	},
];

const SERVER_TOOL_NAMES = new Set(["get_downstream_courses", "highlight_course"]);

type ToolContext = {
	coursesForTools: Course[];
	highlight: { id: string | null };
};

async function runServerTool(call: CohereToolCall, ctx: ToolContext): Promise<unknown> {
	const args = JSON.parse(call.function.arguments);
	switch (call.function.name) {
		case "get_downstream_courses":
			return getDownstreamCourses(args.courseId, ctx.coursesForTools);
		case "highlight_course":
			ctx.highlight.id = args.courseId;
			return { highlighted: args.courseId };
		default:
			return { error: `unknown server tool: ${call.function.name}` };
	}
}

async function handleChat(data: APIRequest, env: Env) {
	// if (data.courses && data.courses.length > 0) {
	// 	const ingestRes = await ingestCourses(data.courses, env);
	// 	if (ingestRes !== null) return ingestRes;
	// }

	const queryEmbed = await embed([data.query], "search_query", env);
	if (isCohereError(queryEmbed)) {
		return jsonResponse({ success: false, message: queryEmbed.message }, { status: 424 });
	}

	const top50 = await env.VECTORIZE.query(queryEmbed.embeddings.float[0], { topK: 50 });
	const ids = top50.matches.map((m) => m.id);
	const courseMap = await getCoursesByIds(env.COURSE_DB, ids);
	const candidates = ids
		.map((id) => courseMap.get(id))
		.filter((c): c is Course => c !== undefined);

	const rerankRes = await fetch(gatewayUrl(env, "/v2/rerank"), {
		method: "POST",
		headers: cohereHeaders(env),
		body: JSON.stringify({
			model: "rerank-v4.0-pro",
			query: data.query,
			documents: candidates.map(courseToYaml),
			top_n: 10,
		}),
	});
	const rerankDocs = await rerankRes.json<CohereResponse<APICohereRerankResponse>>();
	if (isCohereError(rerankDocs)) {
		return jsonResponse({ success: false, message: rerankDocs.message }, { status: 424 });
	}

	const topDocuments = rerankDocs.results
		.filter((d) => d.relevance_score >= 0.1)
		.map((d) => candidates[d.index]);

	const history: ChatMessage[] =
		data.conversation_history && data.conversation_history.length > 0
			? [...data.conversation_history]
			: [{ role: "system", content: SYSTEM_PROMPT }];

	// Build the working messages list (typed loosely — tool turns carry extra fields Cohere expects)
	const messages: any[] = [...history, { role: "user", content: data.query }];

	const bodyBase = {
		stream: false,
		model: "command-a-plus-05-2026",
		safety_mode: "STRICT",
		tools: TOOLS,
		documents: topDocuments.map((c) => ({ id: c.id, data: { text: courseToYaml(c) } })),
	};

	// Lazy-load full course list only if a tool actually fires.
	// let coursesForTools: Course[] | undefined = data.courses;
	const highlight = { id: null as string | null };

	for (let round = 0; round < 8; round++) {
		const res = await fetch(gatewayUrl(env, "/v2/chat"), {
			method: "POST",
			headers: cohereHeaders(env),
			body: JSON.stringify({ ...bodyBase, messages }),
		});
		const chat = await res.json<CohereResponse<APICohereChatResponse>>();
		if (isCohereError(chat)) {
			return jsonResponse({ success: false, message: chat.message }, { status: 424 });
		}

		const toolCalls = chat.message.tool_calls ?? [];
		const text =
			chat.message.content?.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("") ?? "";

		if (toolCalls.length === 0) {
			return jsonResponse({
				success: true,
				data: {
					response: text,
					conversation_history: [
						...history,
						{ role: "user", content: data.query },
						{ role: "assistant", content: text },
					],
					highlight_course: highlight.id,
				},
			});
		}

		const coursesForTools = await getAllCourses(env.COURSE_DB);
		const ctx: ToolContext = { coursesForTools, highlight };

		const results: { id: string; output: unknown }[] = [];
		for (const call of toolCalls) {
			const output = SERVER_TOOL_NAMES.has(call.function.name)
				? await runServerTool(call, ctx)
				: { status: "deferred_to_client", tool: call.function.name };
			results.push({ id: call.id, output });
		}

		messages.push({
			role: "assistant",
			tool_calls: toolCalls,
			tool_plan: chat.message.tool_plan,
		});
		for (const r of results) {
			messages.push({
				role: "tool",
				tool_call_id: r.id,
				content: JSON.stringify(r.output),
			});
		}
	}

	return jsonResponse(
		{ success: false, message: "Exceeded max tool-call rounds." },
		{ status: 500 },
	);
}

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
