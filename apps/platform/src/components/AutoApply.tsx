"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

/**
 * Put inside a report's GET form: any change re-runs the report at once, as a
 * client-side navigation (the page keeps its layout and scroll), so there is no
 * "Show" button to press. Submit buttons marked `data-apply` stay for people
 * without JavaScript and are hidden once this is running. While the new result
 * loads, a thin bar shows at the top and the form is marked busy.
 */
export function AutoApply() {
  const ref = useRef<HTMLSpanElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    form.dataset.auto = "1";
    const apply = () => {
      // Every field, empty ones included, exactly as the browser would submit
      // the form: repeated fields (property filters) line up by position.
      const q = new URLSearchParams();
      for (const [k, v] of new FormData(form)) if (typeof v === "string") q.append(k, v);
      start(() => router.replace(`${pathname}?${q}`, { scroll: false }));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (e: Event) => {
      const t = e.target as HTMLInputElement;
      // Custom dates wait until both are filled in; typing waits for a pause.
      if (t.type === "date" && !t.value) return;
      clearTimeout(timer);
      timer = setTimeout(apply, t.type === "text" || t.type === "search" ? 350 : 0);
    };
    const onSubmit = (e: SubmitEvent) => {
      e.preventDefault();
      apply();
    };
    form.addEventListener("change", onChange);
    form.addEventListener("submit", onSubmit);
    return () => {
      clearTimeout(timer);
      form.removeEventListener("change", onChange);
      form.removeEventListener("submit", onSubmit);
      delete form.dataset.auto;
    };
  }, [router, pathname]);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (form) form.setAttribute("aria-busy", pending ? "true" : "false");
  }, [pending]);

  return (
    <span ref={ref} hidden={!pending}>
      <span className="fixed inset-x-0 top-0 z-50 block h-0.5 animate-pulse bg-accent" role="progressbar" aria-label="Updating report" />
    </span>
  );
}
