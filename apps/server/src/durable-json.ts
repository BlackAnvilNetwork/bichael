/**
 * Fail-closed loaders for money-adjacent durable JSON (#258 / #281 / #282).
 * Corrupt files must refuse boot rather than reset to empty and lose retries.
 */
import { existsSync, readFileSync } from "node:fs";

export function loadDurableJsonObject<T extends object>(
  path: string,
  label: string,
): T | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      label + " " + path + " could not be read (" + String(err) + "). Fix or restore it before boot.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(label + " " + path + " is corrupt (expected a JSON object). Fix or restore it before boot.");
  }
  return parsed as T;
}
