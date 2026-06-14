import { loadHttpConfig } from "../transport/config.ts";
import type { HttpConfig } from "../transport/types.ts";

export function loadConfig(): HttpConfig {
  return loadHttpConfig();
}
