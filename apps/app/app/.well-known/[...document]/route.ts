import { connection } from "next/server";
import { API_URL } from "@/lib/env";

/**
 * OAuth discovery for MCP clients. claude.ai reads the protected-resource
 * document, finds this origin as the authorization server, and then asks for
 * `/.well-known/oauth-authorization-server` at the root — RFC 8414 puts it
 * there, while better-auth serves it under its own base path. This route only
 * moves the documents to where clients look; the API stays their only source.
 *
 * Path-suffixed variants (`…/oauth-protected-resource/api/mcp`) resolve to the
 * same documents, because this install has exactly one resource.
 */
const DOCUMENTS = new Set([
	"oauth-authorization-server",
	"oauth-protected-resource",
	"openid-configuration",
]);

const UPSTREAM: Record<string, string> = {
	"oauth-authorization-server": "oauth-authorization-server",
	"oauth-protected-resource": "oauth-protected-resource",
	// The `mcp` plugin has no OIDC document of its own; its OAuth metadata is
	// what an OIDC-first client needs to carry on.
	"openid-configuration": "oauth-authorization-server",
};

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ document: string[] }> },
): Promise<Response> {
	await connection();

	const [name] = (await params).document;
	if (!name || !DOCUMENTS.has(name)) {
		return new Response(null, { status: 404, headers: CORS });
	}

	const upstream = await fetch(
		`${API_URL}/api/auth/.well-known/${UPSTREAM[name]}`,
		{ headers: { accept: "application/json" } },
	).catch(() => null);

	if (!upstream?.ok) {
		return Response.json(
			{ error: "The authorization server is not reachable." },
			{ status: 502, headers: CORS },
		);
	}

	return Response.json(await upstream.json(), {
		headers: { ...CORS, "Cache-Control": "public, max-age=300" },
	});
}

export function OPTIONS(): Response {
	return new Response(null, { status: 204, headers: CORS });
}
