/// <reference lib="webworker" />

import encodeWebp from "@jsquash/webp/encode";

interface OptimizeImageRequest {
  height: number;
  pixels: ArrayBuffer;
  width: number;
}

interface OptimizeImageSuccess {
  encoded: ArrayBuffer;
  pixels: ArrayBuffer;
  type: "success";
}

interface OptimizeImageFailure {
  message: string;
  type: "error";
}

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<OptimizeImageRequest>) => {
  const { height, pixels, width } = event.data;
  void encodeWebp(
    new ImageData(new Uint8ClampedArray(pixels), width, height),
    {
      exact: 1,
      lossless: 1,
      method: 6,
      near_lossless: 100,
      quality: 100,
      thread_level: 0,
    },
  ).then((encoded) => {
    const response: OptimizeImageSuccess = { encoded, pixels, type: "success" };
    worker.postMessage(response, [encoded, pixels]);
  }).catch((error: unknown) => {
    const response: OptimizeImageFailure = {
      message: error instanceof Error ? error.message : "The lossless encoder failed.",
      type: "error",
    };
    worker.postMessage(response);
  });
};

export {};
