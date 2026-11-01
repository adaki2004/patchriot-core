import { useEffect, useRef } from 'react';

/** Open after mounting; restore the opener when React removes the dialog. */
export function useDialog(initialFocus?: string) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    // React's autoFocus runs while the dialog is still hidden.
    if (initialFocus) dialog.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return ref;
}
