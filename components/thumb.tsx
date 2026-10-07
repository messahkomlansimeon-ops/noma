import {
  AirVent,
  Car,
  Drill,
  Package,
  Plug,
  Smartphone,
  Sofa,
  type LucideIcon,
} from "lucide-react";
import type { ArtKey } from "@/lib/client/catalog-view";

const artIcon: Record<ArtKey, LucideIcon> = {
  phone: Smartphone,
  sofa: Sofa,
  plug: Plug,
  ac: AirVent,
  drill: Drill,
  car: Car,
  box: Package,
};

export function Thumb({
  art,
  className = "size-14",
  iconClassName = "size-7",
}: {
  art: ArtKey;
  className?: string;
  iconClassName?: string;
}) {
  const Icon = artIcon[art];
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-xl bg-sage ${className}`}
    >
      <Icon className={`text-forest ${iconClassName}`} strokeWidth={1.6} />
    </span>
  );
}
