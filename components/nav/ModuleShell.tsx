"use client";

import type { ReactNode } from "react";
import { AppChrome } from "@/components/nav/AppChrome";
import type { NavModule } from "@/components/nav/navConfig";

/**
 * Module chrome for /orm, /gmb, /admin, /account layouts.
 * Auth comes from AuthNavProvider (root) — does not re-fetch on each page.
 */
export function ModuleShell({
  module,
  children,
  title,
  breadcrumbs,
}: {
  module: Exclude<NavModule, "none">;
  children: ReactNode;
  title?: string;
  breadcrumbs?: ReactNode;
}) {
  return (
    <AppChrome module={module} title={title} breadcrumbs={breadcrumbs}>
      {children}
    </AppChrome>
  );
}
