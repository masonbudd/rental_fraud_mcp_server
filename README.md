# Rently MCP server

Rently checks a UK shared-room rental listing and returns an evidenced risk assessment: what is concerning, what could not be verified, and what to check before paying any money. The assessment itself runs in n8n. This repository is the piece that lets an AI assistant call it.

It is a Cloudflare Worker that presents an OAuth-authenticated MCP server, checks who is asking, and forwards each call to the n8n engine.

Built for the Sigma Labs C25 Technical Business Analyst group project.

## Why this exists at all

n8n's MCP trigger authenticates with a single static header token. A claude.ai connector authenticates with OAuth. Those do not meet, so something has to sit between them.

That constraint turned out to be useful. A shared header token cannot be handed round a team safely and leaves no record of who called what. The Worker puts a GitHub identity in front of it, so access is per person and can be granted or removed one name at a time. It is per-person authentication layered onto a service that only offers a shared secret.

It also means no client ever holds the n8n token. The Worker holds it, as a Cloudflare secret, and clients never see it.

## How a call travels

```
Claude  ──OAuth──►  this Worker  ──header auth──►  n8n  ──►  the assessment
                         │
                    GitHub login
                    checked against
                    the allow-list
```

1. The client signs in with GitHub through this Worker.
2. The Worker checks the returned login against `ALLOWED_USERNAMES` in `src/index.ts`.
3. If the name is on the list, the tools are registered. If not, the tools are never registered at all.
4. A tool call is forwarded to the n8n MCP endpoint over Streamable HTTP with the header credential attached.
5. The result passes back untouched.

**Someone not on the list authenticates successfully and sees an empty tool list.** There is no error and no access-denied screen, so the symptom looks like a broken connector rather than a permissions problem. That is worth knowing before you spend ten minutes debugging the wrong thing.

## The tools

| Tool | Answers |
|---|---|
| `check_rental_listing` | The full assessment. All 13 checks, a risk score, what could not be verified, and what to check before paying |
| `check_company_on_companies_house` | Is this company on the register, and does the register say anything concerning about it? |
| `compare_rent_to_local_market` | How does this rent compare with rooms advertised nearby? |
| `check_letting_agent_accreditation` | Is this agent in the Propertymark directory, and does the advert claim a membership it does not have? |
| `check_if_advert_appears_elsewhere` | Has wording this similar been seen in adverts already collected? |

The four single checks were added after the 21 September coach demo. The point made was that exposing one full assessment is a webhook with extra steps, and what MCP actually gives you is a model choosing a capability to fit the question in front of it. Someone who wants to know whether one company is real should not have to submit a whole listing to find out.

Each single check is restated before it leaves, rather than returned in the engine's own vocabulary. `Checked & Passed` from a company lookup means only that a company of that name exists on the register. A model asked to summarise that writes "verified", and a renter reads "safe". Every single-check response therefore carries what the check cannot tell you, alongside rules forbidding any answer that calls a listing safe or says it is fine to pay.

Two checks are deliberately not exposed. Language Judgement is a model's reading of tone, which is the easiest result to over-read when it stands alone with nothing to temper it. Reverse Image Search needs photo URLs a renter cannot reasonably supply in a chat.

## The thing that catches everyone

**This Worker publishes the tool list, not n8n.** The client reads the tool names, descriptions and input schemas declared in `src/index.ts`. It never sees n8n's.

So adding or changing a tool in n8n does nothing on its own. A change to this route is only finished when all three of these have happened:

1. The n8n workflow is saved
2. The n8n workflow is **published**, because n8n serves the last published version and not the draft
3. This Worker is deployed

Each one on its own looks like success and changes nothing.

## Granting access

Add the GitHub username to `ALLOWED_USERNAMES` in `src/index.ts`, then deploy. It is the login from `github.com/<name>`, not a display name or an email, and the comparison is exact so the capitalisation has to match.

```bash
npm run deploy
```

Holding the list in source means adding a person needs a deploy. That is a known limitation rather than a design choice, and a KV-backed list would fix it.

## Layout

| File | Holds |
|---|---|
| `src/index.ts` | The MCP server: the allow-list, and every tool definition and input schema |
| `src/github-handler.ts` | The GitHub OAuth flow, sign-in and callback |
| `src/n8n-mcp-client.ts` | Forwards calls to n8n. n8n needs the full handshake on every session and answers with `text/event-stream`, so the JSON-RPC envelope is pulled out of the SSE frames |
| `src/workers-oauth-utils.ts` | The approval screen and signed cookie handling |
| `src/utils.ts` | Token exchange helpers |
| `wrangler.jsonc` | Worker name, Durable Object binding, KV namespace |

## Running it yourself

```bash
npm install
```

Create a [GitHub OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) with the callback URL `https://<your-worker>.workers.dev/callback`, then set the four secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put N8N_MCP_HEADER_SECRET
```

`N8N_MCP_HEADER_SECRET` is the raw token from the n8n Header Auth credential. `COOKIE_ENCRYPTION_KEY` can be any random string, for example `openssl rand -hex 32`.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill it in. That file is git-ignored and must stay that way.

```bash
npm run dev          # local, on port 8788
npm run type-check   # tsc, no emit
npm run deploy       # ship it
```

Connect a client to `https://<your-worker>.workers.dev/mcp`.

## What this does not do

It does not assess anything. Every check, the scoring, the escalation rules and the legal tests all live in n8n. This Worker authenticates the caller, declares the tool list and passes messages through.

Rently is a risk assessment, not proof. It never states that a listing is fraudulent and never states that one is safe. The legal checks encode the law in England only, and Wales, Scotland and Northern Ireland set different caps.

## Built on

The Cloudflare [remote MCP server with GitHub OAuth](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) template, using [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
