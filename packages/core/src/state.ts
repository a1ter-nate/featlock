import type { DomainEditor, PluginRegistration } from "@featlock/plugin";

export interface StateFailure {
  readonly state: string;
  readonly cause: unknown;
}

interface GroupedRegistration {
  readonly remove: () => void;
  readonly notify: () => void;
}

export interface RegistrationGroup {
  failed: boolean;
  readonly registrations: Set<GroupedRegistration>;
  readonly report: (failure: StateFailure) => void;
}

interface BatchState {
  active: boolean;
  readonly pending: Set<() => void>;
}

let activeGroup: RegistrationGroup | undefined;
let activeBatch: BatchState | undefined;

export function withGroup<T>(
  report: (failure: StateFailure) => void,
  fn: () => T,
): { readonly group: RegistrationGroup; readonly result: T } {
  const prev = activeGroup;
  const grp: RegistrationGroup = { failed: false, registrations: new Set(), report };
  activeGroup = grp;
  try {
    return { group: grp, result: fn() };
  } finally {
    activeGroup = prev;
  }
}

export async function withGroupAsync<T>(
  report: (failure: StateFailure) => void,
  fn: () => Promise<T>,
): Promise<{ readonly group: RegistrationGroup; readonly result: T }> {
  const prev = activeGroup;
  const grp: RegistrationGroup = { failed: false, registrations: new Set(), report };
  activeGroup = grp;
  try {
    const result = await fn();
    return { group: grp, result };
  } finally {
    activeGroup = prev;
  }
}

export function detachGroup(grp: RegistrationGroup, failure: StateFailure): void {
  if (grp.failed) return;
  grp.failed = true;
  const toNotify = new Set<() => void>();
  for (const reg of grp.registrations) {
    reg.remove();
    toNotify.add(reg.notify);
  }
  grp.registrations.clear();
  grp.report(failure);
  for (const notify of toNotify) notify();
}

export function batch<T>(fn: () => T): T {
  if (activeBatch?.active) return fn();
  const prev = activeBatch;
  const current: BatchState = { active: true, pending: new Set() };
  activeBatch = current;
  try {
    const out = fn();
    current.active = false;
    for (const notify of current.pending) notify();
    return out;
  } finally {
    current.active = false;
    activeBatch = prev;
  }
}

export interface StateOptions<TState, TEditor> {
  readonly name?: string;
  readonly initial: () => TState;
  readonly editor: (state: TState) => TEditor;
  readonly notify?: (state: TState) => void;
}

export interface StateInstance<TState, TEditor> {
  readonly get: () => TState;
  readonly transform: (cb: (editor: TEditor) => void) => PluginRegistration;
  readonly reload: () => void;
  readonly invalidate: () => void;
  readonly revision: () => number;
}

export function createState<TState, TEditor>(
  options: StateOptions<TState, TEditor>,
): StateInstance<TState, TEditor> {
  let cached = options.initial();
  let dirty = false;
  let rev = 0;
  const transforms = new Set<{
    readonly run: (editor: TEditor) => void;
    readonly group: RegistrationGroup | undefined;
  }>();

  const invalidate = (): void => {
    dirty = true;
    rev += 1;
  };

  const get = (): TState => {
    if (!dirty) return cached;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const startRev = rev;
      const next = options.initial();
      const editor = options.editor(next);
      for (const entry of Array.from(transforms)) {
        try {
          entry.run(editor);
        } catch (cause) {
          if (!entry.group) throw cause;
          detachGroup(entry.group, { state: options.name ?? "anonymous", cause });
        }
        if (rev !== startRev) break;
      }
      if (rev !== startRev) continue;
      cached = next;
      dirty = false;
      return cached;
    }
    dirty = false;
    return cached;
  };

  const notifyNow = (): void => {
    const value = get();
    if (options.notify) options.notify(value);
  };

  const markChanged = (): void => {
    invalidate();
    if (activeBatch?.active) {
      activeBatch.pending.add(notifyNow);
      return;
    }
    notifyNow();
  };

  const transform = (cb: (editor: TEditor) => void): PluginRegistration => {
    const grp = activeGroup;
    if (grp?.failed) return { dispose: () => undefined };
    const entry = { run: cb, group: grp };
    transforms.add(entry);
    const remove = (): void => {
      if (transforms.delete(entry)) invalidate();
    };
    const grouped: GroupedRegistration = { remove, notify: notifyNow };
    if (grp) grp.registrations.add(grouped);
    markChanged();
    return {
      dispose: () => {
        if (grp) grp.registrations.delete(grouped);
        if (transforms.delete(entry)) markChanged();
      },
    };
  };

  return { get, transform, reload: markChanged, invalidate, revision: () => rev };
}

export function createKeyedDomainState<TItem extends { readonly id: string }>(
  name: string,
): StateInstance<readonly TItem[], DomainEditor<TItem>> {
  return createState<TItem[], DomainEditor<TItem>>({
    name,
    initial: () => [],
    editor: (draft) => ({
      list: () => [...draft],
      get: (id) => draft.find((item) => item.id === id),
      add: (item) => {
        const idx = draft.findIndex((existing) => existing.id === item.id);
        if (idx >= 0) draft[idx] = item;
        else draft.push(item);
      },
      update: (id, fn) => {
        const target = draft.find((item) => item.id === id);
        if (target) fn(target);
      },
      remove: (id) => {
        const idx = draft.findIndex((item) => item.id === id);
        if (idx >= 0) draft.splice(idx, 1);
      },
    }),
  });
}

export const State = {
  create: createState,
  createKeyedDomain: createKeyedDomainState,
  batch,
  group: withGroup,
  groupAsync: withGroupAsync,
  detachGroup,
};
