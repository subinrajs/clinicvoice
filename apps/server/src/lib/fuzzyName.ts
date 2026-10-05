/**
 * Speech-to-text often mangles surnames ("Santos" -> "Santo's", "Tremblay" -> "Trembley").
 * Identity still requires an exact DOB and phone last 4; the surname only needs to be close.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function surnamesMatch(spoken: string, stored: string): boolean {
  const a = normalizeName(spoken);
  const b = normalizeName(stored);
  if (!a || !b) return false;
  if (a === b) return true;
  const allowed = b.length <= 5 ? 1 : 2;
  return levenshtein(a, b) <= allowed;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}
