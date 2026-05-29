/**
 * Normalise a tag: trim whitespace and lowercase.
 * Matches the inline logic used in add.ts.
 */
export function normaliseTag(tag: string): string {
  return tag.trim().toLowerCase();
}
