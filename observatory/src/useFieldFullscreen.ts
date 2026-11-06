import { useCallback, useEffect, useRef, useState } from "react";

/** Keep the layout in sync with native fullscreen, including browser-owned exits. */
export function useFieldFullscreen() {
  const shellRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const wanted = useRef(false);
  const owned = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const restoreFocus = useCallback(() => {
    requestAnimationFrame(() =>
      buttonRef.current?.focus({ preventScroll: true }),
    );
  }, []);

  const collapse = useCallback(async () => {
    wanted.current = false;
    const request = ++generation.current;
    setPending(false);
    if (document.fullscreenElement === shellRef.current) {
      try {
        await document.exitFullscreen();
      } catch {
        if (!mounted.current || request !== generation.current) return;
        wanted.current = true;
        setExpanded(true);
        setNotice("Use Escape or your browser’s fullscreen control to exit.");
        return;
      }
    }
    if (!mounted.current) return;
    setExpanded(false);
    setNotice("");
    restoreFocus();
  }, [restoreFocus]);

  const expand = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell) return;
    const request = ++generation.current;
    wanted.current = true;
    setExpanded(true);
    setPending(true);
    setNotice("");
    try {
      if (typeof shell.requestFullscreen !== "function") {
        throw new Error("Fullscreen is unavailable");
      }
      // Called directly from the click handler, while user activation is valid.
      await shell.requestFullscreen({ navigationUI: "hide" });
      if (!wanted.current && document.fullscreenElement === shell) {
        await document.exitFullscreen();
      }
    } catch {
      if (mounted.current && wanted.current && request === generation.current) {
        setNotice(
          "Browser fullscreen is unavailable. Expanded within this tab.",
        );
      }
    } finally {
      if (mounted.current && request === generation.current) setPending(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const changed = () => {
      if (document.fullscreenElement === shellRef.current) {
        owned.current = true;
        if (wanted.current) {
          setExpanded(true);
          setNotice("");
        } else {
          void collapse();
        }
      } else if (owned.current) {
        owned.current = false;
        wanted.current = false;
        generation.current++;
        setExpanded(false);
        setPending(false);
        setNotice("");
        restoreFocus();
      }
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      mounted.current = false;
      document.removeEventListener("fullscreenchange", changed);
    };
  }, [collapse, restoreFocus]);

  return { shellRef, buttonRef, expanded, pending, notice, expand, collapse };
}
