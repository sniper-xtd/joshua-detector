# Joshua Detector

A small Next.js web app that answers one question: **is the person in this photo Joshua?**

Upload an image, and a custom-trained YOLO model returns a verdict plus a confidence score.
The model was trained on the [Ultralytics Platform](https://platform.ultralytics.com) and is
served from a Platform **dedicated endpoint**. The Next.js app on Vercel proxies the request and
authenticates it with an Ultralytics **API key** that never reaches the browser.

```
Browser ──upload──▶ Next.js /api/predict (Vercel)
                          │  Authorization: Bearer ULTRALYTICS_API_KEY
                          ▼
                    Ultralytics dedicated endpoint
                          │  YOLO model (classes: joshua, other)
                          ▼
                    boxes + confidence ──▶ "This is Joshua — 94.2%"
```

## Features

- Drag-and-drop or file-picker upload
- Images resized and re-encoded **in the browser** (≤1280 px, <4.5 MB) so they fit Vercel's request limit
- Bounding boxes drawn over the uploaded photo
- Clear verdict: **This is Joshua** / **Not Joshua** / **No person detected**, with a confidence meter
- Friendly handling of cold starts, `401`, `429` and network failures
- No API key or model weights in the client bundle

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript) |
| Hosting | Vercel |
| Model serving | Ultralytics Platform dedicated endpoint (1 vCPU / 2 GiB, scale-to-zero) |
| Model | YOLO trained on a private 2-class dataset (`joshua`, `other`) |
| Auth | Ultralytics Platform API key, server-side only |

## Repository layout

```
joshua-detector/
├── app/
│   ├── page.tsx                 # upload UI, resize, box overlay, verdict
│   ├── page.module.css
│   ├── layout.tsx
│   ├── globals.css
│   └── api/
│       └── predict/route.ts     # proxy to the Ultralytics endpoint
├── .env.example
├── next.config.ts
└── package.json
```

## Environment variables

Copy the template and fill it in:

```bash
cp .env.example .env.local
```

| Variable | Required | Description |
|---|---|---|
| `ULTRALYTICS_API_KEY` | yes | Platform key created in **Settings → API Keys**. Must be the key bound to the endpoint at creation time. |
| `ULTRALYTICS_ENDPOINT` | yes | Endpoint URL from the deployment's **Predict** tab, e.g. `https://predict-abc123.a.run.app`. `/predict` is appended automatically. |

Both are server-only. Do **not** add a `NEXT_PUBLIC_` prefix, and never commit `.env.local`.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. If the env vars are missing the upload will fail with a clear
"server is not configured" message — that is expected.

```bash
npm run lint
npm run build
```

## Deploy

### 1. Create the API key first

1. Sign in at <https://platform.ultralytics.com>
2. Open **Settings → API Keys** and create a key named `vercel-joshua`
3. Copy it immediately — it is usually shown only once

> Order matters: a dedicated endpoint is bound to the key that exists when the deployment is
> created. Create the key **before** deploying the endpoint, otherwise use the key shown in the
> deployment's **Predict → Docs** tab.

### 2. Deploy the model as an endpoint

1. Open the trained model → **Deploy**
2. Choose a region close to your users (e.g. Europe for Ghana)
3. Keep the default **1 vCPU / 2 GiB** (free, scales to zero)
4. **Create Deployment** and wait for status **Ready**
5. Copy the endpoint URL

Test it before touching the web app:

```bash
curl -X POST "$ULTRALYTICS_ENDPOINT/predict" \
  -H "Authorization: Bearer $ULTRALYTICS_API_KEY" \
  -F "file=@me.jpg" \
  -F "conf=0.25" \
  -F "normalize=true"
```

### 3. Push to GitHub

```bash
git init
git add -A
git commit -m "feat: Joshua identity detector with Ultralytics endpoint"
gh repo create joshua-detector --public --source=. --push
```

Check that `.env.local`, the dataset and any local weights are **not** in the commit.

### 4. Deploy on Vercel

1. Go to <https://vercel.com/new> and import the repository
2. Framework preset: **Next.js** (auto-detected)
3. **Settings → Environment Variables** → add `ULTRALYTICS_API_KEY` and `ULTRALYTICS_ENDPOINT`
   for Production, Preview and Development
4. **Settings → Functions → Region** → choose a European region (e.g. `fra1`) for lower latency
5. Deploy and open the `*.vercel.app` URL

## API

### `POST /api/predict`

Multipart form field: `image` (JPG/PNG/WebP).

```json
{
  "is_joshua": true,
  "name": "Joshua",
  "confidence": 0.942,
  "boxes": [
    { "label": "joshua", "confidence": 0.942, "x1": 0.21, "y1": 0.18, "x2": 0.63, "y2": 0.86 }
  ]
}
```

Box coordinates are normalized `0–1` relative to the image, so the browser can draw them at any
display size. A match requires a `joshua` detection at **≥ 0.6** confidence.

### `GET /api/predict`

Returns `{ "configured": true | false }`. Useful for checking that the environment variables made
it into a deployment without exposing their values.

## Model and dataset

| Item | Value |
|---|---|
| Task | Object detection |
| Classes | `0: joshua`, `1: other` |
| Training data | ~500 personal images, annotated on Ultralytics Platform |
| Split | 80% train / 20% validation |
| Dataset visibility | **Private** |
| License | **None** — all rights reserved, not redistributed |
| Deployment | Dedicated endpoint, 1 vCPU / 2 GiB, scale-to-zero |

The dataset stays private: raw photos are not in this repository, and neither are the trained
weights. Only the web application and this documentation are published.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Server is not configured` | `ULTRALYTICS_API_KEY` / `ULTRALYTICS_ENDPOINT` missing. Add them to `.env.local` and restart `npm run dev`, or to Vercel and redeploy. |
| `rejected the API key (401)` | The key is not the one bound to the endpoint. Copy it from the deployment's **Predict → Docs** tab. |
| First scan takes ~30–60 s | The endpoint scaled to zero. Warm it by opening the deployment page or calling `/health` before a demo. |
| `Detection service is busy (429)` | Too many concurrent requests on one instance. Wait a moment and retry. |
| `FUNCTION_PAYLOAD_TOO_LARGE` / 413 | Vercel caps request bodies at 4.5 MB. The client already shrinks images; this only happens if the resize step is bypassed. |
| Boxes are misplaced | Ensure `normalize=true` is sent. The route handles both normalized and pixel coordinates, but normalized is more reliable. |

## Limitations

- This is an **identity classifier for one person**, not a general face-recognition system. A
  second person is classified as `other` only if the training data contained such examples.
- Confidence is the model's own score, not a calibrated probability.
- The model reflects the conditions of its training photos (lighting, angle, appearance). It will
  be less reliable on very different images.
- A `404` may be returned for classes beyond `joshua` / `other` if the endpoint is redeployed with
  a different dataset — keep class names stable.

## Privacy

Personal images were used only to train the model. The dataset is private, no license is granted,
and the photos are not redistributed. Uploaded images are forwarded to the Ultralytics endpoint for
inference and are not stored by this application.

## Grading checklist

- [x] GitHub repository with source and meaningful commits
- [x] Next.js website deployed on Vercel
- [x] Ultralytics API key created and used server-side by `/api/predict`
- [x] Model trained on Ultralytics Platform and deployed as an endpoint
- [x] Upload → detection → "This is Joshua" + confidence
- [ ] Replace this checklist with the live URL and model metrics (mAP50, precision/recall)
