/**
 * Caesar cipher helpers used by the Source and Execute scenes' input
 * widgets. The presentation is locked to shift = 3 (so encryption and
 * decryption are exact inverses with the THCC program built by
 * `buildCaesarSource`).
 *
 * Allowed input alphabet is uppercase A-Z and space. Lowercase letters
 * are uppercased; everything else is dropped silently.
 */

export const CAESAR_SHIFT = 3;

const A_CODE = 65;
const Z_CODE = 90;
const a_CODE = 97;
const z_CODE = 122;
const SPACE = 32;

/** Sanitise free-form input to the Caesar alphabet (A-Z and space). */
export function normaliseCaesar(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= A_CODE && c <= Z_CODE) out.push(ch);
    else if (c >= a_CODE && c <= z_CODE) out.push(String.fromCharCode(c - 32));
    else if (c === SPACE) out.push(" ");
  }
  return out.join("");
}

export function encryptCaesar(plain: string, shift = CAESAR_SHIFT): string {
  const out: string[] = [];
  for (const ch of normaliseCaesar(plain)) {
    const c = ch.charCodeAt(0);
    if (c === SPACE) {
      out.push(" ");
    } else {
      const shifted = ((c - A_CODE + shift) % 26 + 26) % 26 + A_CODE;
      out.push(String.fromCharCode(shifted));
    }
  }
  return out.join("");
}

export function decryptCaesar(cipher: string, shift = CAESAR_SHIFT): string {
  return encryptCaesar(cipher, 26 - (shift % 26));
}

/**
 * Build a complete THCC program that decrypts the given ciphertext on
 * THMM. The ciphertext is normalised (uppercase + spaces only) before the
 * bytes are baked in, so the same source we generate is always one the
 * compiler accepts.
 */
export function buildCaesarSource(cipher: string): string {
  const text = normaliseCaesar(cipher);
  const bytes = [...text].map(ch => ch.charCodeAt(0));

  const charLine = (i: number, byte: number) => {
    const ch = String.fromCharCode(byte);
    const label = ch === " " ? "_" : ch;
    // Variable names are unpadded (c0..cN-1) so they match the rest of
    // the codebase's expectations (varMap lookups, output panel patterns).
    const lhs = `int c${i}`.padEnd(8);
    return `${lhs}= ${pad3(byte)};   // ${label}`;
  };

  const decryptLine = (i: number, byte: number) => {
    if (byte === SPACE) {
      return `int p${i} = c${i};`;
    }
    return `int t${i} = c${i} - OFFSET; int p${i} = t${i} - t${i} / N * N + A;`;
  };

  const charLines = bytes.map((b, i) => charLine(i, b)).join("\n");
  const decryptLines = bytes.map((b, i) => decryptLine(i, b)).join("\n");

  return `// Caesar cipher decryption — shift 3.
// Encrypted "${text}" decrypts to "${decryptCaesar(text)}".
//
// THMM has no mod operator and no conditionals, so:
//   plain = (cipher - OFFSET) - (cipher - OFFSET) / 26 * 26 + 65
// where OFFSET = 'A' + shift - 26 = 65 + 3 - 26 = 42.
// Spaces pass through unchanged.

int A = 65;
int N = 26;
int OFFSET = 42;

${charLines}

${decryptLines}
`;
}

function pad3(n: number): string {
  return n.toString().padStart(3, " ");
}
