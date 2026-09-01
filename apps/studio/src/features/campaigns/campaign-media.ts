import {
  RuntimeRequestError,
  type RuntimeApi,
  type RuntimeMediaAsset,
  type RuntimeMediaAssetPolicy,
} from "@/shared/api/runtime-client";
import { optimizeCampaignImageLosslessly } from "./campaign-image-optimizer";

export type CampaignMediaKind = "IMAGE";
export type CampaignMediaUploadPhase = "hashing" | "optimizing" | "uploading" | "verifying";

export interface CampaignMediaUploadProgress {
  bytesCompleted: number;
  bytesTotal: number;
  phase: CampaignMediaUploadPhase;
}

interface UploadCampaignMediaInput {
  api: RuntimeApi;
  file: File;
  onProgress?: (progress: CampaignMediaUploadProgress) => void;
  optimizer?: CampaignImageOptimizer;
  policy: RuntimeMediaAssetPolicy;
  sessionId: string;
  signal?: AbortSignal;
}

export interface CampaignMediaUploadResult {
  asset: RuntimeMediaAsset;
  optimization: {
    applied: boolean;
    originalByteSize: number;
    uploadedByteSize: number;
  };
}

type CampaignImageOptimizer = (
  file: File,
  maximumBytes: number,
  signal?: AbortSignal,
) => Promise<File>;

const retryableStatus = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

function abortError(): DOMException {
  return new DOMException("Campaign media upload was cancelled.", "AbortError");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function retryIdempotent<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let attempt = 0;
  for (;;) {
    assertNotAborted(signal);
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const status = error instanceof RuntimeRequestError ? error.status : 0;
      if (attempt >= 2 || !retryableStatus(status)) throw error;
      attempt += 1;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(resolve, 250 * attempt);
        signal?.addEventListener("abort", () => {
          window.clearTimeout(timeout);
          reject(abortError());
        }, { once: true });
      });
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sha256Hex(file: File, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  assertNotAborted(signal);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function campaignMediaKind(
  file: Pick<File, "type">,
  policy: RuntimeMediaAssetPolicy,
): CampaignMediaKind | null {
  if (policy.imageMimeTypes.includes(file.type)) return "IMAGE";
  return null;
}

export function validateCampaignMediaFile(
  file: Pick<File, "name" | "size" | "type">,
  policy: RuntimeMediaAssetPolicy,
): { kind: CampaignMediaKind } | { error: string } {
  const kind = campaignMediaKind(file, policy);
  if (!kind) {
    return { error: "Choose a JPEG, PNG, or WebP image." };
  }
  if (file.size <= 0) return { error: "The selected file is empty." };
  const maximum = policy.imageMaxBytes;
  if (file.size > maximum) {
    return { error: `Images must be ${formatBytes(maximum)} or smaller.` };
  }
  if (!file.name.trim()) return { error: "The selected file needs a filename." };
  return { kind };
}

export async function prepareCampaignMediaFile(
  file: File,
  policy: RuntimeMediaAssetPolicy,
  options: {
    onProgress?: (progress: CampaignMediaUploadProgress) => void;
    optimizer?: CampaignImageOptimizer;
    signal?: AbortSignal;
  } = {},
): Promise<CampaignMediaUploadResult["optimization"] & { file: File }> {
  const kind = campaignMediaKind(file, policy);
  if (!kind) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size <= 0) throw new Error("The selected file is empty.");
  if (!file.name.trim()) throw new Error("The selected file needs a filename.");
  if (file.size <= policy.imageMaxBytes) {
    return {
      applied: false,
      file,
      originalByteSize: file.size,
      uploadedByteSize: file.size,
    };
  }

  assertNotAborted(options.signal);
  options.onProgress?.({ bytesCompleted: 0, bytesTotal: file.size, phase: "optimizing" });
  const optimizer = options.optimizer ?? optimizeCampaignImageLosslessly;
  const optimized = await optimizer(file, policy.imageMaxBytes, options.signal);
  assertNotAborted(options.signal);
  const validation = validateCampaignMediaFile(optimized, policy);
  if ("error" in validation) {
    throw new Error(
      optimized.size > policy.imageMaxBytes
        ? `This image cannot be reduced below ${formatBytes(policy.imageMaxBytes)} without changing its pixels.`
        : validation.error,
    );
  }
  options.onProgress?.({
    bytesCompleted: file.size,
    bytesTotal: file.size,
    phase: "optimizing",
  });
  return {
    applied: true,
    file: optimized,
    originalByteSize: file.size,
    uploadedByteSize: optimized.size,
  };
}

export async function uploadCampaignMedia({
  api,
  file,
  onProgress,
  optimizer,
  policy,
  sessionId,
  signal,
}: UploadCampaignMediaInput): Promise<CampaignMediaUploadResult> {
  const prepared = await prepareCampaignMediaFile(file, policy, { onProgress, optimizer, signal });
  const uploadFile = prepared.file;
  const validation = validateCampaignMediaFile(uploadFile, policy);
  if ("error" in validation) throw new Error(validation.error);
  onProgress?.({ bytesCompleted: 0, bytesTotal: uploadFile.size, phase: "hashing" });
  const sha256 = await sha256Hex(uploadFile, signal);
  const idempotencyKey = crypto.randomUUID();
  let uploadId: string | null = null;
  try {
    const upload = await retryIdempotent(() => api.createCampaignMediaUpload({
      sessionId,
      kind: validation.kind,
      filename: uploadFile.name,
      mimeType: uploadFile.type,
      byteSize: uploadFile.size,
      sha256,
    }, idempotencyKey, { signal }), signal);
    uploadId = upload.id;
    const uploaded = new Set(upload.uploadedChunks);
    for (let index = 0; index < upload.totalChunks; index += 1) {
      assertNotAborted(signal);
      const start = index * upload.chunkSize;
      const end = Math.min(start + upload.chunkSize, uploadFile.size);
      if (!uploaded.has(index)) {
        const chunk = new Uint8Array(await uploadFile.slice(start, end).arrayBuffer());
        await retryIdempotent(
          () => api.putCampaignMediaChunk(upload.id, index, bytesToBase64(chunk), { signal }),
          signal,
        );
      }
      onProgress?.({ bytesCompleted: end, bytesTotal: uploadFile.size, phase: "uploading" });
    }
    onProgress?.({ bytesCompleted: uploadFile.size, bytesTotal: uploadFile.size, phase: "verifying" });
    const asset = await retryIdempotent(
      () => api.completeCampaignMediaUpload(upload.id, { signal }),
      signal,
    );
    uploadId = null;
    return {
      asset,
      optimization: {
        applied: prepared.applied,
        originalByteSize: prepared.originalByteSize,
        uploadedByteSize: prepared.uploadedByteSize,
      },
    };
  } catch (error) {
    if (uploadId) {
      await api.cancelCampaignMediaUpload(uploadId).catch(() => undefined);
    }
    throw error;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}
