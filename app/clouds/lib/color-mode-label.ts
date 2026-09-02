/**
 * The one home for the color-mode label-prefix rule.
 *
 * Color-mode labels in public/data/clouds/manifest.json may name their family
 * before the mode itself, as "Ground truth — top". Surfaces that already say
 * which family they are showing (the control panel groups by family, the hover
 * tooltip has a "Ground truth" and a "Predictions" heading) strip that prefix so
 * the family is not printed twice. Surfaces that stand alone — the legend and
 * the metrics panel — deliberately show the label whole and must not call this.
 *
 * DANGER: two copies of this rule existed before (an inline regex in
 * control-panel.tsx that stripped both families, and a stripPredictionLabel
 * helper in point-hover-tooltip.tsx that stripped only "Predictions"), and they
 * drifted. Add call sites here rather than a second regex anywhere else.
 *
 * The separator is a literal " — " (space, em dash, space) because that is the
 * exact spelling used in the manifest; nothing writes any other spacing.
 */
const FAMILY_PREFIX = /^(?:Ground truth|Predictions?) — /;

export function stripColorModeFamilyPrefix(label: string): string {
  return label.replace(FAMILY_PREFIX, "");
}
