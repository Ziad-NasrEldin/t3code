/** Clear the west entrance using the original furniture, preserving its geometry and materials. */
export function interiorOffset(variant: string, name: string): number {
  return variant === "prism" && /circular_|review_pedestal|material_model/.test(name) ? 1.5 : 0;
}
