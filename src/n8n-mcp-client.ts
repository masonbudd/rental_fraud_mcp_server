/**
 * Minimal MCP Streamable-HTTP client for the n8n MCP Server Trigger.
 *
 * n8n requires the full handshake on every session: initialize (which returns an
 * Mcp-Session-Id header), notifications/initialized, then tools/call. It answers
 * with text/event-stream, so the JSON-RPC envelope has to be pulled out of the
 * SSE frames.
 */

const N8N_MCP_URL = "https://sigmlabs.app.n8n.cloud/mcp/rental-fraud-mcp-server";
const DEFAULT_HEADER_NAME = "Authorization";
const CALL_TIMEOUT_MS = 170_000;

type JsonRpcEnvelope = {
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
};

/** Pulls the first JSON-RPC envelope out of an SSE stream or a plain JSON body. */
function parseMcpBody(contentType: string | null, text: string): JsonRpcEnvelope | null {
	if (contentType?.includes("text/event-stream")) {
		for (const frame of text.split("\n\n")) {
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("\n");
			if (!data) continue;
			try {
				const parsed = JSON.parse(data) as JsonRpcEnvelope;
				if ("result" in parsed || "error" in parsed) return parsed;
			} catch {
				// Not a JSON-RPC frame (keep-alive, comment); try the next one.
			}
		}
		return null;
	}
	if (!text.trim()) return null;
	return JSON.parse(text) as JsonRpcEnvelope;
}

function post(env: Env, body: unknown, sessionId?: string): Promise<Response> {
	const secret = env.N8N_MCP_HEADER_SECRET;
	if (!secret) {
		throw new Error(
			"N8N_MCP_HEADER_SECRET is not set. Run: npx wrangler secret put N8N_MCP_HEADER_SECRET",
		);
	}

	const headers: Record<string, string> = {
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
		[env.N8N_MCP_HEADER_NAME || DEFAULT_HEADER_NAME]: secret,
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;

	return fetch(N8N_MCP_URL, {
		body: JSON.stringify(body),
		headers,
		method: "POST",
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
}

async function failure(stage: string, res: Response): Promise<Error> {
	const detail = (await res.text()).slice(0, 500);
	return new Error(`n8n ${stage} failed: HTTP ${res.status}. ${detail}`);
}

/**
 * Calls one tool on the n8n MCP server and returns its CallToolResult exactly as
 * n8n produced it.
 *
 * toolName must match a tool node on C25-MCP-Server, and the argument keys must
 * match that node's $fromAI() names. Neither is checked here: a mismatch comes
 * back as an n8n tools/call error, which is the right place for it to surface.
 */
export async function callN8nTool(
	env: Env,
	toolName: string,
	args: Record<string, string | undefined>,
) {
	// Optional inputs arrive as undefined when the client omits them. Drop those
	// keys rather than sending "key": undefined, which JSON.stringify removes
	// anyway but which would send an explicit empty value if it ever changed.
	// An absent key is what we want: the matching $fromAI() call on the n8n node
	// carries an empty-string default, so n8n fills it in itself.
	const toolArgs: Record<string, string> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string") toolArgs[key] = value;
	}

	const initRes = await post(env, {
		id: 1,
		jsonrpc: "2.0",
		method: "initialize",
		params: {
			capabilities: {},
			clientInfo: { name: "cf-remote-mcp-github-oauth", version: "1.0.0" },
			protocolVersion: "2025-03-26",
		},
	});
	if (!initRes.ok) throw await failure("initialize", initRes);
	const sessionId = initRes.headers.get("mcp-session-id") ?? undefined;
	await initRes.text();

	const notifyRes = await post(env, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
	if (!notifyRes.ok) throw await failure("notifications/initialized", notifyRes);
	await notifyRes.text();

	const callRes = await post(
		env,
		{
			id: 2,
			jsonrpc: "2.0",
			method: "tools/call",
			params: { arguments: toolArgs, name: toolName },
		},
		sessionId,
	);
	if (!callRes.ok) throw await failure("tools/call", callRes);

	const text = await callRes.text();
	const envelope = parseMcpBody(callRes.headers.get("content-type"), text);
	if (!envelope) {
		throw new Error(`n8n tools/call returned no JSON-RPC payload. Body: ${text.slice(0, 500)}`);
	}
	if (envelope.error) {
		throw new Error(`n8n tools/call error: ${JSON.stringify(envelope.error)}`);
	}
	return envelope.result;
}
