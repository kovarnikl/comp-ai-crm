import type { AnyProcedure, AnyRouter } from "@trpc/server";
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

type JsonSchema = Record<string, unknown>;

type OpenApiMeta = {
	openapi?: { method?: string; path?: string; summary?: string };
};

export type McpTool = {
	/** Dotted tRPC path, e.g. `companies.create`. */
	path: string;
	/** True when the procedure's input is not an object and is passed as `input`. */
	wrapped: boolean;
	definition: {
		name: string;
		description: string;
		inputSchema: JsonSchema & { type: "object" };
		annotations: {
			readOnlyHint: boolean;
			destructiveHint: boolean;
		};
	};
};

const EMPTY_OBJECT: JsonSchema & { type: "object" } = {
	type: "object",
	properties: {},
};

function inputSchemaOf(procedure: AnyProcedure): {
	schema: JsonSchema & { type: "object" };
	wrapped: boolean;
} {
	const inputs = (procedure._def as { inputs?: unknown[] }).inputs ?? [];
	const parser = inputs[0];

	// Duck-typed rather than `instanceof`: a second copy of zod in the bundle
	// would fail the class check while producing a perfectly good schema.
	if (typeof parser !== "object" || parser === null || !("_zod" in parser)) {
		return { schema: EMPTY_OBJECT, wrapped: false };
	}

	let schema: JsonSchema;
	try {
		schema = z.toJSONSchema(parser as z.ZodType, {
			io: "input",
			unrepresentable: "any",
		}) as JsonSchema;
	} catch {
		return { schema: EMPTY_OBJECT, wrapped: false };
	}

	delete schema.$schema;

	if (schema.type === "object") {
		return {
			schema: schema as JsonSchema & { type: "object" },
			wrapped: false,
		};
	}

	return {
		schema: {
			type: "object",
			properties: { input: schema },
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
	const procedures = appRouter._def.procedures as Record<string, AnyProcedure>;
	const tools: McpTool[] = [];

	for (const [path, procedure] of Object.entries(procedures)) {
		const router = path.split(".")[0] ?? "";
		if (!EXPOSED_ROUTERS.has(router)) continue;

		const openapi = (procedure._def.meta as OpenApiMeta | undefined)?.openapi;
		if (!openapi?.method || !openapi.path) continue;

		const method = openapi.method.toUpperCase();
		const { schema, wrapped } = inputSchemaOf(procedure);
		const destructive =
			method === "DELETE" || /purge|archive/i.test(openapi.path);

		tools.push({
			path,
			wrapped,
			definition: {
				name: path.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
				description: openapi.summary ?? describe(path, method, openapi.path),
				inputSchema: schema,
				annotations: {
					readOnlyHint: method === "GET",
					destructiveHint: destructive,
				},
			},
		});
	}

	return tools.sort((a, b) =>
		a.definition.name.localeCompare(b.definition.name),
	);
}
