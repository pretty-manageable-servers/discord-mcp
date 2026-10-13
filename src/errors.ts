export type ToolErrorCode =
  | "channel_not_allowed"
  | "not_found"
  | "missing_permission"
  | "timeout"
  | "too_long"
  | "bad_input"
  | "discord_error";

export class ToolError extends Error {
  constructor(public code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
