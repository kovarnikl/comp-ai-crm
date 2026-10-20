/**
 * The Vercel function's entry point, bundled by `scripts/build-func.mjs` into
 * `.vercel/output/functions/api/index.func`. It must not live under `api/`:
 * Vercel treats that directory as zero-config functions and builds a second
 * `/api/index` from it, and whichever of the two lands last is the one that
 * serves — the unbundled one cannot resolve its own imports.
 */
import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "./create-app";

type ExpressInstance = (req: IncomingMessage, res: ServerResponse) => void;

let instancePromise: Promise<ExpressInstance> | null = null;

function getInstance(): Promise<ExpressInstance> {
	if (!instancePromise) {
		instancePromise = (async () => {
			const app = await createApp();
			await app.init();
			return app.getHttpAdapter().getInstance() as ExpressInstance;
		})();
	}
	return instancePromise;
}

export default async function handler(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const instance = await getInstance();
	instance(req, res);
}
