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
