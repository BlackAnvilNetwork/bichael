/** Character names: one visible form, one comparison key. */

const EXTRA_INVISIBLE = /[\u115F\u1160\u180E\u2800\u3164\uFFA0]/g;

/**
 * Legacy comparison only. New names are rejected unless they are ASCII letters,
 * digits, and single spaces, so this partial table is not the lookalike defense.
 */
const CONFUSABLE: Record<string, string> = {
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0455": "s",
  "\u0456": "i",
  "\u0458": "j",
  "\u04bb": "h",
  "\u0501": "d",
  "\u051b": "q",
  "\u051d": "w",
  "\u03b1": "a",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bd": "v",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u0131": "i",
  "\u0261": "g",
  "\u2170": "i",
  "\u217c": "l",
};

function cleanDisplay(raw: string): string {
  const stripped = raw
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Cc}\p{Mn}\p{Me}]/gu, "")
    .replace(EXTRA_INVISIBLE, "");
  return stripped.replace(/[\s\p{Z}]+/gu, " ").trim();
}

/** Comparison key. Empty when nothing visible remains. Not a display name. */
export function characterNameKey(raw: string): string {
  const display = cleanDisplay(raw);
  if (!display) return "";
  const folded = display.toLowerCase().replace(/\u00df/g, "ss");
  let mapped = "";
  for (const ch of folded) mapped += CONFUSABLE[ch] ?? ch;
  return mapped.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").replace(/[\s\p{Z}]+/gu, " ").trim();
}

export function normalizeCharacterName(
  raw: string,
): { ok: true; name: string; key: string } | { ok: false; error: string } {
  const name = cleanDisplay(raw);
  if (!name) return { ok: false, error: "Name a character. Blank names are not allowed." };
  const length = [...name].length;
  if (length < 2 || length > 16) {
    return { ok: false, error: "Character names must be 2\u201316 characters." };
  }
  if (!/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(name)) {
    return { ok: false, error: "Character names use letters, digits, and single spaces." };
  }
  const key = characterNameKey(name);
  if (!key) return { ok: false, error: "Name a character. Blank names are not allowed." };
  return { ok: true, name, key };
}
