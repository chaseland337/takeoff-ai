import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../src/model';

const mocks = vi.hoisted(() => ({
  results: [] as { data?: unknown; error: unknown }[],
  calls: [] as { method: string; args: unknown[] }[],
  upload: vi.fn(async () => ({ error: null })),
  remove: vi.fn(async () => ({ error: null })),
  list: vi.fn(async (): Promise<{ data: { name: string }[]; error: unknown }> => ({ data: [], error: null })),
  rpcHook: undefined as undefined | (() => Promise<unknown>),
}));
vi.mock('../src/webAuth', () => ({
  companyAccessLocked: () => false,
  companyErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  currentMembership: () => ({ organizationId: 'org', userId: 'user' }),
  supabase: () => ({
    from: (table: string) => {
      mocks.calls.push({ method: 'from', args: [table] });
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'maybeSingle', 'single', 'insert', 'update', 'upsert', 'delete']) {
        builder[method] = (...args: unknown[]) => { mocks.calls.push({ method, args }); return builder; };
      }
      builder.then = (resolve: (result: unknown) => void) => Promise.resolve(mocks.results.shift() ?? { data: [], error: null }).then(resolve);
      return builder;
    },
    storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove, list: mocks.list }) },
    rpc: async (...args: unknown[]) => { mocks.calls.push({ method: 'rpc', args }); return mocks.rpcHook ? mocks.rpcHook() : mocks.results.shift() ?? { error: null }; },
  }),
}));
import { cloudSave, cloudLoad, cloudSavePdf, cloudLoadPdf, cloudStatus, resetCloud, cloudDelete, retryCloud, ConflictError, cloudSaveActivity, markCloudDirty, flushCloud, cloudActivate } from '../src/cloudStorage';

beforeEach(() => { resetCloud(); mocks.results.length = 0; mocks.calls.length = 0; mocks.rpcHook = undefined; vi.clearAllMocks(); });
describe('company persistence', () => {
  it('does not roll back the CAS baseline when opening a new copy after its activity save', async () => {
    const copy = newProject('metric');
    mocks.results.push({ error: null }, { data: { activity: [] }, error: null }, { data: { revision: 2 }, error: null });
    await cloudSave(copy);
    mocks.results.push({ data: { data: copy, name: copy.name, activity: [], revision: 2 }, error: null }, { data: { revision: 3 }, error: null });
    await cloudSaveActivity(copy.id!, []);
    cloudActivate(copy);
    mocks.results.push({ data: { activity: [] }, error: null }, { data: { revision: 4 }, error: null });
    await cloudSave({ ...copy, name: 'first edit after opening' });
    const calls = mocks.calls.filter((call) => call.method === 'rpc');
    expect((calls.at(-1)!.args[1] as { p_expected_revision: number }).p_expected_revision).toBe(3);
    expect(cloudStatus().state).toBe('online');
  });
  it('refreshes a reopened shared project but not an active editor baseline during backup reads', async () => {
    const original = newProject('metric');
    mocks.results.push({ data: { data: original, revision: 1 }, error: null });
    await cloudLoad(original.id!);
    cloudActivate(original);
    const latest = { ...original, name: 'coworker update' };
    mocks.results.push({ data: { data: latest, revision: 2 }, error: null });
    expect(await cloudLoad(original.id!)).toBe(latest);
    cloudActivate(latest);
    mocks.results.push({ data: { activity: [] }, error: null }, { data: { revision: 3 }, error: null });
    await cloudSave({ ...latest, name: 'my next change' });
    expect((mocks.calls.find((call) => call.method === 'rpc')!.args[1] as { p_expected_revision: number }).p_expected_revision).toBe(2);
    expect(cloudStatus().state).toBe('online');
  });
  it('does not silently advance active-editor CAS when a backup reads a newer remote copy', async () => {
    const original = newProject('metric');
    mocks.results.push({ data: { data: original, revision: 1 }, error: null });
    await cloudLoad(original.id!);
    cloudActivate(original);
    mocks.results.push({ data: { data: { ...original, name: 'remote' }, revision: 2 }, error: null });
    await cloudLoad(original.id!);
    mocks.results.push({ data: { activity: [] }, error: null }, { error: { code: '40001' } });
    await expect(cloudSave({ ...original, name: 'unsaved local edit' })).rejects.toBeInstanceOf(ConflictError);
    expect((mocks.calls.find((call) => call.method === 'rpc')!.args[1] as { p_expected_revision: number }).p_expected_revision).toBe(1);
  });
  it('keeps unsent newer edits dirty when an older in-flight save completes', async () => {
    const original = newProject('metric');
    mocks.results.push({ data: { data: original, revision: 1 }, error: null });
    await cloudLoad(original.id!);
    const first = { ...original, name: 'first rename' };
    markCloudDirty(first);
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const waiting = new Promise((resolve) => { finish = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    mocks.rpcHook = () => { started(); return waiting; };
    mocks.results.push({ data: { activity: [] }, error: null });
    const save = cloudSave(first);
    await began;
    const newer = { ...first, name: 'newer unsent rename' };
    markCloudDirty(newer);
    finish({ data: { revision: 2 }, error: null });
    await save;
    expect(cloudStatus().state).toBe('saving');
    await expect(flushCloud()).rejects.toThrow('waiting to be saved');
    mocks.rpcHook = undefined;
    mocks.results.push({ data: { activity: [] }, error: null }, { data: { revision: 3 }, error: null });
    await cloudSave(newer);
    expect(cloudStatus().state).toBe('online');
  });
  it('persists undo back to an older object instead of treating historical snapshots as saved', async () => {
    const first = newProject('metric');
    mocks.results.push({ data: { data: first, revision: 1 }, error: null });
    await cloudLoad(first.id!);
    mocks.results.push({ data: { activity: [] }, error: null }, { data: { revision: 2 }, error: null });
    await cloudSave({ ...first, name: 'edited' });
    mocks.results.push({ data: { activity: [] }, error: null }, { data: { revision: 3 }, error: null });
    await cloudSave(first);
    const saves = mocks.calls.filter((call) => call.method === 'rpc');
    expect(saves).toHaveLength(2);
    expect((saves[1].args[1] as { p_data: unknown }).p_data).toBe(first);
  });
  it('stages independent PDF copies until project context is known and uploads before publishing project references', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 drawing').buffer;
    await cloudSavePdf('doc', bytes);
    new Uint8Array(bytes)[0] = 0;
    expect(new TextDecoder().decode(await cloudLoadPdf('doc'))).toContain('%PDF-');
    const project = { ...newProject('metric'), docs: [{ id: 'doc', name: 'plan.pdf' }] };
    mocks.results.push({ error: null }, { error: null }, { data: { activity: [] }, error: null }, { data: { revision: 2 }, error: null });
    await cloudSave(project);
    expect(mocks.upload).toHaveBeenCalledWith(`org/${project.id}/doc.pdf`, expect.any(ArrayBuffer), expect.objectContaining({ contentType: 'application/pdf', upsert: false }));
    const inserted = mocks.calls.find((call) => call.method === 'insert')!.args[0] as { data: { docs: unknown[] } };
    expect(inserted.data.docs).toEqual([]);
    expect(mocks.calls.some((call) => call.method === 'rpc' && (call.args[1] as { p_expected_revision: number }).p_expected_revision === 1)).toBe(true);
    expect(cloudStatus().state).toBe('online');
  });
  it('blocks subsequent writes after CAS conflict, including the same unsaved object', async () => {
    const project = newProject('metric');
    mocks.results.push({ data: { data: project, revision: 3 }, error: null });
    await cloudLoad(project.id!);
    const changed = { ...project, name: 'changed' };
    mocks.results.push({ data: { activity: [] }, error: null }, { data: null, error: { code: '40001' } });
    await expect(cloudSave(changed)).rejects.toBeInstanceOf(ConflictError);
    await expect(cloudSave(changed)).rejects.toBeInstanceOf(ConflictError);
    expect(() => retryCloud()).toThrow(ConflictError);
    expect(cloudStatus()).toMatchObject({ state: 'failed', conflict: true });
  });
  it('surfaces offline errors and retries failed saves rather than marking them stored', async () => {
    const project = newProject('metric');
    mocks.results.push({ error: new Error('offline') });
    await expect(cloudSave(project)).rejects.toThrow('offline');
    expect(cloudStatus().state).toBe('failed');
    mocks.results.push({ error: null }, { data: { activity: [] }, error: null }, { data: { revision: 2 }, error: null });
    await retryCloud();
    await cloudSave(project);
    expect(mocks.calls.filter((call) => call.method === 'insert')).toHaveLength(2);
  });
  it('does not delete the project row when object removal fails', async () => {
    const project = newProject('metric');
    mocks.results.push({ data: { data: project, revision: 1 }, error: null });
    await cloudLoad(project.id!);
    mocks.results.push({ data: { deleting: true, revision: 2 }, error: null });
    mocks.list.mockResolvedValueOnce({ data: [{ name: 'doc.pdf' }], error: null });
    mocks.remove.mockResolvedValueOnce({ error: new Error('storage unavailable') } as never);
    await expect(cloudDelete(project)).rejects.toThrow('storage unavailable');
    expect(mocks.calls.some((call) => call.method === 'delete')).toBe(false);
    expect(mocks.calls.filter((call) => call.method === 'rpc').map((call) => call.args[0])).toEqual(['begin_company_project_delete']);
    mocks.results.push({ error: null });
    mocks.list.mockResolvedValueOnce({ data: [{ name: 'doc.pdf' }], error: null });
    expect(await retryCloud()).toBe('deleted');
    expect(mocks.calls.some((call) => call.method === 'rpc' && call.args[0] === 'delete_company_project')).toBe(true);
    expect(mocks.calls.filter((call) => call.method === 'rpc' && call.args[0] === 'begin_company_project_delete')).toHaveLength(1);
    expect((mocks.calls.find((call) => call.method === 'rpc' && call.args[0] === 'delete_company_project')!.args[1] as { p_expected_revision: number }).p_expected_revision).toBe(2);
  });
  it('does not enumerate or remove any files when stale deletion claim is rejected', async () => {
    const project = newProject('metric');
    mocks.results.push({ data: { data: project, revision: 1 }, error: null });
    await cloudLoad(project.id!);
    mocks.results.push({ error: { code: '40001' } });
    await expect(cloudDelete(project)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('uses CAS for activity and advances the expected revision for the next project save', async () => {
    const project = newProject('metric');
    mocks.results.push({ data: { data: project, revision: 8 }, error: null });
    await cloudLoad(project.id!);
    mocks.results.push({ data: { activity: [], revision: 8, data: project, name: project.name }, error: null }, { data: { revision: 9 }, error: null });
    await cloudSaveActivity(project.id!, []);
    mocks.results.push({ data: { activity: [] }, error: null }, { data: { revision: 10 }, error: null });
    await cloudSave({ ...project, name: 'next' });
    expect(mocks.calls.filter((call) => call.method === 'rpc').map((call) => (call.args[1] as { p_expected_revision: number }).p_expected_revision)).toEqual([8, 9]);
  });
  it('rejects oversized and non-PDF uploads before staging', async () => {
    await expect(cloudSavePdf('bad', new ArrayBuffer(3))).rejects.toThrow('Only PDF');
    await expect(cloudSavePdf('large', new ArrayBuffer(50 * 1024 * 1024 + 1))).rejects.toThrow('50 MB');
  });
});
