import type { ReactNode } from "react";
import { ModuleShell } from "@/components/nav/ModuleShell";

export default function OrmLayout({ children }: { children: ReactNode }) {
  return <ModuleShell module="orm">{children}</ModuleShell>;
}
