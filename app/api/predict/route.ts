import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// The Ultralytics endpoint scales to zero, so a cold start can take ~1 minute.
export const maxDuration = 60;

const JOSHUA_CONFIDENCE = 0.6;
const UPSTREAM_TIMEOUT_MS = 55_000;

type RawBox = { x1?: number; y1?: number; x2?: number; y2?: number };

type RawResult = {
  class?: number;
  name?: string;
  confidence?: number;
  box?: RawBox;
};

type EndpointPayload = {
  images?: Array<{
    shape?: [number, number];
    results?: RawResult[];
  }>;
};

type Box = {
  label: string;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function resolveEndpoint(raw: string) {
  const url = raw.trim().replace(/\/+$/, "");
  return url.endsWith("/predict") ? url : `${url}/predict`;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ULTRALYTICS_API_KEY;
  const endpoint = process.env.ULTRALYTICS_ENDPOINT;

  if (!apiKey || !endpoint) {
    return NextResponse.json(
      {
        error:
          "Server is not configured. Set ULTRALYTICS_API_KEY and ULTRALYTICS_ENDPOINT in the environment.",
      },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart/form-data upload." },
      { status: 400 },
    );
  }

  const file = form.get("image");
  if (!isFile(file) || file.size === 0) {
    return NextResponse.json({ error: "No image uploaded." }, { status: 400 });
  }

  const body = new FormData();
  body.append("file", file, file.name || "upload.jpg");
  body.append("conf", "0.25");
  body.append("iou", "0.7");
  body.append("imgsz", "640");
  // Ask the endpoint for boxes as 0-1 fractions so the browser can scale them
  // to any display size without knowing the original resolution.
  body.append("normalize", "true");

  let upstream: Response;
  try {
    upstream = await fetch(resolveEndpoint(endpoint), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "The detection service took too long to respond. It may be waking up — please try again."
          : "Could not reach the detection service. Please try again in a moment.",
      },
      { status: 502 },
    );
  }

  const text = await upstream.text();

  if (!upstream.ok) {
    const message =
      upstream.status === 401
        ? "The detection service rejected the API key (401). Check ULTRALYTICS_API_KEY."
        : upstream.status === 429
          ? "The detection service is busy (429). Please try again shortly."
          : `The detection service failed (${upstream.status}).`;

    return NextResponse.json(
      { error: message, detail: text.slice(0, 500) },
      { status: 502 },
    );
  }

  let payload: EndpointPayload;
  try {
    payload = JSON.parse(text) as EndpointPayload;
  } catch {
    return NextResponse.json(
      { error: "The detection service returned an unreadable response." },
      { status: 502 },
    );
  }

  const image = payload.images?.[0];
  const results = image?.results ?? [];

  // With normalize=true coordinates are already 0-1. If an older deployment
  // ignores the flag we fall back to pixel coordinates and divide by the
  // reported [height, width].
  const shape = image?.shape;
  const pixelWidth = shape?.[1] ?? 1;
  const pixelHeight = shape?.[0] ?? 1;

  const toFraction = (value: number | undefined, total: number) => {
    if (value === undefined) return 0;
    // Values above ~1.5 can only be pixels.
    return value > 1.5 ? clamp01(value / (total || 1)) : clamp01(value);
  };

  const boxes: Box[] = results
    .filter((result) => result.box)
    .map((result) => {
      const box = result.box ?? {};
      return {
        label: result.name ?? String(result.class ?? "unknown"),
        confidence: Number(result.confidence ?? 0),
        x1: toFraction(box.x1, pixelWidth),
        y1: toFraction(box.y1, pixelHeight),
        x2: toFraction(box.x2, pixelWidth),
        y2: toFraction(box.y2, pixelHeight),
      };
    })
    .filter((box) => box.x2 > box.x1 && box.y2 > box.y1)
    .sort((a, b) => b.confidence - a.confidence);

  const match = boxes.find(
    (box) => box.label.toLowerCase() === "joshua" && box.confidence >= JOSHUA_CONFIDENCE,
  );

  if (match) {
    return NextResponse.json({
      is_joshua: true,
      name: "Joshua",
      confidence: Number(match.confidence.toFixed(3)),
      boxes,
    });
  }

  const best = boxes[0];
  return NextResponse.json({
    is_joshua: false,
    name: boxes.length ? "Not Joshua" : "No person detected",
    confidence: Number((best?.confidence ?? 0).toFixed(3)),
    boxes,
  });
}

export function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.ULTRALYTICS_API_KEY && process.env.ULTRALYTICS_ENDPOINT),
  });
}
