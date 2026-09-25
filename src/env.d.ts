// `wrangler types` only emits bindings and vars, never secrets, so the secrets this
// Worker reads are declared here. They are merged into both the global `Env` (used
// for Hono bindings and the Durable Object) and `Cloudflare.Env` (the type behind
// `import { env } from "cloudflare:workers"`).
interface WorkerSecrets {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	/** Value sent verbatim as the Authorization header to the n8n MCP server (raw token, no Bearer prefix). */
	N8N_MCP_HEADER_SECRET: string;
}

interface Env extends WorkerSecrets {}

declare namespace Cloudflare {
	interface Env extends WorkerSecrets {}
}
