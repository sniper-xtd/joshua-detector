"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import styles from "./page.module.css";

type DetectionBox = {
  label: string;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type Detection = {
  is_joshua: boolean;
  name: string;
  confidence: number;
  boxes: DetectionBox[];
};

type Prepared = {
  file: File;
  url: string;
  width: number;
  height: number;
};

type Phase = "idle" | "scanning" | "done" | "error";

const MAX_SIDE = 1280;
// Vercel rejects request bodies above 4.5 MB, so stay comfortably below it.
const MAX_BYTES = 4 * 1024 * 1024;

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))),
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Resize and re-encode in the browser so every upload fits Vercel's 4.5 MB
 * limit and the model gets a reasonably sized input.
 */
async function prepareImage(file: File): Promise<Prepared> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That file is not an image. Please choose a JPG, PNG or WebP.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Could not read that image. Try a JPG or PNG.");
  }

  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot process images.");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      canvas.width = width;
      canvas.height = height;
      context.drawImage(bitmap, 0, 0, width, height);

      let quality = 0.9;
      let blob = await canvasToBlob(canvas, quality);
      while (blob.size > MAX_BYTES && quality > 0.5) {
        quality -= 0.1;
        blob = await canvasToBlob(canvas, quality);
      }

      if (blob.size <= MAX_BYTES) {
        return {
          file: new File([blob], "upload.jpg", { type: "image/jpeg" }),
          url: URL.createObjectURL(blob),
          width,
          height,
        };
      }

      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
    }

    throw new Error("That image is too large to process. Try a smaller photo.");
  } finally {
    bitmap.close();
  }
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const selectionRef = useRef(0);

  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [result, setResult] = useState<Detection | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (phase !== "scanning") return;

    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed((Date.now() - started) / 1000);
    }, 100);

    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const runDetection = useCallback(async (next: Prepared) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    setPhase("scanning");
    setElapsed(0);
    setResult(null);
    setError(null);

    try {
      const form = new FormData();
      form.append("image", next.file);

      const response = await fetch("/api/predict", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => null)) as
        | (Detection & { error?: string })
        | null;

      if (!response.ok) {
        throw new Error(data?.error ?? `Detection failed (${response.status}).`);
      }
      if (!data) {
        throw new Error("The server returned an empty response.");
      }

      setResult(data);
      setPhase("done");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error ? cause.message : "Something went wrong. Please try again.",
      );
      setPhase("error");
    }
  }, []);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;

      const selection = selectionRef.current + 1;
      selectionRef.current = selection;
      requestRef.current?.abort();
      setResult(null);
      setError(null);
      setPhase("idle");

      try {
        const next = await prepareImage(file);
        if (selectionRef.current !== selection) {
          URL.revokeObjectURL(next.url);
          return;
        }

        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = next.url;
        setPrepared(next);
        void runDetection(next);
      } catch (cause) {
        if (selectionRef.current !== selection) return;
        setPrepared(null);
        setError(cause instanceof Error ? cause.message : "Could not read that image.");
        setPhase("error");
      }
    },
    [runDetection],
  );

  const reset = () => {
    selectionRef.current += 1;
    requestRef.current?.abort();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPrepared(null);
    setResult(null);
    setError(null);
    setPhase("idle");
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    void handleFile(event.dataTransfer.files?.[0]);
  };

  const confidence = result ? Math.round(result.confidence * 1000) / 10 : 0;
  const joshuaCount =
    result?.boxes.filter((box) => box.label.toLowerCase() === "joshua").length ?? 0;
  const distinctLabels = Array.from(
    new Set((result?.boxes ?? []).map((box) => box.label)),
  );
  // If boxes come back but none carry the "joshua" class, the endpoint is almost
  // certainly serving a base model instead of the custom-trained one.
  const wrongModelSuspected =
    phase === "done" &&
    result !== null &&
    !result.is_joshua &&
    result.boxes.length > 0 &&
    joshuaCount === 0;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.header}>
          <span className={styles.badge}>YOLO · Ultralytics</span>
          <h1 className={styles.title}>
            Is this <span className={styles.accent}>Joshua</span>?
          </h1>
          <p className={styles.lede}>
            Upload a photo and a custom-trained YOLO model will look for Joshua and report how
            confident it is.
          </p>
        </header>

        <section className={styles.workspace}>
          <div className={styles.uploadColumn}>
            {prepared ? (
              <div
                className={styles.preview}
                style={{ aspectRatio: `${prepared.width} / ${prepared.height}` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={prepared.url}
                  alt="Uploaded photo being scanned"
                  className={styles.previewImage}
                />

                {phase === "done" &&
                  result?.boxes.map((box, index) => (
                    <div
                      key={`${box.label}-${index}`}
                      className={
                        box.label.toLowerCase() === "joshua"
                          ? styles.boxMatch
                          : styles.boxOther
                      }
                      style={{
                        left: `${box.x1 * 100}%`,
                        top: `${box.y1 * 100}%`,
                        width: `${(box.x2 - box.x1) * 100}%`,
                        height: `${(box.y2 - box.y1) * 100}%`,
                      }}
                    >
                      <span className={styles.boxLabel}>
                        {box.label} · {Math.round(box.confidence * 100)}%
                      </span>
                    </div>
                  ))}

                {phase === "scanning" && (
                  <div className={styles.scanOverlay}>
                    <span className={styles.spinner} aria-hidden="true" />
                    <p>Scanning… {elapsed.toFixed(1)}s</p>
                    <small>First request can take up to a minute while the model wakes up.</small>
                  </div>
                )}
              </div>
            ) : (
              <label
                className={dragging ? `${styles.dropzone} ${styles.dropzoneActive}` : styles.dropzone}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*"
                  className={styles.fileInput}
                  onChange={(event) => void handleFile(event.target.files?.[0])}
                />
                <span className={styles.dropIcon} aria-hidden="true">
                  +
                </span>
                <strong>Choose a photo</strong>
                <span>or drag and drop it here</span>
                <small>JPG, PNG or WebP · resized to 1280 px in your browser</small>
              </label>
            )}
          </div>

          <div className={styles.resultColumn}>
            {phase === "scanning" ? (
              <div className={`${styles.resultCard} ${styles.resultIdle}`}>
                <span className={styles.spinner} aria-hidden="true" />
                <p className={styles.resultKicker}>Scanning</p>
                <p className={styles.resultTitle}>Looking for Joshua…</p>
                <p className={styles.resultText}>
                  Elapsed {elapsed.toFixed(1)}s. The first request may take up to a minute while
                  the endpoint starts up.
                </p>
              </div>
            ) : phase === "error" ? (
              <div className={`${styles.resultCard} ${styles.resultError}`}>
                <span className={styles.resultIcon} aria-hidden="true">
                  !
                </span>
                <p className={styles.resultKicker}>Error</p>
                <p className={styles.resultTitle}>Could not scan</p>
                <p className={styles.resultText}>{error}</p>
                <div className={styles.actions}>
                  {prepared && (
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => void runDetection(prepared)}
                    >
                      Try again
                    </button>
                  )}
                  <button type="button" className={styles.secondaryButton} onClick={reset}>
                    Choose another photo
                  </button>
                </div>
              </div>
            ) : phase === "done" && result ? (
              <div
                className={`${styles.resultCard} ${
                  result.is_joshua ? styles.resultYes : styles.resultNo
                }`}
              >
                <span className={styles.resultIcon} aria-hidden="true">
                  {result.is_joshua ? "✓" : "×"}
                </span>
                <p className={styles.resultKicker}>
                  {result.is_joshua
                    ? "Match found"
                    : result.boxes.length
                      ? "Best match"
                      : "No match"}
                </p>
                <p className={styles.resultTitle}>
                  {result.is_joshua ? "This is Joshua" : result.name}
                </p>
                <p className={styles.confidence}>
                  <span>{confidence.toFixed(1)}%</span> confidence
                </p>
                <div className={styles.meter} aria-hidden="true">
                  <span style={{ width: `${Math.min(100, result.confidence * 100)}%` }} />
                </div>
                <p className={styles.resultText}>
                  {result.is_joshua
                    ? `${joshuaCount} Joshua detection${joshuaCount === 1 ? "" : "s"} in this photo.`
                    : result.boxes.length
                      ? "A person was found, but not Joshua with enough confidence."
                      : "The model did not find a person in this photo."}
                </p>
                {wrongModelSuspected && (
                  <p className={styles.resultWarning}>
                    The endpoint returned {distinctLabels.join(", ")} — not “joshua”. It is
                    probably serving a base model instead of your trained model. Check the
                    Ultralytics deployment and its class list.
                  </p>
                )}
                <div className={styles.actions}>
                  <button type="button" className={styles.primaryButton} onClick={reset}>
                    Scan another photo
                  </button>
                  {prepared && (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => void runDetection(prepared)}
                    >
                      Re-scan
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className={`${styles.resultCard} ${styles.resultIdle}`}>
                <span className={styles.resultIcon} aria-hidden="true">
                  ?
                </span>
                <p className={styles.resultKicker}>No photo yet</p>
                <p className={styles.resultTitle}>Waiting for an image</p>
                <ol className={styles.steps}>
                  <li>Choose a photo of Joshua — or someone else.</li>
                  <li>The image is resized in your browser and sent to the detector.</li>
                  <li>The trained model returns a label and a confidence score.</li>
                </ol>
              </div>
            )}
          </div>
        </section>

        <footer className={styles.footer}>
          <p>
            Images are processed in memory by an Ultralytics endpoint and are not stored by this
            app. The model was trained on a private dataset of personal photos; only the weights
            are deployed.
          </p>
        </footer>
      </main>
    </div>
  );
}
