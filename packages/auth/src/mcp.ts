import { env } from "./env";

/**
 * The MCP endpoint lives on the API but is reached through the app's
 * `/api/*` proxy, so it shares the app's origin with the session cookie and
 * with every OAuth endpoint the `mcp` plugin serves under `/api/auth`. One
 * origin is the whole trick: a client like claude.ai discovers the
 * authorization server from the resource, and the browser half of the flow
 * signs in on the same host the token is later presented to.
 */
export const MCP_PATH = "/api/mcp";

export const mcpResourceUrl = `${env.appUrl}${MCP_PATH}`;

export const MCP_LOGIN_PAGE = `${env.appUrl}/sign-in`;

/** A connector stays signed in for a month before it asks again. */
export const MCP_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
