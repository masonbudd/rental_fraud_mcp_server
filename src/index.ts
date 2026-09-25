import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { callN8nTool } from "./n8n-mcp-client";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

// GitHub usernames allowed to see and call the tools on this server.
// Anyone else authenticates successfully but gets an empty tool list.
const ALLOWED_USERNAMES = new Set<string>([
	"masonbudd",
	"josephk879",
	"venamiin",
	"Peritract",
	"emerlanders",
]);

// Mirrors the inputSchema published by check_rental_listing on the n8n MCP server.
//
// THIS IS A DUPLICATE AND IT WILL GO STALE. Claude never sees n8n's schema: it
// sees THIS one, because this Worker is the server it connects to. Adding an
// input in n8n therefore does nothing on its own, and no amount of reconnecting
// the connector will surface it. Both have to be changed together.
//
// It already happened once. Four inputs were added to the n8n node on
// 2026-09-20 and this file was not updated, so contactMade, anythingElse,
// paymentTypeOther and multiplePaymentsDetail were unreachable over MCP: Claude
// was never told they existed, so it never sent them. anythingElse was the
// expensive one, since that is the field meant to carry what the advertiser
// actually said to the renter, which is where most rental fraud shows.
//
// The first seven are required, matching n8n. Send an empty string when a value
// is unknown. The four added below are optional, matching the empty-string
// defaults on the n8n node, so a client that omits them still works.
// ONE INPUT. THE ADVERT.
//
// This route is deliberately the quick one: paste an advert, get an answer, no
// interview. Everything else Case Processing needs is hardcoded on the n8n node
// so it matches what the browser extension sends for an advert-only submission.
//
// Every field removed from here was a divergence, not a convenience. On
// 2026-09-23 the same Blackhorse Road advert scored 8 over MCP and 12 over the
// extension, and the cause was a model filling in fields nobody had answered.
// askedToPayUpfront, tenancySigned, paymentType, paymentAmount, contactMade and
// location all had a $fromAI binding with no default, so the model read them off
// the advert and the engine scored them as if a renter had reported them. A
// guessed paymentAmount alone flips paymentInfoSource to "renter", which unlocks
// real cap arithmetic and an over-cap uplift worth up to 24 points on a figure
// the renter was never asked for.
//
// Taking the questions out of the description is not enough and was tried first:
// the fields stay in the tool schema and the model keeps filling them. The only
// control that holds is not offering them.
//
// What this costs: an MCP user who HAS been asked for money cannot say so here.
// That is the form's job, and the single-check tools are what this route offers
// instead.
const CHECK_RENTAL_LISTING_INPUT = {
	listingText: z
		.string()
		.describe(
			"The advert itself, verbatim, and nothing else. Paste the whole thing, including the price and anything it says about deposits or payments. Do not add the renter's own comments, your summary, or anything they told you about the conversation, and do not trim it: several checks read this as the advertiser's own words and the extraction step reads the rent, location and payment terms out of it.",
		),
};

// ---------------------------------------------------------------------------
// THE FOUR SINGLE CHECKS
//
// Added 2026-09-21 after the Monday demo. Exposing one full assessment makes MCP
// a webhook with extra steps; what MCP actually offers is a model picking the
// capability that fits the question asked. So four of the checks are callable on
// their own, for a renter who wants to know whether one company is real without
// submitting a whole listing.
//
// Same duplication trap as CHECK_RENTAL_LISTING_INPUT above: these descriptions
// are what Claude reads, not the ones on the n8n tool nodes. The argument keys
// must match the $fromAI() names on C25-MCP-Server, and the tool names must match
// the node names there. Changing one side alone does nothing.
//
// Every one of these returns a howToPresent block whose neverSay rules exist
// because a single check is easy to over-read. "Checked & Passed" from Companies
// House means a company of that name exists on the register; a model left to
// summarise that writes "verified", and a renter reads "safe".
// ---------------------------------------------------------------------------

const NOT_AN_ASSESSMENT =
	"DO NOT CALL THIS WHEN THE RENTER ASKS YOU TO CHECK A LISTING. \"Check this listing\", \"is this a scam\", \"does this look dodgy\" and anything like them mean check_rental_listing, every time. This tool is only for a renter asking this one narrow question on its own, and it answers nothing else about the advert.\n\n" +
	"This is ONE check taken out of the Rently assessment and run on its own. It is not an assessment: there is no risk score, no concern level and no human review behind it.\n\n";

const USE_FULL_ASSESSMENT =
	"\n\nIf the renter wants to know whether a listing is actually safe, do not stack single checks: call check_rental_listing, which runs thirteen checks, weighs them together and escalates to a human when it is not confident.\n\n" +
	"The response carries a howToPresent object with mustSay and neverSay arrays. Those are instructions, not background. Follow them.";

const COMPANIES_HOUSE_INPUT = {
	companyName: z
		.string()
		.describe(
			"The company or letting agent name exactly as it appears in the advert. Do not add Ltd, expand an abbreviation, correct a spelling or otherwise tidy it: the register is searched on this string and a cleaned-up name can match a different company.",
		),
};

const PRICE_COMPARISON_INPUT = {
	location: z
		.string()
		.describe(
			"The property location as stated in the advert, for example Headingley Leeds, or Fallowfield Manchester. A district plus a city works better than a full postal address.",
		),
	advertisedRent: z
		.string()
		.describe(
			"The advertised rent as digits only, no currency symbol and no commas. For example 650. If the advert gives a range, use the lower figure, because that is the one being used to attract interest.",
		),
	rentFrequency: z
		.string()
		.describe(
			"Whether the advertised rent is per week or per month. Exactly one of: Per week, Per month, Not clear. Ask the renter rather than assuming: reading a weekly rent as monthly turns an ordinary room into a false underpricing flag. Send Not clear if you genuinely do not know, and the check will decline instead of guessing.",
		),
	lettingType: z
		.string()
		.optional()
		.describe(
			"What is being let. Exactly one of: Room in a shared property, Whole self-contained property, Not clear. The market data behind this check is room-in-a-share pricing, so a whole flat or house is a different product and the check will decline rather than compare the two.",
		),
};

const PROPERTYMARK_INPUT = {
	companyName: z
		.string()
		.describe(
			"The letting agent or company name exactly as it appears in the advert, unedited.",
		),
	listingText: z
		.string()
		.optional()
		.describe(
			"The advert itself, verbatim. This is read to see whether the advert claims Propertymark, ARLA, NAEA, NAVA or ICBA membership. Do not add the renter's own comments or your summary.",
		),
};

const SIMILAR_AD_INPUT = {
	listingText: z
		.string()
		.describe(
			"The advert itself, verbatim, and nothing else. Not your summary of it and not the renter's own comments: the comparison is made on the advertiser's exact wording, so anything you add changes the result. At least 40 characters, or the check will decline rather than return a false match.",
		),
};

// ---------------------------------------------------------------------------
// STACKING GUARD
//
// The four single checks exist so a renter can ask one narrow question without
// submitting a whole listing. They are not an assessment, and each one says so
// in its own howToPresent block.
//
// A model can still ignore that and call all four on one advert, then write up
// the four results as if they were a verdict. Observed live on 2026-09-23: four
// single checks on one listing, a summary that read like an assessment, and no
// intake questions, no statutory checks, no risk score, no escalation and no
// case in Airtable. That is worse than a wrong assessment, because it looks
// like a right one.
//
// USE_FULL_ASSESSMENT already tells the model not to do this. It is a prompt
// instruction and it did not hold, the same way contactMade's "ask the user
// rather than guessing" did not hold. So this is code.
//
// Two distinct checks is a renter asking two questions. A third is assembling a
// verdict out of parts that were each published with "this is not an
// assessment" attached. Repeat calls to a check already used are allowed, so
// checking a second company name is unaffected.
//
// State lives on the agent instance, which is one Durable Object per MCP
// session, so the count is per conversation and resets with it.
// ---------------------------------------------------------------------------

const SINGLE_CHECK_LIMIT = 2;

function stackingRefusal(used: string[], attempted: string) {
	return {
		content: [
			{
				text: JSON.stringify(
					{
						status: "use_the_full_assessment",
						reason: `This conversation has already run ${used.join(" and ")}. Adding ${attempted} would be a third separate check on the same listing, and stacking single checks is not an assessment: there is no risk score, no weighting between them, no statutory payment checks, no escalation to a person and no case recorded.`,
						howToPresent: {
							mustSay: [
								"Tell the renter that the single checks answer one narrow question each and cannot be added up into an overall view.",
								"Offer to run the full assessment instead.",
							],
							neverSay: [
								"Do not combine the checks already run into an overall verdict, a concern level, a risk rating or a recommendation.",
								"Do not describe the listing as safe, fine, legitimate, suspicious or a scam on the strength of them.",
							],
							thenDo:
								"Call check_rental_listing. It runs all thirteen checks, weighs them against each other, tests the statutory payment caps in code, escalates to a person where it is not confident, and records the case so a reviewer can answer.",
						},
					},
					null,
					2,
				),
				type: "text" as const,
			},
		],
	};
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Rental Fraud Checker",
		version: "1.0.0",
	});

	// Which single checks this conversation has already run. Per MCP session,
	// because each session is its own Durable Object instance.
	private singleChecksUsed = new Set<string>();

	/** A single check, refused once it would become the third on one listing. */
	private singleCheck(toolName: string) {
		return async (args: Record<string, string | undefined>) => {
			if (!this.singleChecksUsed.has(toolName) && this.singleChecksUsed.size >= SINGLE_CHECK_LIMIT) {
				return stackingRefusal([...this.singleChecksUsed], toolName);
			}
			this.singleChecksUsed.add(toolName);
			return this.relay(toolName)(args);
		};
	}

	async init() {
		if (!ALLOWED_USERNAMES.has(this.props!.login)) {
			return;
		}

		this.server.tool(
			"check_rental_listing",
			// Kept in step with the description on the n8n check_rental_listing node.
			// Claude reads THIS one, not n8n's, so an instruction added there has no
			// effect until it is copied here. See the note above CHECK_RENTAL_LISTING_INPUT.
			"Assess a UK shared-room rental listing for signs of rental fraud. Returns an evidenced, three-state result per check (Checked & Passed, Checked & Flagged, Could not verify), an overall concern level, a risk score out of 100 with an itemised breakdown, and renter-facing next steps. It never states that a listing or a person is fraudulent.\n\n" +
				"ONE INPUT: the advert, verbatim. Do not ask the renter anything before calling this and do not pass anything else. It is the quick route on purpose.\n\n" +
				"An advert on its own can only ever be half a check, and the result says so. Most rental fraud shows in the conversation rather than the listing, and this route cannot see that. Where the renter has actually been in contact with the advertiser, been asked for money, or had a viewing refused, point them at the full form linked in the result instead of trying to feed it in here.\n\n" +
				"The result includes a howToPresent object. Follow it.",
			CHECK_RENTAL_LISTING_INPUT,
			this.relay("check_rental_listing"),
		);

		this.server.tool(
			"check_company_on_companies_house",
			"Look up ONE company or letting agent name on the Companies House register and report what the register says about it. " +
				NOT_AN_ASSESSMENT +
				"CALL THIS, DO NOT SEARCH THE WEB, whenever the renter asks anything like: is this company real, do they actually exist, is this a registered company, are they still trading, is this a proper business, when was this company set up. It queries the Companies House Public Data API directly and reports the register entry, which a web search cannot do reliably and cannot be audited.\n\n" +
				"What it cannot do: a match does not mean the person who wrote the advert works for that company or has any right to let the property, and no match is not evidence of fraud, because private landlords, sole traders and ordinary partnerships are not registered companies at all." +
				USE_FULL_ASSESSMENT,
			COMPANIES_HOUSE_INPUT,
			this.singleCheck("check_company_on_companies_house"),
		);

		this.server.tool(
			"compare_rent_to_local_market",
			"Compare ONE advertised rent against rooms currently advertised in the same area, and report where it sits against the local median and lower quartile. " +
				NOT_AN_ASSESSMENT +
				"CALL THIS, DO NOT SEARCH THE WEB, whenever the renter asks anything like: is this rent normal for the area, is this too cheap, does this price look right, is this a fair price, is £X a lot for around here, how does this compare with similar rooms. It reads live SpareRoom listings for that area and returns a median, a lower quartile and the number of comparables it used, with its own limits attached. A web search cannot produce that, cannot be audited, and will not carry the caveats that make the answer honest.\n\n" +
				"Ask for the rent period rather than assuming it. A weekly rent read as monthly makes an ordinary room look drastically underpriced, which is the exact finding this check exists to make, so a guess here manufactures a false alarm. If you do not know whether it is per week or per month, ask the renter.\n\n" +
				"If the advert is for a whole property but gives a suggested per-room split, compare one of the room figures rather than the whole-property rent, and say which room you compared. The market data behind this check is room-in-a-share pricing, so a whole-flat rent has nothing comparable to sit against.\n\n" +
				"What it cannot do: a rent far below the local market is the standard bait in advance-fee rental fraud, but it is not proof of anything, and a perfectly normal price is not reassurance, because most fake adverts are priced to look ordinary." +
				USE_FULL_ASSESSMENT,
			PRICE_COMPARISON_INPUT,
			this.singleCheck("compare_rent_to_local_market"),
		);

		this.server.tool(
			"check_letting_agent_accreditation",
			"Check whether ONE letting agent appears in the Propertymark member directory, and whether the advert claims a membership the directory does not support. " +
				NOT_AN_ASSESSMENT +
				"CALL THIS, DO NOT SEARCH THE WEB, whenever the renter asks anything like: are they ARLA registered, is this agent accredited, is that Propertymark badge real, are they actually a member, can I trust this agent's credentials. It searches the Propertymark member directory itself. Pass the advert text as well as the name when you have it, because the membership claim is detected in the advert.\n\n" +
				"What it cannot do: Propertymark membership is voluntary, so most UK letting agents are not members and not being listed is not a finding against anyone. A claimed membership the directory does not support is worth asking the agent about, and is still not proof of fraud." +
				USE_FULL_ASSESSMENT,
			PROPERTYMARK_INPUT,
			this.singleCheck("check_letting_agent_accreditation"),
		);

		this.server.tool(
			"check_if_advert_appears_elsewhere",
			"Check whether advert wording this similar has been seen before among the adverts Rently has already collected. " +
				NOT_AN_ASSESSMENT +
				"CALL THIS, DO NOT SEARCH THE WEB, whenever the renter asks anything like: has this advert been copied, have you seen this listing before, is this text stolen from somewhere else, is this the same advert as one I saw yesterday. It runs a similarity search over the adverts Rently has collected, which is not something a web search can do. Copied advert text is a common fraud pattern, because a fake listing is usually lifted from a real one.\n\n" +
				"What it cannot do: it cannot tell you which advert came first or who copied whom, and it only sees adverts Rently has collected, which is a small slice of the market, so finding nothing mostly means not seen rather than does not exist. Letting agents also legitimately reuse their own wording across several rooms in the same house." +
				USE_FULL_ASSESSMENT,
			SIMILAR_AD_INPUT,
			this.singleCheck("check_if_advert_appears_elsewhere"),
		);
	}

	/**
	 * Runs one n8n tool and hands its CallToolResult back untouched.
	 *
	 * Untouched matters. Every one of these results carries a howToPresent block
	 * telling the calling model what it must and must not say, and reshaping the
	 * payload here would be the one place that contract could quietly be lost.
	 */
	private relay(toolName: string) {
		return async (args: Record<string, string | undefined>) => {
			try {
				const result = await callN8nTool(this.env, toolName, args);

				if (result && typeof result === "object" && "content" in result) {
					return result as { content: { text: string; type: "text" }[] };
				}
				return { content: [{ text: JSON.stringify(result), type: "text" as const }] };
			} catch (error) {
				return {
					content: [
						{
							text: `Could not reach the rental fraud checker: ${
								error instanceof Error ? error.message : String(error)
							}`,
							type: "text" as const,
						},
					],
					isError: true,
				};
			}
		};
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
