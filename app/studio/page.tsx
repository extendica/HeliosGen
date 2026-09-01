"use client";

/* eslint-disable @next/next/no-img-element -- Exact user-upload previews; do not transform identity references. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Clapperboard,
  Plus,
  Save,
  Download,
  Play,
  Check,
  RefreshCw,
  ImagePlus,
  Sparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { IMAGE_MODELS } from "@/lib/modelConfig";
import { makeZip, type ZipEntry } from "@/lib/makeZip";
import {
  buildLookPrompt,
  buildScenePrompt,
  DEFAULT_DIRECTION,
  emptyStudio,
  fileStem,
  parseDirectorScenes,
  sceneWarning,
  STUDIO_DIRECTOR,
  STUDIO_IMAGE_MODELS,
  type StudioAvatar,
  type StudioDocument,
  type StudioEnvelope,
  type StudioProject,
  type StudioScene,
  type StudioTake,
} from "@/lib/studio";

const input =
  "w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-lime-300 disabled:opacity-50";
const button =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition";
const primary = `${button} bg-lime-300 text-black border-lime-300 hover:bg-lime-200 font-semibold`;
const card = "rounded-2xl border border-white/10 bg-white/[0.025] p-5";
const uuid = () => crypto.randomUUID();

async function headers(): Promise<Record<string, string>> {
  if (process.env.NEXT_PUBLIC_GUEST_MODE === "true") return {};
  const {
    data: { session },
  } = await createClient().auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(await headers()),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function director(
  source: string,
  direction: string,
): Promise<StudioScene[]> {
  const response = await fetch("/api/assistant", {
    method: "POST",
    headers: { ...(await headers()), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3-flash",
      messages: [
        { role: "system", content: STUDIO_DIRECTOR },
        {
          role: "user",
          content: `Avatar direction:\n${direction}\n\nScript or breakdown:\n${source}`,
        },
      ],
    }),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error ?? "Director request failed.");
  }
  if (!response.body) throw new Error("No director response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  function consume(line: string) {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const data = JSON.parse(payload);
    if (data.error)
      throw new Error(data.error.message ?? "Director stream failed.");
    const content = data.choices?.[0]?.delta?.content;
    if (typeof content === "string") text += content;
  }
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) consume(line.trimEnd());
    if (done) {
      consume(pending);
      break;
    }
  }
  const scenes = parseDirectorScenes(text);
  if (!scenes.length) throw new Error("Director returned no scenes.");
  return scenes;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-medium text-white/60">{label}</span>
      {children}
    </label>
  );
}
function UploadField({
  label,
  onFile,
}: {
  label: string;
  onFile: (file: File) => void;
}) {
  return (
    <Field label={label}>
      <input
        aria-label={label}
        type="file"
        accept="image/*"
        className="w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-white"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
    </Field>
  );
}
function Preview({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex aspect-[9/12] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/30">
      {url ? (
        <img src={url} alt={label} className="h-full w-full object-contain" />
      ) : (
        <div className="p-6 text-center text-xs text-white/35">
          <ImagePlus className="mx-auto mb-3" />
          {label}
        </div>
      )}
    </div>
  );
}

export default function StudioPage() {
  const [envelope, setEnvelope] = useState<StudioEnvelope>(emptyStudio);
  const current = useRef(envelope);
  const saved = useRef("");
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [avatarId, setAvatarId] = useState("");
  const [tab, setTab] = useState<"projects" | "avatars">("projects");
  const [takeRecords, setTakes] = useState<StudioTake[]>([]);
  const [loadedTakesProject, setLoadedTakesProject] = useState("");
  const takes = takeRecords.filter((t) => t.projectId === projectId);
  const project = envelope.document.projects.find((p) => p.id === projectId);
  const avatar = envelope.document.avatars.find(
    (a) => a.id === (tab === "avatars" ? avatarId : project?.avatarId),
  );

  function change(fn: (d: StudioDocument) => StudioDocument) {
    const next = { ...current.current, document: fn(current.current.document) };
    current.current = next;
    setEnvelope(next);
    setDirty(JSON.stringify(next.document) !== saved.current);
  }
  function patchProject(patch: Partial<StudioProject>) {
    change((d) => ({
      ...d,
      projects: d.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              ...patch,
              ...("firstFrameUrl" in patch || "avatarId" in patch
                ? {
                    scenes: (patch.scenes ?? p.scenes).map((s) => ({
                      ...s,
                      approved: false,
                      selectedTakeId: "",
                    })),
                  }
                : {}),
            }
          : p,
      ),
    }));
  }
  function patchAvatar(patch: Partial<StudioAvatar>) {
    change((d) => ({
      ...d,
      avatars: d.avatars.map((a) =>
        a.id === avatarId ? { ...a, ...patch } : a,
      ),
      projects:
        "direction" in patch
          ? d.projects.map((p) =>
              p.avatarId === avatarId
                ? {
                    ...p,
                    scenes: p.scenes.map((s) => ({
                      ...s,
                      approved: false,
                      selectedTakeId: "",
                    })),
                  }
                : p,
            )
          : d.projects,
    }));
  }
  function patchScene(id: string, patch: Partial<StudioScene>) {
    const edited =
      "dialogue" in patch || "motion" in patch || "duration" in patch;
    change((d) => ({
      ...d,
      projects: d.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              scenes: p.scenes.map((s) =>
                s.id === id
                  ? {
                      ...s,
                      ...patch,
                      ...(edited
                        ? { approved: false, selectedTakeId: "" }
                        : {}),
                    }
                  : s,
              ),
            }
          : p,
      ),
    }));
  }
  const load = useCallback(async () => {
    const value = await api<StudioEnvelope>("/api/studio");
    current.current = value;
    setEnvelope(value);
    saved.current = JSON.stringify(value.document);
    setDirty(false);
    setReady(true);
    setProjectId(value.document.projects[0]?.id ?? "");
    setAvatarId(value.document.avatars[0]?.id ?? "");
  }, []);
  useEffect(() => {
    void Promise.resolve()
      .then(load)
      .catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || busyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        link &&
        link.origin === window.location.origin &&
        link.pathname !== "/studio" &&
        (dirty || busyRef.current) &&
        !window.confirm(
          "There are unsaved changes or submissions in progress. Leave Studio?",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty]);
  // The global sidebar can sign out without leaving this route: never retain another user's draft.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_GUEST_MODE === "true") return;
    const {
      data: { subscription },
    } = createClient().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.reload();
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!ready || !projectId) return;
    let stopped = false;
    async function poll() {
      try {
        const data = await api<{ takes: StudioTake[] }>(
          `/api/studio/jobs?projectId=${encodeURIComponent(projectId)}`,
        );
        if (!stopped) {
          setTakes((previous) => [
            ...previous.filter(
              (t) => !data.takes.some((incoming) => incoming.id === t.id),
            ),
            ...data.takes,
          ]);
          setLoadedTakesProject(projectId);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    }
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [ready, projectId]);
  async function save() {
    const next = await api<StudioEnvelope>(
      "/api/studio",
      "PUT",
      current.current,
    );
    current.current = next;
    setEnvelope(next);
    saved.current = JSON.stringify(next.document);
    setDirty(false);
    return next;
  }
  async function run(label: string, fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  async function upload(file: File, apply: (url: string) => void) {
    if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024)
      throw new Error("Choose an image smaller than 20 MB.");
    const res = await fetch("/api/upload-asset", {
      method: "POST",
      headers: { ...(await headers()), "Content-Type": file.type },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Upload failed.");
    apply(data.cdnUrl);
    await save();
  }
  async function submit(ids: (string | undefined)[]) {
    if (!project) return;
    if (loadedTakesProject !== project.id) {
      setError("Wait for existing takes to load before submitting.");
      return;
    }
    if (
      !window.confirm(
        `Submit ${ids.length} ${ids[0] ? "Kling video" : "image"} generation${ids.length > 1 ? "s" : ""}? This spends Kie credits. Failed or uncertain requests are never retried automatically.`,
      )
    )
      return;
    await run("Submitting approved jobs…", async () => {
      const snapshot = await save();
      for (const sceneId of ids) {
        const result = await api<{ take: StudioTake }>(
          "/api/studio/jobs",
          "POST",
          {
            projectId: project.id,
            sceneId,
            revision: snapshot.revision,
            requestId: uuid(),
          },
        );
        setTakes((previous) => [
          result.take,
          ...previous.filter((t) => t.id !== result.take.id),
        ]);
        if (result.take.state !== "submitted")
          throw new Error(
            result.take.error ??
              "Submission is uncertain. Check Kie logs before retrying.",
          );
      }
      setMessage(
        "Jobs submitted. You can return later to review; rendering continues on the provider.",
      );
    });
  }
  async function exportClips() {
    if (!project) return;
    const entries: ZipEntry[] = [];
    const notes: string[] = [];
    for (const [index, scene] of project.scenes.entries()) {
      if (!scene.selectedTakeId) continue;
      const take = takes.find(
        (t) =>
          t.id === scene.selectedTakeId &&
          t.sceneId === scene.id &&
          t.status === "done" &&
          t.videoUrl,
      );
      if (!take?.videoUrl)
        throw new Error(
          `Approved take for ${scene.title} is not available. Refresh before exporting.`,
        );
      const name = `${String(index + 1).padStart(2, "0")}_${fileStem(scene.title)}.mp4`;
      const response = await fetch(
        `/api/download?url=${encodeURIComponent(take.videoUrl)}&filename=${encodeURIComponent(name)}`,
      );
      if (!response.ok)
        throw new Error(
          `Could not download ${scene.title}. No incomplete ZIP was exported.`,
        );
      entries.push({
        name,
        data: new Uint8Array(await response.arrayBuffer()),
      });
      notes.push(
        `${name}\nTake: ${take.id}\nGenerated prompt: ${take.snapshot.prompt}\nEditing notes: ${scene.notes}\n`,
      );
    }
    if (!entries.length)
      throw new Error("Approve at least one completed take first.");
    entries.push({
      name: "script_and_editing_notes.txt",
      data: new TextEncoder().encode(notes.join("\n")),
    });
    download(makeZip(entries), `${fileStem(project.name)}_approved.zip`);
  }
  function addProject() {
    const a =
      envelope.document.avatars.find((a) => a.id === avatarId) ??
      envelope.document.avatars[0];
    const p: StudioProject = {
      id: uuid(),
      name: `Persona video ${envelope.document.projects.length + 1}`,
      avatarId: a?.id ?? "",
      outfitUrl: "",
      lookPrompt: a ? buildLookPrompt(a) : "",
      imageModel: "gpt-image-2",
      firstFrameUrl: "",
      source: "",
      scenes: [],
    };
    change((d) => ({ ...d, projects: [...d.projects, p] }));
    setProjectId(p.id);
    setTab("projects");
  }
  function addAvatar() {
    const a = {
      id: uuid(),
      name: `Avatar ${envelope.document.avatars.length + 1}`,
      imageUrl: "",
      direction: DEFAULT_DIRECTION,
    };
    change((d) => ({ ...d, avatars: [...d.avatars, a] }));
    setAvatarId(a.id);
    setTab("avatars");
  }
  const active = (sceneId: string) =>
    takes.some(
      (t) =>
        t.sceneId === sceneId &&
        (t.state === "submitting" ||
          t.state === "unknown" ||
          (t.state === "submitted" &&
            t.status !== "done" &&
            t.status !== "error")),
    );

  return (
    <main className="flex-1 overflow-auto p-5 md:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.2em] text-lime-300">
            <Clapperboard size={16} /> Production desk
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Persona Studio
          </h1>
          <p className="mt-2 text-sm text-white/45">
            One approved look. Every scene. Your best takes, together.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={button}
            disabled={!ready || !!busy}
            onClick={() =>
              download(
                new Blob([JSON.stringify(current.current, null, 2)], {
                  type: "application/json",
                }),
                "studio-draft.json",
              )
            }
          >
            <Download size={15} /> Export draft
          </button>
          <button
            className={primary}
            disabled={!ready || !!busy || !dirty}
            onClick={() =>
              run("Saving…", async () => {
                await save();
                setMessage("Saved to your workspace.");
              })
            }
          >
            <Save size={15} /> {dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </header>
      {(error || message || busy) && (
        <div
          role={error ? "alert" : "status"}
          className={`mb-5 rounded-xl border p-4 text-sm ${error ? "border-red-400/30 bg-red-400/10 text-red-200" : "border-lime-300/20 bg-lime-300/5 text-lime-100"}`}
        >
          {error || busy || message}
          {!ready && (
            <button
              className={`${button} ml-3`}
              onClick={() => run("Loading…", load)}
            >
              Retry connection
            </button>
          )}
        </div>
      )}
      {!ready ? (
        <div className={card}>
          Connecting to your saved production workspace…
        </div>
      ) : (
        <fieldset disabled={!!busy} className="min-w-0">
          <div className="mb-6 flex flex-wrap gap-2">
            <button
              className={tab === "projects" ? primary : button}
              onClick={() => setTab("projects")}
            >
              Projects{" "}
              <span className="opacity-60">
                {envelope.document.projects.length}
              </span>
            </button>
            <button
              className={tab === "avatars" ? primary : button}
              onClick={() => setTab("avatars")}
            >
              Avatar library{" "}
              <span className="opacity-60">
                {envelope.document.avatars.length}
              </span>
            </button>
          </div>
          <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
            <aside className="space-y-3">
              <button
                className={`${button} w-full`}
                onClick={tab === "avatars" ? addAvatar : addProject}
              >
                <Plus size={16} /> New{" "}
                {tab === "avatars" ? "avatar" : "project"}
              </button>
              {(tab === "avatars"
                ? envelope.document.avatars
                : envelope.document.projects
              ).map((item) => (
                <button
                  key={item.id}
                  onClick={() =>
                    tab === "avatars"
                      ? setAvatarId(item.id)
                      : setProjectId(item.id)
                  }
                  className={`w-full rounded-xl border p-3 text-left text-sm ${item.id === (tab === "avatars" ? avatarId : projectId) ? "border-lime-300/40 bg-lime-300/5" : "border-white/10 text-white/55 hover:bg-white/5"}`}
                >
                  {item.name || "Untitled"}
                </button>
              ))}
              <p className="pt-3 text-xs leading-relaxed text-white/35">
                Save edits before leaving. Paid generation always requires
                confirmation. CapCut remains your final editing step.
              </p>
            </aside>
            <div className="min-w-0 space-y-6">
              {tab === "avatars" &&
                (avatar ? (
                  <section
                    className={`${card} grid gap-6 md:grid-cols-[180px_minmax(0,1fr)]`}
                  >
                    <Preview
                      url={avatar.imageUrl}
                      label="Day 1 identity anchor"
                    />
                    <div className="space-y-4">
                      <h2 className="text-lg font-semibold">Identity anchor</h2>
                      <Field label="Avatar name">
                        <input
                          className={input}
                          value={avatar.name}
                          onChange={(e) =>
                            patchAvatar({ name: e.target.value })
                          }
                        />
                      </Field>
                      <UploadField
                        label="Day 1 image"
                        onFile={(file) => {
                          void run("Uploading image…", () =>
                            upload(file, (url) =>
                              patchAvatar({ imageUrl: url }),
                            ),
                          );
                        }}
                      />
                      <Field label="Default performance, voice, pose and setting notes">
                        <textarea
                          rows={5}
                          className={input}
                          value={avatar.direction}
                          onChange={(e) =>
                            patchAvatar({ direction: e.target.value })
                          }
                        />
                      </Field>
                      <p className="text-xs text-white/45">
                        Start every new look from this anchor. Uploading a new
                        anchor does not alter existing generated images or take
                        history.
                      </p>
                    </div>
                  </section>
                ) : (
                  <section className={card}>
                    <h2 className="text-xl">Add your first avatar</h2>
                    <p className="mt-2 text-white/50">
                      Save a Day 1 image and the direction you usually paste
                      into every prompt.
                    </p>
                    <button className={`${primary} mt-5`} onClick={addAvatar}>
                      <Plus size={16} /> Add avatar
                    </button>
                  </section>
                ))}
              {tab === "projects" &&
                (project ? (
                  <>
                    <section className={`${card} space-y-4`}>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Field label="Project name">
                          <input
                            className={input}
                            value={project.name}
                            onChange={(e) =>
                              patchProject({ name: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Avatar">
                          <select
                            className={input}
                            value={project.avatarId}
                            onChange={(e) => {
                              const a = envelope.document.avatars.find(
                                (a) => a.id === e.target.value,
                              );
                              patchProject({
                                avatarId: e.target.value,
                                lookPrompt: a ? buildLookPrompt(a) : "",
                                firstFrameUrl: "",
                                scenes: project.scenes.map((s) => ({
                                  ...s,
                                  approved: false,
                                })),
                              });
                            }}
                          >
                            <option value="">Choose an avatar</option>
                            {envelope.document.avatars.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                    </section>
                    <section className={card}>
                      <h2 className="mb-5 text-lg font-semibold">
                        <span className="mr-2 text-lime-300">01</span> Today’s
                        look
                      </h2>
                      <div className="grid gap-5 md:grid-cols-[150px_150px_minmax(0,1fr)]">
                        <div>
                          <Preview
                            url={avatar?.imageUrl ?? ""}
                            label="Day 1 anchor"
                          />
                          <p className="mt-2 text-xs text-white/45">
                            Identity · pose · setting
                          </p>
                        </div>
                        <div>
                          <Preview
                            url={project.outfitUrl}
                            label="Outfit reference"
                          />
                          <p className="mt-2 text-xs text-white/45">
                            Clothing · hairstyle
                          </p>
                        </div>
                        <div className="space-y-4">
                          <UploadField
                            label="Outfit / Pinterest reference"
                            onFile={(file) => {
                              void run("Uploading image…", () =>
                                upload(file, (url) =>
                                  patchProject({ outfitUrl: url }),
                                ),
                              );
                            }}
                          />
                          <Field label="Image model · Kie">
                            <select
                              className={input}
                              value={project.imageModel}
                              onChange={(e) =>
                                patchProject({ imageModel: e.target.value })
                              }
                            >
                              {IMAGE_MODELS.filter((m) =>
                                STUDIO_IMAGE_MODELS.includes(m.id),
                              ).map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Image prompt · editable">
                            <textarea
                              className={input}
                              rows={5}
                              value={project.lookPrompt}
                              onChange={(e) =>
                                patchProject({ lookPrompt: e.target.value })
                              }
                            />
                          </Field>
                          <button
                            className={primary}
                            disabled={
                              !avatar?.imageUrl ||
                              !project.outfitUrl ||
                              active("")
                            }
                            onClick={() => submit([undefined])}
                          >
                            <Sparkles size={15} /> Generate look
                          </button>
                        </div>
                      </div>
                      <div className="mt-5 grid gap-4 sm:grid-cols-3">
                        {takes
                          .filter((t) => t.kind === "image")
                          .map((t) => (
                            <div
                              key={t.id}
                              className="rounded-xl border border-white/10 p-3"
                            >
                              {t.imageUrl ? (
                                <>
                                  <Preview
                                    url={t.imageUrl}
                                    label="Generated look"
                                  />
                                  <button
                                    className={`${button} mt-3 w-full`}
                                    onClick={() =>
                                      run("Approving look…", async () => {
                                        patchProject({
                                          firstFrameUrl: t.imageUrl!,
                                          scenes: project.scenes.map((s) => ({
                                            ...s,
                                            approved: false,
                                          })),
                                        });
                                        await save();
                                      })
                                    }
                                  >
                                    <Check size={14} />{" "}
                                    {project.firstFrameUrl === t.imageUrl
                                      ? "Selected first frame"
                                      : "Use as first frame"}
                                  </button>
                                </>
                              ) : (
                                <p className="text-xs text-white/55">
                                  {t.error || t.status || t.state}
                                </p>
                              )}
                              <p className="mt-2 text-xs text-white/35">
                                {String(t.snapshot.model)} ·{" "}
                                {new Date(t.createdAt).toLocaleString()}
                              </p>
                            </div>
                          ))}
                      </div>
                      <details className="mt-5 text-sm">
                        <summary className="cursor-pointer text-white/55">
                          Already have an approved first frame?
                        </summary>
                        <div className="mt-3">
                          <UploadField
                            label="Upload finished first frame"
                            onFile={(file) => {
                              void run("Uploading image…", () =>
                                upload(file, (url) =>
                                  patchProject({
                                    firstFrameUrl: url,
                                    scenes: project.scenes.map((s) => ({
                                      ...s,
                                      approved: false,
                                    })),
                                  }),
                                ),
                              );
                            }}
                          />
                        </div>
                      </details>
                    </section>
                    <section className={card}>
                      <h2 className="mb-4 text-lg font-semibold">
                        <span className="mr-2 text-lime-300">02</span> Script &
                        direction
                      </h2>
                      <Field label="Paste your script or Gemini breakdown">
                        <textarea
                          className={input}
                          rows={6}
                          value={project.source}
                          placeholder="Paste the reference breakdown or complete script. Include any approved CTA and scene-specific directions."
                          onChange={(e) =>
                            patchProject({ source: e.target.value })
                          }
                        />
                      </Field>
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button
                          className={button}
                          disabled={!project.source.trim()}
                          onClick={() => {
                            if (
                              window.confirm(
                                "Draft scene cards with Gemini through Kie? This may spend credits. New cards will be appended; existing scenes are preserved.",
                              )
                            )
                              void run("Drafting scene cards…", async () => {
                                await save();
                                const scenes = await director(
                                  project.source,
                                  avatar?.direction ?? DEFAULT_DIRECTION,
                                );
                                patchProject({
                                  scenes: [...project.scenes, ...scenes],
                                });
                                await save();
                              });
                          }}
                        >
                          <Sparkles size={15} /> Draft scenes with Gemini
                        </button>
                        <button
                          className={button}
                          onClick={() =>
                            patchProject({
                              scenes: [
                                ...project.scenes,
                                {
                                  id: uuid(),
                                  title: `Scene ${project.scenes.length + 1}`,
                                  dialogue: "",
                                  motion:
                                    "A small natural hand gesture while speaking directly to camera.",
                                  notes: "",
                                  duration: 7,
                                  approved: false,
                                  selectedTakeId: "",
                                },
                              ],
                            })
                          }
                        >
                          <Plus size={15} /> Add scene manually
                        </button>
                        <span className="text-xs text-white/40">
                          Text-only director in this first release. Video
                          analysis comes next.
                        </span>
                      </div>
                    </section>
                    <section className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-lg font-semibold">
                          <span className="mr-2 text-lime-300">03</span> Scene
                          queue
                        </h2>
                        <div className="flex gap-2">
                          <button
                            className={primary}
                            disabled={
                              !project.firstFrameUrl ||
                              !project.scenes.some(
                                (s) =>
                                  s.approved &&
                                  !active(s.id) &&
                                  !takes.some((t) => t.sceneId === s.id),
                              )
                            }
                            onClick={() =>
                              submit(
                                project.scenes
                                  .filter(
                                    (s) =>
                                      s.approved &&
                                      !active(s.id) &&
                                      !takes.some((t) => t.sceneId === s.id),
                                  )
                                  .map((s) => s.id),
                              )
                            }
                          >
                            <Play size={15} /> Generate unstarted scenes
                          </button>
                          <button
                            className={button}
                            disabled={
                              !project.scenes.some((s) => s.selectedTakeId)
                            }
                            onClick={() =>
                              run("Building approved clips ZIP…", exportClips)
                            }
                          >
                            <Download size={15} /> Approved clips ZIP
                          </button>
                        </div>
                      </div>
                      {project.firstFrameUrl ? (
                        <div className="flex items-center gap-3 rounded-xl border border-lime-300/20 bg-lime-300/5 p-3">
                          <img
                            src={project.firstFrameUrl}
                            alt="Shared approved first frame"
                            className="h-16 w-12 rounded object-cover"
                          />
                          <p className="text-xs text-white/65">
                            Every scene uses this exact first frame. No frame
                            chaining.
                            <br />
                            Kling 3.0 · 9:16 · 1080p · generated speech
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-amber-200">
                          Approve or upload a first frame before submitting
                          scenes.
                        </p>
                      )}
                      {project.scenes.map((scene, index) => (
                        <article key={scene.id} className={card}>
                          <div className="mb-4 flex items-center gap-3">
                            <span className="text-sm text-lime-300">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <input
                              aria-label={`Scene ${index + 1} title`}
                              className={input}
                              value={scene.title}
                              onChange={(e) =>
                                patchScene(scene.id, { title: e.target.value })
                              }
                            />
                            <button
                              className={button}
                              disabled={index === 0}
                              onClick={() => {
                                const scenes = [...project.scenes];
                                [scenes[index - 1], scenes[index]] = [
                                  scenes[index],
                                  scenes[index - 1],
                                ];
                                patchProject({ scenes });
                              }}
                            >
                              ↑
                            </button>
                          </div>
                          <div className="grid gap-4 md:grid-cols-2">
                            <Field label="Exact spoken dialogue">
                              <textarea
                                className={input}
                                rows={3}
                                value={scene.dialogue}
                                onChange={(e) =>
                                  patchScene(scene.id, {
                                    dialogue: e.target.value,
                                  })
                                }
                              />
                            </Field>
                            <Field label="Motion from the shared starting pose">
                              <textarea
                                className={input}
                                rows={3}
                                value={scene.motion}
                                onChange={(e) =>
                                  patchScene(scene.id, {
                                    motion: e.target.value,
                                  })
                                }
                              />
                            </Field>
                            <Field label="Duration · seconds">
                              <input
                                className={input}
                                type="number"
                                min={3}
                                max={15}
                                value={scene.duration}
                                onChange={(e) =>
                                  patchScene(scene.id, {
                                    duration: Number(e.target.value),
                                  })
                                }
                              />
                            </Field>
                            <Field label="CapCut / overlay notes · not spoken">
                              <input
                                className={input}
                                value={scene.notes}
                                onChange={(e) =>
                                  patchScene(scene.id, {
                                    notes: e.target.value,
                                  })
                                }
                              />
                            </Field>
                          </div>
                          {sceneWarning(scene) && (
                            <p className="mt-3 text-xs text-amber-200">
                              {sceneWarning(scene)}
                            </p>
                          )}
                          <div className="mt-4 flex flex-wrap items-center gap-3">
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={scene.approved}
                                disabled={!!sceneWarning(scene)}
                                onChange={(e) =>
                                  patchScene(scene.id, {
                                    approved: e.target.checked,
                                  })
                                }
                              />{" "}
                              Script & motion approved
                            </label>
                            <button
                              className={button}
                              disabled={
                                !scene.approved ||
                                !project.firstFrameUrl ||
                                active(scene.id)
                              }
                              onClick={() => submit([scene.id])}
                            >
                              <RefreshCw size={14} />{" "}
                              {takes.some((t) => t.sceneId === scene.id)
                                ? "Generate new take"
                                : "Generate scene"}
                            </button>
                          </div>
                          <details className="mt-3 text-xs text-white/45">
                            <summary className="cursor-pointer">
                              Preview complete generation prompt
                            </summary>
                            <pre className="mt-3 whitespace-pre-wrap font-sans">
                              {buildScenePrompt(
                                scene,
                                avatar?.direction ?? DEFAULT_DIRECTION,
                              )}
                            </pre>
                          </details>
                          <div className="mt-4 grid gap-4 md:grid-cols-2">
                            {takes
                              .filter((t) => t.sceneId === scene.id)
                              .map((t, takeIndex) => (
                                <div
                                  key={t.id}
                                  className={`rounded-xl border p-3 ${scene.selectedTakeId === t.id ? "border-lime-300/50" : "border-white/10"}`}
                                >
                                  <p className="mb-2 text-xs text-white/45">
                                    Take {takeIndex + 1} ·{" "}
                                    {new Date(t.createdAt).toLocaleString()}
                                  </p>
                                  {t.videoUrl ? (
                                    <>
                                      <video
                                        src={t.videoUrl}
                                        controls
                                        preload="metadata"
                                        className="max-h-72 w-full rounded-lg bg-black"
                                      />
                                      <button
                                        className={`${button} mt-3`}
                                        onClick={() =>
                                          run("Approving take…", async () => {
                                            patchScene(scene.id, {
                                              selectedTakeId: t.id,
                                            });
                                            await save();
                                          })
                                        }
                                      >
                                        <Check size={14} />{" "}
                                        {scene.selectedTakeId === t.id
                                          ? "Approved for export"
                                          : "Approve this take"}
                                      </button>
                                    </>
                                  ) : (
                                    <p className="text-sm text-white/60">
                                      {t.error || t.status || t.state}
                                    </p>
                                  )}
                                  <details className="mt-2 text-xs text-white/40">
                                    <summary>Generation snapshot</summary>
                                    <pre className="whitespace-pre-wrap">
                                      {JSON.stringify(t.snapshot, null, 2)}
                                    </pre>
                                  </details>
                                </div>
                              ))}
                          </div>
                        </article>
                      ))}
                    </section>
                  </>
                ) : (
                  <section className={card}>
                    <h2 className="text-xl">Your next video starts here.</h2>
                    <p className="mt-2 max-w-xl text-white/50">
                      Save an avatar, approve today’s look, then create and
                      review all of your scenes in one place.
                    </p>
                    <button
                      className={`${primary} mt-5`}
                      onClick={
                        envelope.document.avatars.length
                          ? addProject
                          : addAvatar
                      }
                    >
                      <Plus size={16} />{" "}
                      {envelope.document.avatars.length
                        ? "Create project"
                        : "Add your first avatar"}
                    </button>
                  </section>
                ))}
            </div>
          </div>
        </fieldset>
      )}
    </main>
  );
}
