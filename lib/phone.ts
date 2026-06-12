/**
 * Normalize messy CSV phone values to E.164.
 * Handles: "+46 8 703 25 60", "08-703 25 60" (SE), "587-859-6888" (NA), "0046...".
 * Returns null when the value can't be made into a plausible E.164 number.
 */
export function toE164(raw: string | null | undefined, defaultCountry: "SE" | "NA" = "SE"): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s\-().·]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) {
    const digits = s.slice(1);
    if (!/^\d{7,15}$/.test(digits)) return null;
    return "+" + digits;
  }
  if (!/^\d+$/.test(s)) return null;
  if (defaultCountry === "SE") {
    // Swedish national format: drop leading 0, prefix +46
    if (s.startsWith("0")) s = s.slice(1);
    if (s.length < 7 || s.length > 10) return null;
    return "+46" + s;
  }
  // North America: 10 digits → +1
  if (s.length === 10) return "+1" + s;
  if (s.length === 11 && s.startsWith("1")) return "+" + s;
  return null;
}
