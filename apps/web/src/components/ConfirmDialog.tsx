'use client';
import { useEffect, useRef, type ReactNode } from 'react';

export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', busy = false, onConfirm, onCancel }: {
  open: boolean; title: string; children: ReactNode; confirmLabel?: string; cancelLabel?: string; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}
      onClick={(e) => { if (e.target === ref.current && !busy) onCancel(); }}
      className="m-auto w-[min(92vw,26rem)] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-black/70 backdrop:backdrop-blur-sm"
      aria-labelledby="confirm-title"
    >
      <div className="p-6">
        <h2 id="confirm-title" className="text-lg font-semibold">{title}</h2>
        <div className="mt-3 text-sm text-muted">{children}</div>
        <div className="mt-6 flex justify-end gap-3">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={busy} autoFocus>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}
