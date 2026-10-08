import "server-only";

/**
 * Lecteur JSON STRICT pour les corps du portefeuille. Différences avec JSON.parse :
 *  - une clé en double, à n'importe quel niveau, est refusée (JSON.parse garde silencieusement la dernière) ;
 *  - la clé « __proto__ » est refusée, y compris écrite avec des échappements ;
 *  - un nombre doit être un ENTIER sûr (pas de fraction, pas d'exposant, pas de « -0 », pas au-delà de 2^53 - 1) : aucun
 *    flottant n'entre jamais dans un montant ;
 *  - profondeur limitée ; contenu après la valeur refusé.
 * Les objets produits n'ont pas de prototype (Object.create(null)).
 */

export type StrictJsonReason =
  | "syntax"
  | "trailing_content"
  | "duplicate_key"
  | "forbidden_key"
  | "non_integer_number"
  | "unsafe_integer"
  | "too_deep";

export class StrictJsonError extends Error {
  readonly reason: StrictJsonReason;

  constructor(reason: StrictJsonReason) {
    super(`JSON refusé : ${reason}`);
    this.name = "StrictJsonError";
    this.reason = reason;
  }
}

export const STRICT_JSON_MAX_DEPTH = 8;
/** Profondeur admise pour la charge d'un prestataire (lot PAY1). */
export const PROVIDER_JSON_MAX_DEPTH = 16;

export interface StrictJsonOptions {
  /**
   * Charge d'un PRESTATAIRE de paiement (webhook, réponses de l'API : lot PAY1), dont on ne maîtrise pas le contenu : les nombres à virgule ou à exposant et les entiers au-delà de
   * 2^53 − 1 sont lus comme des nombres JavaScript (un champ de frais ou d'horodatage ne fait pas refuser tout le message). Les MONTANTS restent exacts : ils sont relus par
   * `readAmount`, qui n'accepte qu'un entier sûr. Clés en double, `__proto__` et contenu après la valeur restent REFUSÉS.
   */
  providerPayload?: boolean;
}

const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;

class Reader {
  private index = 0;

  private readonly maxDepth: number;
  private readonly providerPayload: boolean;

  constructor(private readonly text: string, options: StrictJsonOptions = {}) {
    this.providerPayload = options.providerPayload === true;
    this.maxDepth = this.providerPayload ? PROVIDER_JSON_MAX_DEPTH : STRICT_JSON_MAX_DEPTH;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new StrictJsonError("trailing_content");
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") return;
      this.index += 1;
    }
  }

  private readValue(depth: number): unknown {
    const char = this.text[this.index];
    if (char === "{") return this.readObject(depth + 1);
    if (char === "[") return this.readArray(depth + 1);
    if (char === '"') return this.readString();
    if (char === "-" || (char >= "0" && char <= "9")) return this.readNumber();
    if (this.text.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.text.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.text.startsWith("null", this.index)) { this.index += 4; return null; }
    throw new StrictJsonError("syntax");
  }

  private readObject(depth: number): Record<string, unknown> {
    if (depth > this.maxDepth) throw new StrictJsonError("too_deep");
    this.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    this.skipWhitespace();
    if (this.text[this.index] === "}") { this.index += 1; return result; }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') throw new StrictJsonError("syntax");
      const key = this.readString();
      if (key === "__proto__") throw new StrictJsonError("forbidden_key");
      if (Object.prototype.hasOwnProperty.call(result, key)) throw new StrictJsonError("duplicate_key");
      this.skipWhitespace();
      if (this.text[this.index] !== ":") throw new StrictJsonError("syntax");
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.readValue(depth);
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === ",") continue;
      if (separator === "}") return result;
      throw new StrictJsonError("syntax");
    }
  }

  private readArray(depth: number): unknown[] {
    if (depth > this.maxDepth) throw new StrictJsonError("too_deep");
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") { this.index += 1; return result; }
    for (;;) {
      this.skipWhitespace();
      result.push(this.readValue(depth));
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === ",") continue;
      if (separator === "]") return result;
      throw new StrictJsonError("syntax");
    }
  }

  private readString(): string {
    this.index += 1;
    let result = "";
    for (;;) {
      if (this.index >= this.text.length) throw new StrictJsonError("syntax");
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) { this.index += 1; return result; }
      if (code < 0x20) throw new StrictJsonError("syntax");
      if (code !== 0x5c) { result += this.text[this.index]; this.index += 1; continue; }
      const escape = this.text[this.index + 1];
      this.index += 2;
      switch (escape) {
        case '"': result += '"'; break;
        case "\\": result += "\\"; break;
        case "/": result += "/"; break;
        case "b": result += "\b"; break;
        case "f": result += "\f"; break;
        case "n": result += "\n"; break;
        case "r": result += "\r"; break;
        case "t": result += "\t"; break;
        case "u": {
          const digits = this.text.slice(this.index, this.index + 4);
          if (!HEX4.test(digits)) throw new StrictJsonError("syntax");
          result += String.fromCharCode(parseInt(digits, 16));
          this.index += 4;
          break;
        }
        default: throw new StrictJsonError("syntax");
      }
    }
  }

  private readNumber(): number {
    NUMBER_PATTERN.lastIndex = this.index;
    const match = NUMBER_PATTERN.exec(this.text);
    if (!match) throw new StrictJsonError("syntax");
    const literal = match[0];
    this.index += literal.length;
    if (this.providerPayload) {
      const loose = Number(literal);
      if (!Number.isFinite(loose)) throw new StrictJsonError("unsafe_integer");
      return loose;
    }
    if (/[.eE]/.test(literal)) throw new StrictJsonError("non_integer_number");
    if (literal === "-0") throw new StrictJsonError("non_integer_number");
    const value = Number(literal);
    if (!Number.isSafeInteger(value)) throw new StrictJsonError("unsafe_integer");
    return value;
  }
}

export function parseStrictJson(text: string, options: StrictJsonOptions = {}): unknown {
  return new Reader(text, options).parse();
}
