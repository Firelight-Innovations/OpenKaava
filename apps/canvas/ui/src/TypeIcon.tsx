import {
  Box,
  Cog,
  Gamepad2,
  Image as ImageIcon,
  Layers,
  type LucideIcon,
  Map as MapIcon,
  Monitor,
  Music,
  Shapes,
  Star,
  StickyNote,
  User,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  shapes: Shapes,
  box: Box,
  layers: Layers,
  gamepad: Gamepad2,
  cog: Cog,
  note: StickyNote,
  star: Star,
  user: User,
  map: MapIcon,
  image: ImageIcon,
  music: Music,
  monitor: Monitor,
};

/** A type's icon in its colour; an unknown name falls back to a generic shape. */
export default function TypeIcon({
  icon,
  color,
  size = 14,
}: {
  icon: string;
  color: string;
  size?: number;
}) {
  const Icon = ICONS[icon] ?? Shapes;
  return <Icon size={size} color={color} aria-hidden />;
}
