import "server-only";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GUEST_MODE } from "./guestMode";
import { supabaseAdmin } from "./supabase/admin";
import {
  emptyStudio,
  type StudioEnvelope,
  type StudioDocument,
  type StudioTake,
} from "./studio";

export class StudioConflict extends Error {}
interface GuestStudio {
  workspace: StudioEnvelope;
  takes: StudioTake[];
}
const dir = join(process.cwd(), "data");
const path = join(dir, "studio.json");
function readGuest(): GuestStudio {
  return existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { workspace: emptyStudio(), takes: [] };
}
function writeGuest(data: GuestStudio) {
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data));
  renameSync(temp, path);
}
function check(error: { message: string; code?: string } | null) {
  if (error)
    throw new Error(
      ["42P01", "PGRST205"].includes(error.code ?? "")
        ? "Studio database migration is not installed. Apply supabase-studio.sql before using production Studio."
        : error.message,
    );
}
export async function readStudio(userId: string): Promise<StudioEnvelope> {
  if (GUEST_MODE) return readGuest().workspace;
  const { data, error } = await supabaseAdmin
    .from("studio_workspaces")
    .select("revision, document")
    .eq("user_id", userId)
    .maybeSingle();
  check(error);
  return data ?? emptyStudio();
}
export async function saveStudio(
  userId: string,
  revision: number,
  document: StudioDocument,
): Promise<StudioEnvelope> {
  const next = { revision: revision + 1, document };
  if (GUEST_MODE) {
    // Synchronous read/CAS/write is atomic within the supported single-process guest server.
    const data = readGuest();
    if (data.workspace.revision !== revision)
      throw new StudioConflict(
        "Studio changed in another tab. Export your draft, then reload before saving.",
      );
    data.workspace = next;
    writeGuest(data);
    return next;
  }
  if (revision === 0) {
    const { error } = await supabaseAdmin
      .from("studio_workspaces")
      .insert({ user_id: userId, ...next });
    if (error?.code === "23505")
      throw new StudioConflict(
        "Studio changed in another tab. Export your draft, then reload.",
      );
    check(error);
    return next;
  }
  const { data, error } = await supabaseAdmin
    .from("studio_workspaces")
    .update({ ...next, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("revision", revision)
    .select("revision")
    .maybeSingle();
  check(error);
  if (!data)
    throw new StudioConflict(
      "Studio changed in another tab. Export your draft, then reload.",
    );
  return next;
}
export async function getTakes(userId: string): Promise<StudioTake[]> {
  if (GUEST_MODE) return readGuest().takes;
  const { data, error } = await supabaseAdmin
    .from("studio_takes")
    .select("record")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1000);
  check(error);
  return (data ?? []).map((d) => d.record as StudioTake);
}
export async function reserveTake(
  userId: string,
  take: StudioTake,
): Promise<boolean> {
  if (GUEST_MODE) {
    const data = readGuest();
    if (data.takes.some((t) => t.id === take.id)) return false;
    data.takes.push(take);
    writeGuest(data);
    return true;
  }
  const { error } = await supabaseAdmin
    .from("studio_takes")
    .insert({ user_id: userId, id: take.id, record: take });
  if (error?.code === "23505") return false;
  check(error);
  return true;
}
export async function updateTake(userId: string, take: StudioTake) {
  if (GUEST_MODE) {
    const data = readGuest();
    data.takes = data.takes.map((t) => (t.id === take.id ? take : t));
    writeGuest(data);
    return;
  }
  const { error } = await supabaseAdmin
    .from("studio_takes")
    .update({ record: take })
    .eq("user_id", userId)
    .eq("id", take.id);
  check(error);
}
