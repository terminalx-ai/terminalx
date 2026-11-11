import { PrivacyImage } from "@/components/ui/privacy-image";
import { useEffect, useState, type ReactNode } from "react";
import { getName } from "@tauri-apps/api/app";
import appMark from "../../../src-tauri/icons/128x128.png";
import { cn } from "@/lib/cn";

/** Shared first-run, everyday welcome and compact detail-pane layout. */
export function EmptyView({ title, guidance, children, branded = false }: {
  title?: string;
  guidance: string;
  children?: ReactNode;
  branded?: boolean;
}) {
  const [name, setName] = useState("TerminalX");
  useEffect(() => {
    if (branded) void getName().then(setName).catch(() => {});
  }, [branded]);
  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-8">
      <div className={cn("m-auto w-full py-4", branded ? "max-w-2xl" : "max-w-sm")}>
        {branded ? (
          <>
            <PrivacyImage src={appMark} alt="" className="mx-auto mb-4 size-20 rounded-2xl" />
            <h1 className="text-center text-3xl font-bold uppercase tracking-tight">{name}</h1>
          </>
        ) : <h2 className="text-center text-base font-semibold">{title}</h2>}
        <p className="mt-2 text-center text-sm text-muted-foreground">{guidance}</p>
        {children}
      </div>
    </div>
  );
}
