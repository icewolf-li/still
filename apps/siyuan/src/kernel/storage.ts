import { PATHS, randomUuid, type FileStore } from "@still/core";

const LOCAL_PATH = "/conf/still/records-v1.json";
const LEGACY_PATH = "/data/storage/petal/still";

interface WorkspaceData {
  id: string;
  files: Record<string, string>;
}

async function readFile(path: string): Promise<string | null> {
  const response = await siyuan.client.fetch("/api/file/getFile", { method: "POST", body: JSON.stringify({ path }) });
  if (response.status === 404) return null;
  if (response.status === 202 && (await response.json()).code === 404) return null;
  if (response.status !== 200) throw new Error(`Still could not read ${path} (HTTP ${response.status})`);
  return response.text();
}

async function listFiles(path: string): Promise<string[]> {
  const response = await siyuan.client.fetch("/api/file/readDir", { method: "POST", body: JSON.stringify({ path }) });
  if (response.status === 404) return [];
  const result = await response.json() as { code: number; data: { isDir: boolean; name: string }[] };
  if (result.code === 404) return [];
  if (!response.ok || result.code !== 0) throw new Error(`Still could not list ${path}`);
  return result.data.filter((entry) => !entry.isDir && /^[\w.-]+\.json$/.test(entry.name)).map((entry) => entry.name);
}

async function saveWorkspace(data: WorkspaceData): Promise<void> {
  // This API takes multipart. The kernel SDK supports string bodies on all of Still's platforms.
  const json = JSON.stringify(data);
  let boundary: string;
  do boundary = `Still${randomUuid().replace(/-/g, "")}`;
  while (json.includes(boundary));
  const body = [
    `--${boundary}`, 'Content-Disposition: form-data; name="path"', "", LOCAL_PATH,
    `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="records-v1.json"',
    "Content-Type: application/json", "", json, `--${boundary}--`, "",
  ].join("\r\n");
  const response = await siyuan.client.fetch("/api/file/putFile", {
    method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body,
  });
  if (!response.ok || (await response.json()).code !== 0) throw new Error("Still could not save its local workspace data");
}

/** Keeps the kernel usable without a frontend, including after a restart. */
export async function openWorkspace(): Promise<{ id: string; files: FileStore }> {
  const stored = await readFile(LOCAL_PATH);
  let data: WorkspaceData;
  if (stored === null) {
    data = { id: randomUuid(), files: {} };
    const dirs = [PATHS.subscriptionsDir, PATHS.decisionsDir, PATHS.deliveredDir];
    const paths: string[] = [PATHS.settings, PATHS.rates, PATHS.notifications];
    for (const dir of dirs) {
      for (const name of await listFiles(`${LEGACY_PATH}/${dir}`)) paths.push(`${dir}/${name}`);
    }
    for (const path of paths) {
      const content = await readFile(`${LEGACY_PATH}/${path}`);
      if (content !== null) data.files[path] = content;
    }
    // Publishing the new file is the migration marker. The old files are a rollback copy.
    await saveWorkspace(data);
  } else {
    data = JSON.parse(stored) as WorkspaceData;
    if (typeof data.id !== "string" || !data.files || Object.values(data.files).some((value) => typeof value !== "string")) {
      throw new Error("Invalid Still workspace file");
    }
  }

  let pending = Promise.resolve();
  const files: FileStore = {
    async read(path) {
      return Object.hasOwn(data.files, path) ? data.files[path]! : null;
    },
    write(path, content) {
      const write = pending.then(async () => {
        const next = { ...data, files: { ...data.files, [path]: content } };
        await saveWorkspace(next);
        data = next;
      });
      pending = write.catch(() => undefined);
      return write;
    },
    async list(dir) {
      const prefix = `${dir}/`;
      return Object.keys(data.files).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    },
  };
  return { id: data.id, files };
}
