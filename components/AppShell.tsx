"use client";

import type { ReactNode } from "react";
import { AppChrome } from "@/components/nav/AppChrome";
import type { NavModule } from "@/components/nav/navConfig";

/**
 * Shared chrome for pages outside dedicated module layouts (billing, etc.).
 * Prefer ModuleShell + layout for workspace routes; pass `module` so secondary
 * nav matches the owning workspace (e.g. ORM tools).
 */
export function AppShell({
  children,
  title,
  module = "none",
}: {
  children: ReactNode;
  title?: string;
  module?: NavModule;
}) {
  return (
    <AppChrome module={module} title={title}>
      {children}
    </AppChrome>
  );
}
