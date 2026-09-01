import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const aliasModel = "gpt-5.6-sol-1m";
const upstreamModel = "gpt-5.6-sol";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex" || ctx.model.id !== aliasModel) return;
    if (!event.payload || typeof event.payload !== "object") return;

    return {...event.payload, model: upstreamModel};
  });
}
