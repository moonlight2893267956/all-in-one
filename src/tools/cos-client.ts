import COS from "cos-nodejs-sdk-v5";
import { getApiKey } from "../config.js";

export interface CosConfig {
  secretId: string;
  secretKey: string;
  bucket: string; // Format: <name>-<appid>
  region: string;
  /** Public CDN/website host used to build public URLs. Optional. */
  publicHost?: string;
}

export interface CosFile {
  Key: string;
  Size: number;
  LastModified: string;
  ETag: string;
  StorageClass: string;
}

let cachedClient: COS | null = null;
let cachedConfig: CosConfig | null = null;

export function getCosClient(config?: CosConfig): COS {
  const cfg = config ?? loadConfig();
  if (cachedClient && cachedConfig === cfg) return cachedClient;
  cachedConfig = cfg;
  cachedClient = new COS({
    SecretId: cfg.secretId,
    SecretKey: cfg.secretKey,
    Protocol: "https:",
  });
  return cachedClient;
}

export async function cosUploadBuffer(
  buf: Buffer,
  key: string,
  contentType?: string,
  config?: CosConfig,
  options: { acl?: "private" | "public-read" } = {}
): Promise<{ etag: string; size: number; versionId?: string; acl: string }> {
  const cfg = config ?? loadConfig();
  const client = getCosClient(cfg);
  const acl = options.acl ?? "public-read";
  return new Promise((resolve, reject) => {
    client.putObject(
      {
        Bucket: cfg.bucket,
        Region: cfg.region,
        Key: key,
        Body: buf,
        ContentLength: buf.length,
        ACL: acl,
        ...(contentType ? { ContentType: contentType } : {}),
      },
      (err, data) => {
        if (err) return reject(err);
        resolve({
          etag: data.ETag ?? "",
          size: buf.length,
          versionId: data.VersionId,
          acl,
        });
      }
    );
  });
}

export async function cosUploadFile(
  localPath: string,
  key: string,
  config?: CosConfig,
  options: { acl?: "private" | "public-read" } = {}
): Promise<{ etag: string; size: number; versionId?: string; acl: string }> {
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(localPath);
  return cosUploadBuffer(buf, key, undefined, config, options);
}

export async function cosDownloadToFile(
  key: string,
  localPath: string,
  config?: CosConfig
): Promise<{ size: number; contentType?: string }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const fsSync = await import("node:fs");
  const cfg = config ?? loadConfig();
  const client = getCosClient(cfg);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  return new Promise((resolve, reject) => {
    client.getObject(
      {
        Bucket: cfg.bucket,
        Region: cfg.region,
        Key: key,
        Output: fsSync.createWriteStream(localPath),
      },
      (err, data) => {
        if (err) {
          if (err.statusCode === 404) {
            return reject(new Error(`COS object not found: ${key}`));
          }
          return reject(err);
        }
        const headers = (data as { headers?: Record<string, string> }).headers ?? {};
        const len = headers["content-length"];
        resolve({
          size: len ? Number(len) : 0,
          contentType: headers["content-type"],
        });
      }
    );
  });
}

export async function cosListObjects(
  prefix: string = "",
  maxKeys: number = 1000,
  config?: CosConfig
): Promise<CosFile[]> {
  const cfg = config ?? loadConfig();
  const client = getCosClient(cfg);
  const all: CosFile[] = [];
  let marker: string | undefined = undefined;

  while (true) {
    const result: {
      Contents?: Array<{
        Key: string;
        Size: string | number;
        LastModified: string;
        ETag: string;
        StorageClass?: string;
      }>;
      IsTruncated?: string | boolean;
      NextMarker?: string;
    } = await new Promise((resolve, reject) => {
      client.getBucket(
        {
          Bucket: cfg.bucket,
          Region: cfg.region,
          Prefix: prefix,
          MaxKeys: maxKeys,
          Marker: marker,
        },
        (err, data) => {
          if (err) return reject(err);
          resolve(data as unknown as typeof result);
        }
      );
    });

    for (const item of result.Contents ?? []) {
      all.push({
        Key: item.Key,
        Size: Number(item.Size),
        LastModified: item.LastModified,
        ETag: item.ETag,
        StorageClass: item.StorageClass ?? "STANDARD",
      });
    }

    if (!result.IsTruncated || result.IsTruncated === "false") break;
    if (!result.NextMarker) break;
    marker = result.NextMarker;
  }

  return all;
}

export async function cosDeleteObject(
  key: string,
  config?: CosConfig
): Promise<void> {
  const cfg = config ?? loadConfig();
  const client = getCosClient(cfg);
  return new Promise((resolve, reject) => {
    client.deleteObject(
      { Bucket: cfg.bucket, Region: cfg.region, Key: key },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

export function buildPublicUrl(key: string, config?: CosConfig): string {
  const cfg = config ?? loadConfig();
  const host =
    cfg.publicHost ?? `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;
  return `https://${host}/${encodeURI(key).replace(/\+/g, "%2B")}`;
}

export function loadConfig(): CosConfig {
  const secretId = getApiKey("COS_SECRET_ID");
  const secretKey = getApiKey("COS_SECRET_KEY");
  const bucket = process.env.COS_BUCKET;
  const region = process.env.COS_REGION;
  const publicHost = process.env.COS_PUBLIC_HOST;
  if (!bucket || !region) {
    throw new Error(
      "COS configuration missing. Set COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION."
    );
  }
  return { secretId, secretKey, bucket, region, publicHost };
}
