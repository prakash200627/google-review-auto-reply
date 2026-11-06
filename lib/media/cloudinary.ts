/**
 * Server-side Cloudinary helpers. Never expose API secret to the client.
 * When credentials are missing, callers should return a clear 503.
 */

export const MEDIA_UPLOAD_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  allowedMime: ["image/jpeg", "image/png", "image/webp"] as const,
} as const;

export function isCloudinaryConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(
    String(env.CLOUDINARY_CLOUD_NAME || "").trim() &&
      String(env.CLOUDINARY_API_KEY || "").trim() &&
      String(env.CLOUDINARY_API_SECRET || "").trim()
  );
}

export function cloudinaryConfigStatus(
  env: Record<string, string | undefined> = process.env
): {
  configured: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!String(env.CLOUDINARY_CLOUD_NAME || "").trim()) {
    missing.push("CLOUDINARY_CLOUD_NAME");
  }
  if (!String(env.CLOUDINARY_API_KEY || "").trim()) {
    missing.push("CLOUDINARY_API_KEY");
  }
  if (!String(env.CLOUDINARY_API_SECRET || "").trim()) {
    missing.push("CLOUDINARY_API_SECRET");
  }
  return { configured: missing.length === 0, missing };
}

export function assertAllowedImageUpload(input: {
  mimeType: string;
  bytes: number;
}): void {
  const mime = String(input.mimeType || "").toLowerCase();
  if (
    !(MEDIA_UPLOAD_LIMITS.allowedMime as readonly string[]).includes(mime)
  ) {
    throw new MediaUploadError(
      "Only JPEG, PNG, or WebP images are allowed.",
      { code: "invalid_mime", status: 400 }
    );
  }
  if (
    !Number.isFinite(input.bytes) ||
    input.bytes <= 0 ||
    input.bytes > MEDIA_UPLOAD_LIMITS.maxBytes
  ) {
    throw new MediaUploadError(
      `Image must be between 1 byte and ${MEDIA_UPLOAD_LIMITS.maxBytes} bytes.`,
      { code: "invalid_size", status: 400 }
    );
  }
}

export class MediaUploadError extends Error {
  code: string;
  status: number;
  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "MediaUploadError";
    this.code = code;
    this.status = status;
  }
}

type FetchLike = typeof fetch;

export type CloudinaryUploadResult = {
  public_id: string;
  secure_url: string;
  bytes: number;
  width?: number;
  height?: number;
  format?: string;
};

/**
 * Unsigned? No — signed server upload via Cloudinary REST API.
 * Uses basic auth with api_key:api_secret.
 */
export async function uploadImageToCloudinary(input: {
  buffer: Buffer;
  mimeType: string;
  folder: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}): Promise<CloudinaryUploadResult> {
  const env = input.env || process.env;
  const status = cloudinaryConfigStatus(env);
  if (!status.configured) {
    throw new MediaUploadError(
      `Cloudinary is not configured (${status.missing.join(", ")}).`,
      { code: "not_configured", status: 503 }
    );
  }
  assertAllowedImageUpload({
    mimeType: input.mimeType,
    bytes: input.buffer.byteLength,
  });

  const cloud = String(env.CLOUDINARY_CLOUD_NAME).trim();
  const key = String(env.CLOUDINARY_API_KEY).trim();
  const secret = String(env.CLOUDINARY_API_SECRET).trim();
  const fetchImpl = input.fetchImpl || fetch;

  const form = new FormData();
  const blob = new Blob([new Uint8Array(input.buffer)], {
    type: input.mimeType,
  });
  form.append("file", blob, "upload");
  form.append("folder", input.folder.slice(0, 120));

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const res = await fetchImpl(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    }
  );
  const data = (await res.json()) as CloudinaryUploadResult & {
    error?: { message?: string };
  };
  if (!res.ok || !data.secure_url || !data.public_id) {
    throw new MediaUploadError(
      data.error?.message || "Cloudinary upload failed.",
      { code: "upload_failed", status: 502 }
    );
  }
  return data;
}

export async function destroyCloudinaryAsset(input: {
  publicId: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const env = input.env || process.env;
  if (!isCloudinaryConfigured(env)) return;
  const cloud = String(env.CLOUDINARY_CLOUD_NAME).trim();
  const key = String(env.CLOUDINARY_API_KEY).trim();
  const secret = String(env.CLOUDINARY_API_SECRET).trim();
  const fetchImpl = input.fetchImpl || fetch;
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const form = new FormData();
  form.append("public_id", input.publicId);
  await fetchImpl(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/destroy`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    }
  );
}
