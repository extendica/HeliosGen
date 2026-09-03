import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/guestMode";
import { parseStudioDocument } from "@/lib/studio";
import { readStudio, saveStudio, StudioConflict } from "@/lib/studioStorage";

export async function GET(req: NextRequest) {
  const user = await resolveUserId(req);
  if (!user)
    return NextResponse.json(
      { error: "Sign in to use Studio." },
      { status: 401 },
    );
  try {
    return NextResponse.json(await readStudio(user), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
export async function PUT(req: NextRequest) {
  const user = await resolveUserId(req);
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const raw = await req.text();
    if (raw.length > 2_000_000)
      return NextResponse.json(
        { error: "Studio document exceeds 2 MB." },
        { status: 413 },
      );
    const body = JSON.parse(raw);
    if (!Number.isInteger(body.revision) || body.revision < 0)
      throw new Error("Invalid revision.");
    const document = parseStudioDocument(body.document);
    return NextResponse.json(await saveStudio(user, body.revision, document));
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: e instanceof StudioConflict ? 409 : 400 },
    );
  }
}
