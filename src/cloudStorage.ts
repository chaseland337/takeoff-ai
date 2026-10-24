import type { Project } from './model';
import type { ActivityEvent } from './activity';
import { companyAccessLocked, companyErrorMessage, currentMembership, supabase } from './webAuth';

export class ConflictError extends Error {
  constructor() { super('This project changed on another computer. Export your work, then reload. Your changes have not been saved.'); }
}
export interface CloudStatus { state: 'online' | 'saving' | 'failed'; error?: string; conflict?: boolean }
let status: CloudStatus = { state: 'online' };
const listeners = new Set<() => void>();
export const cloudStatus = () => status;
export function subscribeCloud(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(next: CloudStatus) { status = next; listeners.forEach((listener) => listener()); }
const revisions = new Map<string, number>();
const stored = new Map<string, Project>();
const staged = new Map<string, ArrayBuffer>();
let queue: Promise<unknown> = Promise.resolve();
let current: string | undefined;
let epoch = 0;
let dirtyVersion = 0;
let savedVersion = 0;
let projectVersions = new WeakMap<Project, number>();
let loadedRevisions = new WeakMap<Project, number>();
let failedOperation: (() => Promise<unknown>) | undefined;
export function resetCloud() {
  epoch++;
  revisions.clear(); staged.clear(); stored.clear(); current = undefined;
  failedOperation = undefined;
  dirtyVersion = 0; savedVersion = 0; projectVersions = new WeakMap();
  loadedRevisions = new WeakMap();
  publish({ state: 'online' });
}
function context() {
  if (companyAccessLocked()) throw new Error('Company access verification is paused. Retry verification to keep working.');
  const member = currentMembership();
  if (!member) throw new Error('Company membership must be verified before opening projects.');
  return member;
}
function checked<T extends { error: unknown }>(result: T): T {
  if (result.error) {
    if ((result.error as { code?: string }).code === '40001') throw new ConflictError();
    throw result.error;
  }
  return result;
}
export function reportCloudError(error: unknown) {
  publish({ state: 'failed', error: companyErrorMessage(error), conflict: error instanceof ConflictError || status.conflict });
}
export function retryCloud() {
  if (status.conflict) throw new ConflictError();
  const operation = failedOperation;
  failedOperation = undefined;
  publish({ state: 'online' });
  return operation ? write(operation) : Promise.resolve();
}
export function markCloudDirty(project?: Project) {
  dirtyVersion++;
  if (project) projectVersions.set(project, dirtyVersion);
  if (status.state !== 'failed') publish({ state: 'saving' });
}
function write<T>(operation: () => Promise<T>): Promise<T> {
  const generation = epoch;
  const next = queue.then(async () => {
    if (generation !== epoch) throw new Error('Account changed. Reopen the project.');
    if (status.conflict) throw new ConflictError();
    if (status.state === 'failed') throw new Error(status.error);
    publish({ state: 'saving' });
    try {
      const result = await operation();
      if (generation === epoch) publish({ state: staged.size || dirtyVersion > savedVersion ? 'saving' : 'online' });
      return result;
    } catch (error) {
      if (generation === epoch) { failedOperation = operation; reportCloudError(error); }
      throw error;
    }
  });
  queue = next.catch(() => undefined);
  return next;
}
export async function flushCloud() {
  await queue;
  if (status.state === 'failed') throw new Error(status.error);
  if (staged.size) throw new Error('A drawing import is still waiting to be saved. Finish the import before signing out.');
  if (dirtyVersion > savedVersion) throw new Error('Changes are still waiting to be saved.');
}
export async function cloudList() {
  const { organizationId } = context();
  const result = checked(await supabase().from('projects').select('id,name,data,created_at,updated_at,deleting').eq('organization_id', organizationId).order('updated_at', { ascending: false }));
  return (result.data ?? []).map((row) => {
    const p = row.data as Project;
    return { id: row.id as string, name: row.name as string, units: p.units, createdAt: row.created_at as string, updatedAt: row.updated_at as string, sheets: p.sheets.length, takeoffs: p.measurements.length, deleting: !!row.deleting };
  });
}
export async function cloudLoad(id: string) {
  const { organizationId } = context();
  const { data } = checked(await supabase().from('projects').select('data,revision,deleting').eq('organization_id', organizationId).eq('id', id).maybeSingle());
  if (!data) return undefined;
  const project = data.data as Project;
  loadedRevisions.set(project, Number(data.revision));
  // Merely reading for backup/export must not change an open editor's CAS baseline.
  if (!revisions.has(id)) {
    revisions.set(id, Number(data.revision));
    stored.set(id, project);
  }
  return project;
}
export function cloudActivate(project: Project) {
  if (!project.id) return;
  const revision = loadedRevisions.get(project);
  if (revision !== undefined) {
    revisions.set(project.id, revision);
    stored.set(project.id, project);
    loadedRevisions.delete(project);
  }
  current = project.id;
}
export async function cloudCurrent() {
  const projects = (await cloudList()).filter((project) => !project.deleting);
  const id = projects.find((p) => p.id === current)?.id ?? projects[0]?.id;
  return id ? cloudLoad(id) : undefined;
}
const bucket = () => supabase().storage.from('project-drawings');
async function uploadDrawings(project: Project) {
  const { organizationId } = context();
  for (const doc of project.docs) {
    const bytes = staged.get(doc.id);
    if (!bytes) continue;
    const path = `${organizationId}/${project.id}/${doc.id}.pdf`;
    // Metadata authorizes the private object path. Keep bytes staged until the whole save succeeds.
    checked(await supabase().from('project_drawings').upsert({ id: doc.id, project_id: project.id, storage_path: path, original_name: doc.name }, { onConflict: 'id' }));
    const result = await bucket().upload(path, bytes, { contentType: 'application/pdf', upsert: false });
    if (result.error) {
      // A successful immutable upload may have lost its response. Only reuse it if the bytes match.
      const existing = checked(await bucket().download(path)).data;
      if (!existing) throw result.error;
      const previous = new Uint8Array(await existing.arrayBuffer());
      const next = new Uint8Array(bytes);
      if (previous.length !== next.length || previous.some((value, index) => value !== next[index])) throw result.error;
    }
  }
}
export const cloudSave = (project: Project) => {
  const version = projectVersions.get(project) ?? dirtyVersion;
  return write(async () => {
  if (!project.id) throw new Error('Project ID is missing.');
  const { organizationId, userId } = context();
  const revision = revisions.get(project.id);
  if (stored.get(project.id) === project && !project.docs.some((doc) => staged.has(doc.id))) { current = project.id; savedVersion = Math.max(savedVersion, version); return; }
  if (revision === undefined) {
    // Reserve a row for drawing authorization, without publishing references to not-yet-uploaded PDFs.
    const shell = { ...project, docs: [], sheets: [], measurements: [] };
    checked(await supabase().from('projects').insert({ id: project.id, organization_id: organizationId, name: project.name, data: shell, created_by: userId, updated_by: userId }));
    revisions.set(project.id, 1);
  }
  await uploadDrawings(project);
  const expected = revisions.get(project.id)!;
  const activity = await cloudActivity(project.id);
  const { data } = checked(await supabase().rpc('save_company_project', { p_project_id: project.id, p_expected_revision: expected, p_name: project.name, p_data: project, p_activity: activity }));
  if (!data) throw new ConflictError();
  revisions.set(project.id, Number(data.revision));
  for (const doc of project.docs) staged.delete(doc.id);
  stored.set(project.id, project); current = project.id;
  savedVersion = Math.max(savedVersion, version);
  });
};
export async function cloudSavePdf(id: string, data: ArrayBuffer) {
  context();
  if (data.byteLength > 50 * 1024 * 1024) throw new Error('PDFs must be 50 MB or smaller.');
  if (new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-') throw new Error('Only PDF drawing files are supported.');
  staged.set(id, data.slice(0));
  markCloudDirty();
}
export async function cloudLoadPdf(id: string): Promise<ArrayBuffer | undefined> {
  context();
  if (staged.has(id)) return staged.get(id)!.slice(0);
  const { data } = checked(await supabase().from('project_drawings').select('storage_path').eq('id', id).single());
  if (!data) throw new Error('Drawing metadata is missing. Reload or contact your administrator.');
  const result = checked(await bucket().download(data.storage_path));
  if (!result.data) throw new Error('Drawing could not be downloaded.');
  return result.data.arrayBuffer();
}
export const cloudDeletePdf = (id: string) => write(async () => {
  context();
  if (staged.delete(id)) return;
  const { data } = checked(await supabase().from('project_drawings').select('storage_path').eq('id', id).maybeSingle());
  if (!data) return;
  checked(await bucket().remove([data.storage_path]));
  checked(await supabase().from('project_drawings').delete().eq('id', id));
});
export const cloudDelete = (project: Project) => {
  let claimRevision: number | undefined;
  let claimAttempted = false;
  return write(async () => {
    const { organizationId } = context();
    let expected = project.id === current ? revisions.get(project.id!) : loadedRevisions.get(project) ?? revisions.get(project.id!);
    if (expected === undefined) throw new Error('Open the project before deleting it.');
    if (claimRevision === undefined) {
      if (claimAttempted) {
        const { data: interrupted } = checked(await supabase().from('projects').select('revision,deleting').eq('organization_id', organizationId).eq('id', project.id!).single());
        if (interrupted?.deleting) expected = Number(interrupted.revision);
      }
      claimAttempted = true;
      const { data: claim } = checked(await supabase().rpc('begin_company_project_delete', { p_project_id: project.id, p_expected_revision: expected }));
      if (!claim || !claim.deleting || !Number.isFinite(Number(claim.revision))) throw new Error('Project deletion could not be claimed. No drawings were removed.');
      claimRevision = Number(claim.revision);
      revisions.set(project.id!, claimRevision);
    }
    // Claim freezes saves and uploads. Enumerate the whole prefix, including objects
    // left by interrupted imports, before deleting anything (pagination offsets stay stable).
    const prefix = `${organizationId}/${project.id}`;
    const paths: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data: files } = checked(await bucket().list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }));
      if (!files) throw new Error('Could not enumerate project drawings. Retry project deletion.');
      paths.push(...files.map((file) => `${prefix}/${file.name}`));
      if (files.length < 1000) break;
    }
    for (let index = 0; index < paths.length; index += 1000) checked(await bucket().remove(paths.slice(index, index + 1000)));
    checked(await supabase().rpc('delete_company_project', { p_project_id: project.id, p_expected_revision: claimRevision }));
    revisions.delete(project.id!); stored.delete(project.id!);
    return 'deleted' as const;
  });
};
export async function cloudActivity(id: string): Promise<ActivityEvent[]> {
  const { organizationId } = context();
  const { data } = checked(await supabase().from('projects').select('activity').eq('organization_id', organizationId).eq('id', id).maybeSingle());
  return data?.activity ?? [];
}
export const cloudSaveActivity = (id: string, events: ActivityEvent[]) => write(async () => {
  const { organizationId } = context();
  const expected = revisions.get(id);
  if (expected === undefined) throw new Error('Save the project before saving its activity.');
  const { data: remote } = checked(await supabase().from('projects').select('data,name,activity,revision').eq('organization_id', organizationId).eq('id', id).single());
  if (!remote || Number(remote.revision) !== expected) throw new ConflictError();
  const previous = (remote.activity ?? []) as ActivityEvent[];
  const merged = [...new Map([...previous, ...events].map((event) => [event.id, event])).values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-20000);
  const { data } = checked(await supabase().rpc('save_company_project', { p_project_id: id, p_expected_revision: expected, p_name: remote.name, p_data: remote.data, p_activity: merged }));
  if (!data) throw new ConflictError();
  revisions.set(id, Number(data.revision));
});
