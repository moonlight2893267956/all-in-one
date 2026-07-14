/**
 * Patterns that indicate an env var still holds a template/placeholder value
 * rather than a real secret. These are the kinds of values that ship in
 * `.env.example` and MUST never be used as real credentials (this is exactly
 * how the DashScope key leaked — a real key was committed into `.env.example`
 * history of a public repo).
 *
 * The patterns are deliberately strict: a real key like `sk-3f8b5a6...` is
 * mixed-case alphanumeric, while a placeholder is `sk-xxxx...` (all x). We
 * match the placeholder form so we never accidentally flag a legitimate key
 * as a placeholder, nor a placeholder as a real key.
 */
export const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^sk-[xX]{8,}$/, // sk-xxxxxxxxxxxxxxxxxxxxxxxx
  /^tvly-[xX]{8,}$/, // tvly-xxxxxxxxxxxxxxxxxxxxxxxx
  /^AKID[xX]{8,}$/, // AKIDxxxxxxxxxxxxxxxxxxxx
  /^<.*>$/, // <your-key-here>
  /replace[-_]?me/i, // replace-me-with-a-strong-random-token
  /your[_-].{0,60}(key|token|secret)/i, // your_tavily_api_key_here / your_api_key_here
  /^(changeme|test|dummy|example|placeholder)$/i,
];

/** True when `value` looks like a template/placeholder, not a real secret. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

export interface GetApiKeyOptions {
  /** Return "" instead of throwing when the var is unset or empty. */
  allowUnset?: boolean;
}

/**
 * Read a secret from the environment.
 *
 * Throws if the var is unset (unless `allowUnset`) or still holds a
 * placeholder/template value — so a copied-but-unfilled `.env.example` fails
 * loudly instead of silently sending a bogus credential to a provider.
 */
export function getApiKey(envVar: string, opts: GetApiKeyOptions = {}): string {
  const value = process.env[envVar];
  if (!value) {
    if (opts.allowUnset) return "";
    throw new Error(
      `Environment variable ${envVar} is not set. ` +
        `Please set it before running the server.`
    );
  }
  if (isPlaceholder(value)) {
    throw new Error(
      `Environment variable ${envVar} still contains a placeholder value ` +
        `("${value}"). You appear to have copied .env.example without filling it in — ` +
        `set ${envVar} to a real secret.`
    );
  }
  return value;
}

/**
 * Print a startup config summary with secret VALUES hidden. Surfaces which
 * secrets are unset vs. still set to a placeholder so an operator can catch a
 * misconfigured deploy before tools start failing mid-request.
 */
const CONFIG_VARS: string[] = [
  "AUTH_TOKEN",
  "TAVILY_API_KEY",
  "NEWAPI_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
  "COS_BUCKET",
  "COS_REGION",
  "COS_PUBLIC_HOST",
  "HEXO_SOURCE_DIR",
];

export function reportConfig(): void {
  const lines: string[] = [
    "[mcp-all-in-one] Config check (values hidden):",
  ];
  let hasPlaceholder = false;
  for (const name of CONFIG_VARS) {
    const v = process.env[name];
    let status: string;
    if (!v) {
      status = "unset";
    } else if (isPlaceholder(v)) {
      status = "PLACEHOLDER  <-- fix me";
      hasPlaceholder = true;
    } else {
      status = "set";
    }
    lines.push(`  ${name.padEnd(18)} ${status}`);
  }
  console.error(lines.join("\n"));
  if (hasPlaceholder) {
    console.error(
      "\nWARNING: one or more secrets are still set to placeholder/template " +
        "values (copied from .env.example). The server refuses to use them — " +
        "set them to real secrets before use."
    );
  }
}

/**
 * Directory where files staged from a remote client (e.g. via scp) live before
 * being uploaded to COS. cos_upload's `local_path` is constrained to this dir
 * to prevent reading arbitrary server files. Override with MCP_UPLOAD_DIR.
 */
export function getUploadDir(): string {
  return process.env.MCP_UPLOAD_DIR || "/home/yunmiao/apps/all-in-one/uploads";
}
