import type { DiscordPort } from "./port.js";
import type { MessageStore } from "./store.js";

// Wraps a DiscordPort so reads use the local store. WP6c implements it.
// Returns the same DiscordPort interface, so tools do not change.
export function withCache(inner: DiscordPort, _store: MessageStore): DiscordPort {
  return inner;
}
