import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const result = await req.json();

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile", // any text model listed in the Groq console
      messages: [
        { role: "system", content: "Write one short sentence describing this detection result. Do not invent details." },
        { role: "user", content: JSON.stringify(result) },
      ],
      max_tokens: 60,
    }),
  });

  if (!res.ok) return NextResponse.json({ message: "Detection complete." });
  const json = await res.json();
  return NextResponse.json({ message: json.choices[0].message.content });
}