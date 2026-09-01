import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeApi,
  RuntimeMediaAsset,
  RuntimeMediaAssetPolicy,
  RuntimeMediaUpload,
} from "@/shared/api/runtime-client";
import {
  prepareCampaignMediaFile,
  uploadCampaignMedia,
  validateCampaignMediaFile,
} from "./campaign-media";

const policy: RuntimeMediaAssetPolicy = {
  chunkSize: 393_216,
  imageMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  imageMaxBytes: 8 * 1024 * 1024,
  storageMaxBytes: 512 * 1024 * 1024,
};

describe("Campaign media upload", () => {
  it("hashes once and transfers bounded idempotent chunks before completion", async () => {
    const bytes = new Uint8Array(policy.chunkSize + 7);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = new File([bytes], "launch.png", { type: "image/png" });
    const upload: RuntimeMediaUpload = {
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-id",
      kind: "IMAGE",
      filename: file.name,
      mimeType: file.type,
      byteSize: file.size,
      sha256: "a".repeat(64),
      chunkSize: policy.chunkSize,
      totalChunks: 2,
      uploadedChunks: [],
      status: "UPLOADING",
      completedAssetId: null,
      expiresAt: "2026-08-29T00:00:00.000Z",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const asset: RuntimeMediaAsset = {
      id: "22222222-2222-4222-8222-222222222222",
      sessionId: upload.sessionId,
      kind: upload.kind,
      filename: upload.filename,
      mimeType: upload.mimeType,
      byteSize: upload.byteSize,
      sha256: upload.sha256,
      createdAt: "2026-08-28T00:00:01.000Z",
    };
    const api = {
      createCampaignMediaUpload: vi.fn().mockResolvedValue(upload),
      putCampaignMediaChunk: vi.fn().mockResolvedValue(undefined),
      completeCampaignMediaUpload: vi.fn().mockResolvedValue(asset),
      cancelCampaignMediaUpload: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuntimeApi;
    const progress = vi.fn();

    const result = await uploadCampaignMedia({
      api, file, onProgress: progress, policy, sessionId: upload.sessionId,
    });

    expect(result).toEqual({
      asset,
      optimization: {
        applied: false,
        originalByteSize: file.size,
        uploadedByteSize: file.size,
      },
    });

    expect(api.createCampaignMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "IMAGE", byteSize: file.size, mimeType: "image/png",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.any(String),
      { signal: undefined },
    );
    expect(api.putCampaignMediaChunk).toHaveBeenCalledTimes(2);
    expect(atob(vi.mocked(api.putCampaignMediaChunk).mock.calls[0]![2])).toHaveLength(policy.chunkSize);
    expect(atob(vi.mocked(api.putCampaignMediaChunk).mock.calls[1]![2])).toHaveLength(7);
    expect(api.completeCampaignMediaUpload).toHaveBeenCalledWith(upload.id, { signal: undefined });
    expect(api.cancelCampaignMediaUpload).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith({
      bytesCompleted: file.size, bytesTotal: file.size, phase: "verifying",
    });
  });

  it("rejects unsupported and oversized files before creating an upload", () => {
    expect(validateCampaignMediaFile(
      { name: "video.mp4", size: 10, type: "video/mp4" },
      policy,
    )).toEqual({ error: "Choose a JPEG, PNG, or WebP image." });
    expect(validateCampaignMediaFile(
      { name: "large.png", size: policy.imageMaxBytes + 1, type: "image/png" },
      policy,
    )).toEqual({ error: "Images must be 8 MB or smaller." });
  });

  it("losslessly optimizes an oversized image before upload validation", async () => {
    const smallPolicy = { ...policy, imageMaxBytes: 10 };
    const file = new File([new Uint8Array(11)], "launch.png", { type: "image/png" });
    const optimized = new File([new Uint8Array(8)], "launch.webp", { type: "image/webp" });
    const optimizer = vi.fn().mockResolvedValue(optimized);
    const progress = vi.fn();

    await expect(prepareCampaignMediaFile(file, smallPolicy, {
      onProgress: progress,
      optimizer,
    })).resolves.toEqual({
      applied: true,
      file: optimized,
      originalByteSize: 11,
      uploadedByteSize: 8,
    });

    expect(optimizer).toHaveBeenCalledWith(file, 10, undefined);
    expect(progress).toHaveBeenNthCalledWith(1, {
      bytesCompleted: 0,
      bytesTotal: 11,
      phase: "optimizing",
    });
    expect(progress).toHaveBeenLastCalledWith({
      bytesCompleted: 11,
      bytesTotal: 11,
      phase: "optimizing",
    });
  });

  it("uploads the verified optimized file instead of the oversized source", async () => {
    const smallPolicy = { ...policy, imageMaxBytes: 10 };
    const file = new File([new Uint8Array(11)], "launch.png", { type: "image/png" });
    const optimized = new File([new Uint8Array(8)], "launch.webp", { type: "image/webp" });
    const upload = {
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-id",
      kind: "IMAGE",
      filename: optimized.name,
      mimeType: optimized.type,
      byteSize: optimized.size,
      sha256: "a".repeat(64),
      chunkSize: policy.chunkSize,
      totalChunks: 1,
      uploadedChunks: [],
      status: "UPLOADING",
      completedAssetId: null,
      expiresAt: "2026-08-29T00:00:00.000Z",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    } satisfies RuntimeMediaUpload;
    const asset = {
      id: "22222222-2222-4222-8222-222222222222",
      sessionId: upload.sessionId,
      kind: upload.kind,
      filename: upload.filename,
      mimeType: upload.mimeType,
      byteSize: upload.byteSize,
      sha256: upload.sha256,
      createdAt: "2026-08-28T00:00:01.000Z",
    } satisfies RuntimeMediaAsset;
    const api = {
      createCampaignMediaUpload: vi.fn().mockResolvedValue(upload),
      putCampaignMediaChunk: vi.fn().mockResolvedValue(undefined),
      completeCampaignMediaUpload: vi.fn().mockResolvedValue(asset),
      cancelCampaignMediaUpload: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuntimeApi;

    const result = await uploadCampaignMedia({
      api,
      file,
      optimizer: vi.fn().mockResolvedValue(optimized),
      policy: smallPolicy,
      sessionId: upload.sessionId,
    });

    expect(api.createCampaignMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        byteSize: 8,
        filename: "launch.webp",
        mimeType: "image/webp",
      }),
      expect.any(String),
      { signal: undefined },
    );
    expect(atob(vi.mocked(api.putCampaignMediaChunk).mock.calls[0]![2])).toHaveLength(8);
    expect(result).toEqual({
      asset,
      optimization: { applied: true, originalByteSize: 11, uploadedByteSize: 8 },
    });
  });

  it("does not invoke the optimizer when the source already fits", async () => {
    const file = new File([new Uint8Array(8)], "launch.png", { type: "image/png" });
    const optimizer = vi.fn();

    const prepared = await prepareCampaignMediaFile(file, { ...policy, imageMaxBytes: 10 }, {
      optimizer,
    });

    expect(prepared).toEqual({
      applied: false,
      file,
      originalByteSize: 8,
      uploadedByteSize: 8,
    });
    expect(optimizer).not.toHaveBeenCalled();
  });

  it("fails closed when lossless output still exceeds the Runtime limit", async () => {
    const smallPolicy = { ...policy, imageMaxBytes: 10 };
    const file = new File([new Uint8Array(11)], "launch.jpg", { type: "image/jpeg" });
    const optimized = new File([new Uint8Array(11)], "launch.webp", { type: "image/webp" });

    await expect(prepareCampaignMediaFile(file, smallPolicy, {
      optimizer: vi.fn().mockResolvedValue(optimized),
    })).rejects.toThrow("cannot be reduced below 10 B without changing its pixels");
  });
});
