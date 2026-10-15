export interface Config {
  domain: string;
  apiKey: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Reads and validates env vars once at startup. Collects every problem so the
// user can fix them all in one go instead of one restart per mistake.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const domain = env.FRESHDESK_DOMAIN?.trim() ?? "";
  const apiKey = env.FRESHDESK_API_KEY?.trim() ?? "";
  const problems: string[] = [];

  if (!domain) {
    problems.push("FRESHDESK_DOMAIN is not set. Example: kaapico-demo.freshdesk.com");
  } else if (domain.includes("://") || domain.includes("/")) {
    problems.push(
      `FRESHDESK_DOMAIN must be a bare hostname like kaapico-demo.freshdesk.com, without https:// or a path. Got "${domain}".`
    );
  }

  if (!apiKey) {
    problems.push("FRESHDESK_API_KEY is not set. Find it in Freshdesk under Profile settings > View API key.");
  }

  if (problems.length > 0) {
    throw new ConfigError(problems.join("\n"));
  }
  return { domain, apiKey };
}
