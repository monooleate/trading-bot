// Generic confirmation modal — used by TraderShell to gate destructive
// Reset, but reusable anywhere a "type the magic word to proceed" dialog
// makes sense.
//
// Why type-to-confirm and not a checkbox: a checkbox can be defeated by
// muscle-memory (click-click-OK). Forcing the operator to type the verb
// they're about to perform breaks the autopilot reliably — it's the same
// pattern GitHub / Vercel use for repo deletes for the same reason.

import { useEffect, useRef, useState } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Primary explanation paragraph. */
  body: string;
  /** Optional ordered list of bullet points (e.g. session summary). */
  details?: string[];
  /** Word the user must type to enable the confirm button. Case sensitive. */
  confirmWord: string;
  confirmLabel: string;
  /** Optional checkbox row above the typed-confirmation. */
  checkbox?: { label: string; checked: boolean; onChange: (v: boolean) => void };
  cancelLabel?: string;
  /** Visual tone — danger for destructive operations. */
  tone?: "danger" | "warn";
  /** Disable the entire UI while the parent runs the action. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  body,
  details,
  confirmWord,
  confirmLabel,
  checkbox,
  cancelLabel = "Mégse",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset typed text whenever the dialog opens/closes — defence against
  // a stale entry from a previous accidental open.
  useEffect(() => {
    if (open) {
      setTyped("");
      // Defer focus until after the dialog has mounted in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Esc to cancel — common modal expectation.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const canConfirm = typed === confirmWord && !busy;

  return (
    <div className="cd-backdrop" onClick={() => !busy && onCancel()}>
      <div
        className={`cd-modal cd-tone-${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cd-title" className="cd-title">{title}</h3>
        <p className="cd-body">{body}</p>

        {details && details.length > 0 && (
          <ul className="cd-details">
            {/* dangerouslySetInnerHTML on purpose: callers pass an in-app
                template with `<b>` so the session summary can highlight the
                values that are about to be wiped. The strings are built
                in-process — never user-supplied — so XSS isn't in scope. */}
            {details.map((d, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: d }} />
            ))}
          </ul>
        )}

        {checkbox && (
          <label className="cd-checkbox">
            <input
              type="checkbox"
              checked={checkbox.checked}
              onChange={(e) => checkbox.onChange(e.target.checked)}
              disabled={busy}
            />
            <span>{checkbox.label}</span>
          </label>
        )}

        <label className="cd-confirm-label">
          Megerősítéshez gépeld be:&nbsp;
          <code>{confirmWord}</code>
        </label>
        <input
          ref={inputRef}
          className="cd-input"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={confirmWord}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />

        <div className="cd-actions">
          <button
            className="cd-btn cd-btn-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            className={`cd-btn cd-btn-confirm cd-btn-${tone}`}
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {busy ? "Folyamatban…" : confirmLabel}
          </button>
        </div>

        <style>{styles}</style>
      </div>
    </div>
  );
}

const styles = `
.cd-backdrop {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
  animation: cd-fade-in 0.12s ease-out;
}
@keyframes cd-fade-in { from { opacity: 0; } to { opacity: 1; } }

.cd-modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.4rem 1.4rem 1.2rem;
  width: 100%;
  max-width: 460px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.55);
  animation: cd-pop 0.12s ease-out;
}
.cd-tone-danger { border-top: 3px solid var(--danger); }
.cd-tone-warn   { border-top: 3px solid var(--warn); }
@keyframes cd-pop {
  from { transform: scale(0.96); opacity: 0; }
  to   { transform: scale(1);    opacity: 1; }
}

.cd-title {
  font-family: var(--sans); font-size: 1.05rem;
  color: var(--text); margin: 0 0 0.6rem; letter-spacing: -0.01em;
}
.cd-tone-danger .cd-title { color: var(--danger); }
.cd-tone-warn   .cd-title { color: var(--warn); }

.cd-body {
  font-family: var(--mono); font-size: 0.74rem;
  color: var(--text); margin: 0 0 0.8rem;
  line-height: 1.55;
}

.cd-details {
  font-family: var(--mono); font-size: 0.7rem;
  color: var(--muted);
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 4px;
  margin: 0 0 0.9rem;
  padding: 0.55rem 0.75rem 0.55rem 1.6rem;
  list-style-type: "▸  ";
  line-height: 1.7;
}
.cd-details li::marker { color: var(--muted); }
.cd-details li b { color: var(--text); font-weight: 600; }

.cd-checkbox {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--mono); font-size: 0.7rem;
  color: var(--text); margin-bottom: 0.85rem;
  cursor: pointer; user-select: none;
}
.cd-checkbox input { accent-color: var(--accent); cursor: pointer; }

.cd-confirm-label {
  display: block; font-family: var(--mono); font-size: 0.65rem;
  color: var(--muted); margin-bottom: 0.4rem;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.cd-confirm-label code {
  background: var(--surface2); border: 1px solid var(--border);
  padding: 1px 6px; border-radius: 3px;
  color: var(--accent); font-family: var(--mono);
}
.cd-input {
  width: 100%; box-sizing: border-box;
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); font-family: var(--mono); font-size: 0.85rem;
  padding: 0.55rem 0.7rem; border-radius: 4px;
  margin-bottom: 1.2rem; outline: none;
  transition: border-color 0.15s;
}
.cd-input:focus { border-color: var(--accent); }
.cd-input:disabled { opacity: 0.5; cursor: not-allowed; }

.cd-actions {
  display: flex; gap: 0.5rem; justify-content: flex-end;
}
.cd-btn {
  font-family: var(--mono); font-size: 0.72rem;
  padding: 0.55rem 1.2rem; border-radius: 4px;
  cursor: pointer; border: 1px solid var(--border);
  letter-spacing: 0.05em; text-transform: uppercase; font-weight: 600;
  transition: opacity 0.15s, border-color 0.15s, background 0.15s;
}
.cd-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cd-btn-cancel {
  background: var(--surface2); color: var(--text);
}
.cd-btn-cancel:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.cd-btn-confirm.cd-btn-danger {
  background: var(--danger); color: #fff; border-color: var(--danger);
}
.cd-btn-confirm.cd-btn-warn {
  background: var(--warn); color: var(--bg); border-color: var(--warn);
}
.cd-btn-confirm:disabled {
  background: var(--surface2); color: var(--muted); border-color: var(--border);
}
`;
