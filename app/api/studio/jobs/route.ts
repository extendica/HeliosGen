import { NextRequest, NextResponse } from "next/server";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { isStoredAssetUrl } from "@/lib/storageConfig";
import { prepareStudioJob, type StudioTake } from "@/lib/studio";
import {
  getTakes,
  readStudio,
  reserveTake,
  updateTake,
} from "@/lib/studioStorage";
import { POST as generateImage } from "@/app/api/generate/route";
import { POST as generateVideo } from "@/app/api/generate-video/route";
import { GET as jobStatus } from "@/app/api/job-status/route";

export const maxDuration = 120;
export async function GET(req: NextRequest) {
  const user = await resolveUserId(req);
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const records = await getTakes(user);
    const projectId = req.nextUrl.searchParams.get("projectId");
    const selected = projectId
      ? records.filter((t) => t.projectId === projectId)
      : records;
    const takes = await Promise.all(
      selected.map(async (take) => {
        if (!take.taskId) return take;
        // Only query IDs obtained from this user's saved takes, never arbitrary client IDs.
        const response = await jobStatus(
          new NextRequest(
            new URL(
              `/api/job-status?taskId=${encodeURIComponent(take.taskId)}`,
              req.url,
            ),
          ),
        );
        const result = await response.json();
        return {
          ...take,
          status: result.status,
          imageUrl: result.imageUrl,
          videoUrl: result.videoUrl,
          error: result.error ?? take.error,
        };
      }),
    );
    return NextResponse.json(
      { takes },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
export async function POST(req: NextRequest) {
  const user = await resolveUserId(req);
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    if (
      typeof body.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(body.requestId)
    )
      throw new Error("Invalid request ID.");
    const previous = (await getTakes(user)).find(
      (t) => t.id === body.requestId,
    );
    if (previous) return NextResponse.json({ take: previous });
    const { document, revision } = await readStudio(user);
    if (body.revision !== revision)
      return NextResponse.json(
        { error: "Save/reload the latest project before generation." },
        { status: 409 },
      );
    const { kind, payload } = prepareStudioJob(
      document,
      body.projectId,
      body.sceneId,
    );
    const references =
      payload.imageUrls ??
      (payload.startFrameUrl ? [payload.startFrameUrl] : []);
    if (
      references.some(
        (url) =>
          !isStoredAssetUrl(url) &&
          !(
            GUEST_MODE &&
            /^\/generated\/[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(url)
          ),
      )
    ) {
      throw new Error(
        "Upload reference images to this app before generating. External URLs are not accepted by Studio.",
      );
    }
    const take: StudioTake = {
      id: body.requestId,
      projectId: body.projectId,
      sceneId: body.sceneId ?? "",
      kind,
      createdAt: new Date().toISOString(),
      state: "submitting",
      snapshot: payload,
    };
    if (!(await reserveTake(user, take)))
      return NextResponse.json(
        {
          error:
            "This request is already being submitted. Refresh takes; do not resubmit.",
        },
        { status: 409 },
      );
    try {
      // Reuse the application's existing model adapters, user keys and callback persistence.
      const request = new NextRequest(
        new URL(
          kind === "image" ? "/api/generate" : "/api/generate-video",
          req.url,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: req.headers.get("authorization") ?? "",
          },
          body: JSON.stringify(payload),
        },
      );
      const response = await (kind === "image"
        ? generateImage(request)
        : generateVideo(request));
      const result = await response.json();
      if (response.ok && result.taskId) {
        take.taskId = result.taskId;
        take.state = "submitted";
      } else {
        take.state = response.status >= 500 ? "unknown" : "rejected";
        take.error =
          result.error ??
          "No task ID returned. Check Kie logs before retrying.";
      }
    } catch {
      take.state = "unknown";
      take.error =
        "Submission outcome unknown. Check Kie logs before creating another paid take.";
    }
    await updateTake(user, take);
    return NextResponse.json({ take });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
