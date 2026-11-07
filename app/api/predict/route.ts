import { NextRequest, NextResponse } from "next/server";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 60;

const NAMES: Record<number, string> = { 0: "joshua", 1: "other" };
let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession() {
  sessionPromise ??= ort.InferenceSession.create(
    `${process.cwd()}/model/joshua.onnx`,
    { executionProviders: ["cpu"] }
  );
  return sessionPromise;
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("image") as File | null;
  if (!file) return NextResponse.json({ error: "No image" }, { status: 400 });

  const input = Buffer.from(await file.arrayBuffer());
  const meta = await sharp(input).metadata();
  const W = meta.width!, H = meta.height!;
  const r = Math.min(640 / W, 640 / H);
  const w = Math.round(W * r), h = Math.round(H * r);
  const left = Math.floor((640 - w) / 2), top = Math.floor((640 - h) / 2);

  const { data } = await sharp(input)
    .rotate()
    .resize(w, h, { fit: "fill" })
    .extend({ left, top, right: 640 - w - left, bottom: 640 - h - top,
              background: { r: 114, g: 114, b: 114 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // HWC uint8 RGB -> CHW float32 /255
  const chw = new Float32Array(3 * 640 * 640);
  for (let i = 0, p = 0; i < 640 * 640; i++) {
    chw[i] = data[p++] / 255;
    chw[640 * 640 + i] = data[p++] / 255;
    chw[2 * 640 * 640 + i] = data[p++] / 255;
  }

  const session = await getSession();
  const tensor = new ort.Tensor("float32", chw, [1, 3, 640, 640]);
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const preds = out[session.outputNames[0]].data as Float32Array; // [1,300,6]

  const boxes = [];
  for (let i = 0; i < preds.length; i += 6) {
    const score = preds[i + 4];
    if (score < 0.25) continue;
    boxes.push({
      x1: Math.max(0, (preds[i] - left) / r),
      y1: Math.max(0, (preds[i + 1] - top) / r),
      x2: Math.min(W, (preds[i + 2] - left) / r),
      y2: Math.min(H, (preds[i + 3] - top) / r),
      confidence: score,
      label: NAMES[preds[i + 5]] ?? "unknown",
    });
  }

  const me = boxes
    .filter((b) => b.label === "joshua")
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (!me || me.confidence < 0.6) {
    return NextResponse.json({
      is_joshua: false,
      name: boxes.length ? "Not Joshua" : "No person detected",
      confidence: me?.confidence ?? 0,
      boxes,
    });
  }

  return NextResponse.json({
    is_joshua: true,
    name: "Joshua",
    confidence: Number(me.confidence.toFixed(3)),
    boxes,
  });
}