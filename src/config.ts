export function getApiKey(envVar: string): string {
  const key = process.env[envVar];
  if (!key) {
    throw new Error(
      `Environment variable ${envVar} is not set. ` +
      `Please set it before running the server.`
    );
  }
  return key;
}

/**
 * Directory where files staged from a remote client (e.g. via scp) live before
 * being uploaded to COS. cos_upload's `local_path` is constrained to this dir
 * to prevent reading arbitrary server files. Override with MCP_UPLOAD_DIR.
 */
export function getUploadDir(): string {
  return process.env.MCP_UPLOAD_DIR || "/home/yunmiao/apps/all-in-one/uploads";
}
