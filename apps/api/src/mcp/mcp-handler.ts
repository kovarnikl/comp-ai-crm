import { apiUrl, auth, type Session } from "@crm/auth";
import { db } from "@crm/db";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	type CallToolRequest,
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	type AnyRouter,
	callTRPCProcedure,
	getTRPCErrorFromUnknown,
} from "@trpc/server";
import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import type { BaseTrpcContext } from "../trpc/context.types";
import { buildMcpTools, type McpTool } from "./mcp-tools";

/**
 * `apiUrl` is the public origin auth is served from — the app's, since every
 * OAuth endpoint is reached through its `/api/*` proxy. The `mcp` plugin
 * serves the protected-resource document under the auth base path.
 */
const RESOURCE_METADATA_URL = `${apiUrl}/api/auth/.well-known/oauth-protected-resource`;

const WWW_AUTHENTICATE = `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

function jsonRpcError(res: Response, status: number, message: string): void {
	res.status(status).json({
		jsonrpc: "2.0",
		error: { code: -32000, message },
		id: null,
	});
}

/**
 * An MCP access token acts as its user, the same way an API key does:
 * better-auth's `enableSessionForAPIKeys` builds a session around the key's
 * owner, and this builds one around the token's. The tRPC middlewares only
 * read `session.user`, so nothing downstream can tell the two apart.
 */
async function sessionFromToken(req: Request): Promise<Session | null> {
	const token = await auth.api
		.getMcpSession({ headers: fromNodeHeaders(req.headers) })
		.catch(() => null);
	if (!token?.userId) return null;

	const user = await db.user.findUnique({ where: { id: token.userId } });
	if (!user) return null;

	const now = new Date();
	return {
		user,
		session: {
			id: `mcp:${token.clientId}`,
			token: "",
			userId: user.id,
			expiresAt: token.accessTokenExpiresAt,
			createdAt: now,
			updatedAt: now,
			ipAddress: null,
			userAgent: req.headers["user-agent"] ?? null,
		},
	};
}

/**
 * The same entry point `createCaller` uses: input goes through the
 * procedure's own parser and every middleware runs, exactly as over HTTP.
 */
async function callTool(
	appRouter: AnyRouter,
	tool: McpTool,
	ctx: BaseTrpcContext,
	params: CallToolRequest["params"],
): Promise<CallToolResult> {
	const input = tool.wrapped ? params.arguments?.input : params.arguments;

	try {
		const result = await callTRPCProcedure({
			router: appRouter,
			path: tool.path,
			type: tool.type,
			ctx,
			getRawInput: async () => input,
			signal: undefined,
			batchIndex: 0,
		});
		return {
			content: [
				{ type: "text", text: JSON.stringify(result ?? null, null, 2) },
			],
		};
	} catch (error) {
		const failure = getTRPCErrorFromUnknown(error);
		return {
			isError: true,
			content: [{ type: "text", text: `${failure.code}: ${failure.message}` }],
		};
	}
}

/**
 * Stateless Streamable HTTP: every POST gets a fresh server and transport and
 * a plain JSON response. Nothing is held between requests, which is what a
 * serverless function wants, and JSON rather than SSE survives the app's
 * buffered proxy unchanged.
 */
export function createMcpHandler(appRouter: AnyRouter) {
	const tools = buildMcpTools(appRouter);
	const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

	return async (req: Request, res: Response): Promise<void> => {
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			jsonRpcError(res, 405, "Method not allowed.");
			return;
		}

		const session = await sessionFromToken(req);
		if (!session) {
			res.setHeader("WWW-Authenticate", WWW_AUTHENTICATE);
			res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
			jsonRpcError(
				res,
				401,
				"Unauthorized: sign in to the CRM to use this connector.",
			);
			return;
		}

		const ctx: BaseTrpcContext = { req, session };

		const server = new Server(
			{ name: "comp-ai-crm", version: "1.0.0" },
			{
				capabilities: { tools: {} },
				instructions:
					"Tools for the Comp AI CRM: companies, contacts, deals, activities, search, fields, saved views and the research agents. Every call runs as the signed-in user. Archive tools hide records (restorable); purge tools delete them for good.",
			},
		);

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: tools.map((tool) => tool.definition),
		}));

		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const tool = byName.get(request.params.name);
			if (!tool) {
				return {
					isError: true,
					content: [
						{ type: "text", text: `Unknown tool ${request.params.name}.` },
					],
				};
			}
			return callTool(appRouter, tool, ctx, request.params);
		});

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});

		res.on("close", () => {
			void transport.close();
			void server.close();
		});

		await server.connect(transport);
		await transport.handleRequest(req, res);
	};
}
