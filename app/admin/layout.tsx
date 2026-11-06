import type { ReactNode } from "react";
import { ModuleShell } from "@/components/nav/ModuleShell";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <ModuleShell module="admin">{children}</ModuleShell>;
}
