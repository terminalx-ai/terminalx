import { Smartphone } from "@/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConnectedDevices, useConnectedDevices } from "./ConnectedDevices";

/** Access to live phone connections in windows and views without the local Device dock. */
export function DeviceStatus() {
  const connected = useConnectedDevices();
  const count = connected.devices.length;
  if (count === 0) return null;

  return (
    <div className="flex h-[22px] shrink-0 items-center justify-end border-t border-hairline bg-background/70 px-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-[19px] items-center gap-1 rounded px-1.5 text-[11px] leading-none text-add outline-none hover:bg-veil-raised focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`Device · ${count} connected ${count === 1 ? "phone" : "phones"}`}
          >
            <Smartphone className="size-3.5" aria-hidden />
            {`Device · ${count}`}
          </button>
        </PopoverTrigger>
        <PopoverContent label="Device" side="top" align="end">
          <ConnectedDevices {...connected} className="p-0" />
        </PopoverContent>
      </Popover>
    </div>
  );
}
