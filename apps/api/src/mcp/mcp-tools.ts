import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnyProcedure, AnyRouter, ProcedureType } from "@trpc/server";
import { z } from "zod";

/**
 * Which tRPC routers an MCP client may drive. Everything a rep does with
 * records is in; connection plumbing, SSO, API keys, tracking and instance
 * settings are left to the app, where an admin changes them on purpose.
 */
const EXPOSED_ROUTERS = new Set([
	"activities",
	"agents",
	"companies",
	"contacts",
	"conversations",
	"dashboard",
	"deals",
	"enrichment",
	"fields",
	"savedViews",
	"search",
	"users",
	"workspace",
]);

/** The REST route `restMeta()` attaches; a procedure without one is not public API. */
const restRoute = z.object({
	openapi: z.object({
		method: z.string(),
		path: z.string(),
		summary: z.string().optional(),
	}),
});

type ToolInput = {
	schema: Tool["inputSchema"];
	/** True when the procedure's input is not an object and is passed as `input`. */
	wrapped: boolean;
};

export type McpTool = {
	/** Dotted tRPC path, e.g. `companies.create`. */
	path: string;
	type: ProcedureType;
	wrapped: boolean;
	definition: Tool;
};

const NO_INPUT: ToolInput = {
	schema: { type: "object", properties: {} },
	wrapped: false,
};

type JsonSchemaNode = z.core.JSONSchema._JSONSchema;

/** `true`/`false` are valid JSON Schemas, but MCP wants every property as an object. */
function asObjectSchema(node: JsonSchemaNode): z.core.JSONSchema.JSONSchema {
	if (node === true) return {};
	if (node === false) return { not: {} };
	return node;
}

function inputOf(procedure: AnyProcedure): ToolInput {
	const [parser] = procedure._def.inputs;
	if (!(parser instanceof z.ZodType)) return NO_INPUT;

	let json: z.core.JSONSchema.BaseSchema;
	try {
		json = z.toJSONSchema(parser, { io: "input", unrepresentable: "any" });
	} catch {
		return NO_INPUT;
	}

	if (json.type === "object") {
		return {
			schema: {
				type: "object",
				properties: Object.fromEntries(
					Object.entries(json.properties ?? {}).map(([key, node]) => [
						key,
						asObjectSchema(node),
					]),
				),
				required: json.required,
			},
			wrapped: false,
		};
	}

	// The dialect marker belongs to a root schema, not to a property.
	const { $schema: _dialect, ...input } = json;
	return {
		schema: {
			type: "object",
			properties: { input },
			required: ["input"],
		},
		wrapped: true,
	};
}

function describe(path: string, method: string, restPath: string): string {
	const [router, ...rest] = path.split(".");
	return `${router} → ${rest.join(".")} (${method} ${restPath} in the CRM REST API).`;
}

/**
 * One MCP tool per tRPC procedure that already has a REST route, so the tool
 * list is exactly the CRM's public API surface and grows with it — nothing
 * here duplicates what a procedure does.
 */
export function buildMcpTools(appRouter: AnyRouter): McpTool[] {
	// `AnyRouter` types its record loosely; tRPC flattens it to path → procedure.
	const procedures: Record<string, AnyProcedure> = appRouter._def.procedures;
	const tools: McpTool[] = [];

	for (const [path, procedure] of Object.entries(procedures)) {
		const router = path.split(".")[0] ?? "";
		if (!EXPOSED_ROUTERS.has(router)) continue;

		const route = restRoute.safeParse(procedure._def.meta);
		if (!route.success) continue;

		const { method: rawMethod, path: restPath, summary } = route.data.openapi;
		const method = rawMethod.toUpperCase();
		const { schema, wrapped } = inputOf(procedure);

		tools.push({
			path,
			type: procedure._def.type,
			wrapped,
			definition: {
				name: path.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
				description: summary ?? describe(path, method, restPath),
				inputSchema: schema,
				annotations: {
					readOnlyHint: method === "GET",
					destructiveHint:
						method === "DELETE" || /purge|archive/i.test(restPath),
				},
			},
		});
	}

	return tools.sort((a, b) =>
		a.definition.name.localeCompare(b.definition.name),
	);
}
