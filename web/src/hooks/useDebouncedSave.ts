import { useEffect, useRef, useState } from "react";

type Status = "saved" | "dirty" | "saving" | "error";

export function useDebouncedSave(
  content: string,
  path: string | null,
  save: (path: string, content: string) => Promise<void>,
  delay = 500,
  // a note the user already switched away from failed to save; `status`
  // only describes the open note, so the caller has to surface this
  onLeftNoteError?: (path: string, err: unknown) => void,
): { status: Status; flush: () => Promise<void>; forget: (path: string | null) => void } {
  const [status, setStatus] = useState<Status>("saved");
  const latest = useRef(content);
  const lastSaved = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const pathRef = useRef<string | null>(path);
  // writes run one at a time, so an older body never lands after a newer one
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef<{ path: string; content: string } | null>(null);
  // note being deleted/renamed: its pending edits must not recreate it
  const forgotten = useRef<string | null>(null);

  function clearTimer() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  function isQueued(p: string, c: string): boolean {
    return queued.current?.path === p && queued.current.content === c;
  }

  function write(p: string, c: string): Promise<void> {
    const entry = { path: p, content: c };
    queued.current = entry;
    const job = queue.current.then(() => save(p, c));
    const settle = () => {
      if (queued.current === entry) queued.current = null;
    };
    queue.current = job.then(settle, settle);
    return job;
  }

  useEffect(() => {
    // path change: the new content is the baseline, not an edit. Write out
    // whatever the previous note still had pending so a quick switch
    // doesn't drop it.
    if (path !== pathRef.current) {
      const prevPath = pathRef.current;
      const prevContent = latest.current;
      clearTimer();
      if (
        prevPath !== null &&
        prevPath !== forgotten.current &&
        prevContent !== lastSaved.current &&
        !isQueued(prevPath, prevContent)
      ) {
        write(prevPath, prevContent).catch((e) => onLeftNoteError?.(prevPath, e));
      }
      forgotten.current = null;
      latest.current = content;
      pathRef.current = path;
      lastSaved.current = content;
      setStatus("saved");
      return;
    }
    latest.current = content;
    if (path === null) return;
    if (lastSaved.current === content) {
      setStatus("saved");
      return;
    }
    setStatus("dirty");
    clearTimer();
    timer.current = window.setTimeout(() => {
      void flushInternal();
    }, delay);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path, delay]);

  async function flushInternal() {
    const p = pathRef.current;
    const c = latest.current;
    if (
      p !== null &&
      p !== forgotten.current &&
      c !== lastSaved.current &&
      !isQueued(p, c)
    ) {
      clearTimer();
      setStatus("saving");
      write(p, c).then(
        () => {
          if (pathRef.current !== p) return;
          lastSaved.current = c;
          if (latest.current === c) setStatus("saved");
        },
        (e) => {
          if (pathRef.current === p) setStatus("error");
          else onLeftNoteError?.(p, e);
        },
      );
    }
    // callers (commit, checkpoint, delete) need every pending write on disk,
    // including one still running for a note the user already left
    await queue.current;
  }

  // the open note is about to be deleted or renamed: drop its pending
  // edits so a late save can't write the old file back. null undoes it
  // (the delete/rename failed).
  function forget(p: string | null) {
    if (p === null) {
      forgotten.current = null;
      return;
    }
    if (pathRef.current !== p) return;
    clearTimer();
    forgotten.current = p;
  }

  return { status, flush: flushInternal, forget };
}
