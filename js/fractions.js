// Exact rational arithmetic backed by BigInt.
// No election elimination decision may use JavaScript floating point.

const ZERO = 0n;
const ONE = 1n;

function absBigInt(x) {
  return x < ZERO ? -x : x;
}

function gcdBigInt(a, b) {
  a = absBigInt(a);
  b = absBigInt(b);
  while (b !== ZERO) {
    [a, b] = [b, a % b];
  }
  return a;
}

export class Fraction {
  constructor(n = 0n, d = ONE) {
    let numerator;
    let denominator;

    if (n instanceof Fraction) {
      numerator = n.n;
      denominator = n.d;
    } else if (typeof n === 'bigint') {
      numerator = n;
      denominator = BigInt(d ?? ONE);
    } else if (typeof n === 'number') {
      if (!Number.isInteger(n)) {
        throw new TypeError(`Fraction number argument must be an integer, got ${n}`);
      }
      numerator = BigInt(n);
      denominator = BigInt(d ?? 1);
    } else if (typeof n === 'string') {
      const parsed = Fraction.parse(n);
      numerator = parsed.n;
      denominator = parsed.d;
    } else {
      throw new TypeError(`Unsupported Fraction argument: ${String(n)}`);
    }

    if (typeof denominator !== 'bigint') denominator = BigInt(denominator);
    if (denominator === ZERO) throw new RangeError('Fraction denominator cannot be zero');
    if (denominator < ZERO) {
      numerator = -numerator;
      denominator = -denominator;
    }

    const g = gcdBigInt(numerator, denominator) || ONE;
    this.n = numerator / g;
    this.d = denominator / g;
    Object.freeze(this);
  }

  static parse(value) {
    if (value instanceof Fraction) return { n: value.n, d: value.d };
    const text = String(value).trim();
    if (/^[+-]?\d+n?$/.test(text)) {
      return { n: BigInt(text.replace('n', '')), d: ONE };
    }
    const match = text.match(/^([+-]?\d+)\s*\/\s*(\d+)$/);
    if (!match) throw new TypeError(`Invalid exact fraction: ${value}`);
    return { n: BigInt(match[1]), d: BigInt(match[2]) };
  }

  static from(value) {
    if (value instanceof Fraction) return value;
    if (value && typeof value === 'object' && 'n' in value && 'd' in value) {
      return new Fraction(BigInt(value.n), BigInt(value.d));
    }
    return new Fraction(value);
  }

  static zero() {
    return new Fraction(ZERO, ONE);
  }

  static one() {
    return new Fraction(ONE, ONE);
  }

  add(other) {
    const o = Fraction.from(other);
    return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(other) {
    const o = Fraction.from(other);
    return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(other) {
    const o = Fraction.from(other);
    return new Fraction(this.n * o.n, this.d * o.d);
  }

  div(other) {
    const o = Fraction.from(other);
    if (o.n === ZERO) throw new RangeError('Division by zero Fraction');
    return new Fraction(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Fraction(-this.n, this.d);
  }

  cmp(other) {
    const o = Fraction.from(other);
    const left = this.n * o.d;
    const right = o.n * this.d;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  eq(other) {
    return this.cmp(other) === 0;
  }

  lt(other) {
    return this.cmp(other) < 0;
  }

  lte(other) {
    return this.cmp(other) <= 0;
  }

  gt(other) {
    return this.cmp(other) > 0;
  }

  gte(other) {
    return this.cmp(other) >= 0;
  }

  isZero() {
    return this.n === ZERO;
  }

  /** Decimal string is for display only; decisions must use cmp/eq exact values. */
  toDecimal(digits = 6) {
    const negative = this.n < ZERO;
    const n = absBigInt(this.n);
    const scale = 10n ** BigInt(digits);
    const scaled = (n * scale) / this.d;
    const whole = scaled / scale;
    const frac = scaled % scale;
    const fracText = frac.toString().padStart(digits, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toString()}${fracText ? '.' + fracText : ''}`;
  }

  toString() {
    return this.d === ONE ? this.n.toString() : `${this.n.toString()}/${this.d.toString()}`;
  }

  toJSON() {
    return { $f: this.toString() };
  }
}

export const fzero = Fraction.zero();
export const fone = Fraction.one();

export function maxFraction(values) {
  return values.reduce((a, b) => (a.cmp(b) >= 0 ? a : b), Fraction.zero());
}

export function minFraction(values) {
  return values.reduce((a, b) => (a.cmp(b) <= 0 ? a : b), values[0] ?? Fraction.zero());
}

export function sumFractions(values) {
  return values.reduce((acc, value) => acc.add(Fraction.from(value)), Fraction.zero());
}
