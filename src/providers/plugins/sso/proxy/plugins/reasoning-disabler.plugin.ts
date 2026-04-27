/**
 * Reasoning Disabler Plugin
 * Priority: 17 (runs after ClaudeThinkingTransformer at 16, before HeaderInjection at 20)
 *
 * Disables reasoning (thinking) for models that do not support it.
 *
 * Problem: Claude Code sends `thinking: { type: "enabled"/"adaptive" }` and
 * `output_config.effort` for all Opus-class models. Older or constrained models
 * (e.g. claude-haiku) reject these fields with HTTP 400.
 *
 * Fix: For matching models, set `thinking.type = "disabled"` and strip
 * `output_config.effort`. `output_config` itself is removed if stripping `effort` leaves it empty.
 *
 * Scope: Only enabled for codemie-claude agent.
 *
 * To add a model: append a pattern to REASONING_DISABLED_MODEL_PATTERNS.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from "./types.js";
import { ProxyContext } from "../proxy-types.js";
import { logger } from "../../../../../utils/logger.js";

/**
 * Models that do not support reasoning / thinking params.
 * Extend this list as new models are identified to reject these fields.
 */
const REASONING_DISABLED_MODEL_PATTERNS: RegExp[] = [
	/claude-haiku(?:[^0-9]|$)/i,
];

function modelDisablesReasoning(modelName: string): boolean {
	return REASONING_DISABLED_MODEL_PATTERNS.some((p) => p.test(modelName));
}

const ALLOWED_AGENT = "codemie-claude";

export class ClaudeReasoningDisablerPlugin implements ProxyPlugin {
	id = "@codemie/proxy-reasoning-disabler";
	name = "Reasoning Disabler";
	version = "1.0.0";
	priority = 17; // After ClaudeThinkingTransformer (16), before HeaderInjection (20)

	async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
		const clientType = context.config.clientType;
		if (!clientType || clientType !== ALLOWED_AGENT) {
			throw new Error(`Plugin disabled for agent: ${clientType}`);
		}
		const configModel = context.config.model;
		return new ReasoningDisablerInterceptor(configModel);
	}
}

class ReasoningDisablerInterceptor implements ProxyInterceptor {
	name = "reasoning-disabler";

	constructor(private readonly configModel?: string) {}

	async onRequest(context: ProxyContext): Promise<void> {
		if (
			!context.requestBody ||
			!context.headers["content-type"]?.includes("application/json")
		) {
			return;
		}

		try {
			const bodyStr = context.requestBody.toString("utf-8");
			const body = JSON.parse(bodyStr);

			const model =
				(typeof body.model === "string" && body.model) ||
				this.configModel ||
				"";
			if (!model || !modelDisablesReasoning(model)) return;

			const stripped: string[] = [];

			if (body.thinking !== undefined && body.thinking.type !== "disabled") {
				body.thinking = { type: "disabled" };
				stripped.push("thinking");
			}

			if (body.output_config?.effort !== undefined) {
				delete body.output_config.effort;
				stripped.push("output_config.effort");
				if (Object.keys(body.output_config).length === 0) {
					delete body.output_config;
				}
			}

			if (stripped.length === 0) return;

			const newBodyStr = JSON.stringify(body);
			context.requestBody = Buffer.from(newBodyStr, "utf-8");
			context.headers["content-length"] = String(context.requestBody.length);

			logger.debug(
				`[${this.name}] Disabled reasoning fields [${stripped.join(", ")}] for model: ${model}`,
			);
		} catch {
			// Not valid JSON or unexpected structure — pass through unchanged
		}
	}
}
