import { sparklineGeometry } from "@/lib/client/market-view";
import type { MarketTrendPoint } from "@/lib/client/market-api";

/**
 * Mini-courbe SVG faite main (lot H1) : aucune bibliothèque. Le tracé vient de `sparklineGeometry` (fonction pure testée) ; sans au moins deux semaines de données, rien
 * n'est dessiné. Le texte alternatif dit la tendance (`label`), la courbe n'est jamais la seule source d'information.
 */
export function Sparkline({ trend, label, width = 220, height = 48, testId }: { trend: readonly MarketTrendPoint[]; label: string; width?: number; height?: number; testId?: string }) {
  const geometry = sparklineGeometry(trend, width, height);
  if (geometry.paths.length === 0 && geometry.points.length < 2) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      data-testid={testId}
      data-points={geometry.points.length}
      className="mt-2 block text-forest"
    >
      {geometry.paths.map((path) => (
        <path key={path} d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      ))}
      {geometry.points.map((point) => (
        <circle key={`${point.x}:${point.y}`} cx={point.x} cy={point.y} r="2" fill="currentColor" />
      ))}
    </svg>
  );
}
