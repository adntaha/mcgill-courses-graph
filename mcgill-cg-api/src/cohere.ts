import { Course, courseToYaml } from "./db";


export type CohereToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
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

export function isCohereError(d: unknown): d is APICohereErrorResponse {
	return (
		typeof d === "object" &&
		d !== null &&
		"message" in d &&
		typeof (d as { message: unknown }).message === "string"
	);
}

function gatewayUrl(env: Env, path: string) {
	return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/cohere${path}`;
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

export async function embed(
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

export async function rerank(
	query: string,
	documents: Course[],
	env: Env,
	top_n = 10
) {
	const rerankRes = await fetch(gatewayUrl(env, "/v2/rerank"), {
		method: "POST",
		headers: cohereHeaders(env),
		body: JSON.stringify({
			model: "rerank-v4.0-pro",
			query,
			documents: documents.map(courseToYaml),
			top_n: 10,
		}),
	});

	return await rerankRes.json<CohereResponse<APICohereRerankResponse>>();
}

export async function chat(messages: any[], topDocuments: Course[], tools: any[], env: Env) {
	const bodyBase = {
		stream: false,
		model: "command-a-plus-05-2026",
		safety_mode: "STRICT",
		tools,
		documents: topDocuments.map((c) => ({ id: c.id, data: { text: courseToYaml(c) } })),
	};

	const res = await fetch(gatewayUrl(env, "/v2/chat"), {
		method: "POST",
		headers: cohereHeaders(env),
		body: JSON.stringify({ ...bodyBase, messages }),
	});

	return await res.json<CohereResponse<APICohereChatResponse>>();
}
