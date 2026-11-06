import type { ReactNode } from "react";
import { ModuleShell } from "@/components/nav/ModuleShell";

export default function GmbLayout({ children }: { children: ReactNode }) {
  return <ModuleShell module="gmb">{children}</ModuleShell>;
}
