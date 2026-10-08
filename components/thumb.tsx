import {
  AirVent,
  Car,
  Drill,
  Laptop,
  Package,
  Smartphone,
  Sofa,
  type LucideIcon,
} from "lucide-react";
import type { ArtKey } from "@/lib/client/catalog-view";
import { PhotoCover } from "@/components/photos/photo-cover";

const artIcon: Record<ArtKey, LucideIcon> = {
  phone: Smartphone,
  sofa: Sofa,
  laptop: Laptop,
  ac: AirVent,
  drill: Drill,
  car: Car,
  box: Package,
};

export function Thumb({
  art,
  className = "size-14",
  iconClassName = "size-7",
  photoId,
}: {
  art: ArtKey;
  className?: string;
  iconClassName?: string;
  /** Lot PH1 : photo de couverture de l'annonce ; l'icône reste le repli (annonce sans photo, ou photo qui ne se charge pas). */
  photoId?: string | null;
}) {
  const Icon = artIcon[art];
  const icon = (
    <span
      className={`flex shrink-0 items-center justify-center rounded-xl bg-sage ${className}`}
    >
      <Icon className={`text-forest ${iconClassName}`} strokeWidth={1.6} />
    </span>
  );
  return photoId ? <PhotoCover photoId={photoId} className={className} fallback={icon} /> : icon;
}
