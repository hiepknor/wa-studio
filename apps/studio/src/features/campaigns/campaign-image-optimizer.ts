const MAX_LOSSLESS_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_LOSSLESS_PIXELS = 24_000_000;
const WEBP_MIME_TYPE = "image/webp";

interface WorkerSuccess {
  encoded: ArrayBuffer;
  pixels: ArrayBuffer;
  type: "success";
}

interface WorkerFailure {
  message: string;
  type: "error";
}

type WorkerResponse = WorkerFailure | WorkerSuccess;

function abortError(): DOMException {
  return new DOMException("Campaign media upload was cancelled.", "AbortError");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function optimizedFilename(filename: string): string {
  const extensionStart = filename.lastIndexOf(".");
  const basename = extensionStart > 0 ? filename.slice(0, extensionStart) : filename;
  return `${basename.slice(0, 250)}.webp`;
}

async function assertLosslessSource(file: File, signal?: AbortSignal): Promise<void> {
  if (file.size > MAX_LOSSLESS_SOURCE_BYTES) {
    throw new Error("This image is too large to optimize safely. Choose an image smaller than 64 MB.");
  }
  if (file.type !== "image/png" && file.type !== WEBP_MIME_TYPE) return;

  const bytes = new Uint8Array(await file.arrayBuffer());
  assertNotAborted(signal);
  if (file.type === "image/png") {
    if (bytes.length >= 25 && bytes[24] > 8) {
      throw new Error("16-bit PNG images cannot be optimized without reducing color precision.");
    }
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type === "acTL") {
        throw new Error("Animated PNG images cannot be optimized without removing animation.");
      }
      if (type === "IDAT" || type === "IEND") break;
      offset += 12 + length;
    }
    return;
  }

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    if (type === "ANIM" || type === "ANMF") {
      throw new Error("Animated WebP images cannot be optimized without removing animation.");
    }
    offset += 8 + length + (length % 2);
  }
}

function loadImageData(file: Blob, signal?: AbortSignal): Promise<ImageData> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    let settled = false;

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
      operation();
    };
    const cancel = () => {
      image.src = "";
      finish(() => reject(abortError()));
    };

    image.decoding = "async";
    image.onload = () => finish(() => {
      const { naturalHeight: height, naturalWidth: width } = image;
      const pixels = width * height;
      if (!width || !height) {
        reject(new Error("The selected file is not a readable image."));
        return;
      }
      if (!Number.isSafeInteger(pixels) || pixels > MAX_LOSSLESS_PIXELS) {
        reject(new Error("Images above 24 megapixels cannot be optimized safely without resizing."));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        reject(new Error("Lossless image optimization is not available in this environment."));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, width, height));
    });
    image.onerror = () => finish(() => reject(new Error("The selected file is not a readable image.")));
    signal?.addEventListener("abort", cancel, { once: true });
    image.src = url;
  });
}

function encodeLosslessWebp(image: ImageData, signal?: AbortSignal): Promise<{
  encoded: ArrayBuffer;
  pixels: Uint8ClampedArray;
}> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./campaign-image-optimizer.worker.ts", import.meta.url),
      { name: "campaign-image-optimizer", type: "module" },
    );
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      operation();
    };
    const cancel = () => finish(() => reject(abortError()));
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === "error") {
        finish(() => reject(new Error(response.message)));
        return;
      }
      finish(() => resolve({
        encoded: response.encoded,
        pixels: new Uint8ClampedArray(response.pixels),
      }));
    };
    worker.onerror = () => finish(() => reject(new Error("The lossless image encoder could not start.")));
    signal?.addEventListener("abort", cancel, { once: true });
    const pixels = image.data.buffer;
    try {
      worker.postMessage({ height: image.height, pixels, width: image.width }, [pixels]);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function samePixels(left: Uint8ClampedArray, right: Uint8ClampedArray): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export async function optimizeCampaignImageLosslessly(
  file: File,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<File> {
  await assertLosslessSource(file, signal);
  const source = await loadImageData(file, signal);
  assertNotAborted(signal);
  const { encoded, pixels } = await encodeLosslessWebp(source, signal);
  assertNotAborted(signal);

  if (encoded.byteLength > maximumBytes) {
    throw new Error(
      `This image cannot be reduced below ${formatMegabytes(maximumBytes)} without changing its pixels.`,
    );
  }

  const optimized = new File([encoded], optimizedFilename(file.name), {
    lastModified: file.lastModified,
    type: WEBP_MIME_TYPE,
  });
  const verification = await loadImageData(optimized, signal);
  assertNotAborted(signal);
  if (
    verification.width !== source.width
    || verification.height !== source.height
    || !samePixels(pixels, verification.data)
  ) {
    throw new Error("Lossless verification failed, so the original image was not uploaded.");
  }
  return optimized;
}

function formatMegabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}
