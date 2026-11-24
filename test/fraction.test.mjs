import test from 'node:test';
import assert from 'node:assert/strict';
import { Fraction } from '../js/fractions.js';

test('Fraction uses exact BigInt normalization and comparison', () => {
  assert.equal(new Fraction(2n, 4n).toString(), '1/2');
  assert.ok(new Fraction(1n, 3n).eq(new Fraction(2n, 6n)));
  assert.ok(new Fraction(1n, 3n).lt(new Fraction(333333333333n, 1000000000000n)) === false);
  assert.ok(new Fraction(1n, 3n).gt(new Fraction(333333333333333333333333333333n, 1000000000000000000000000000000n)));
  assert.equal(new Fraction(1, 3).add(new Fraction(1, 6)).toString(), '1/2');
  assert.equal(new Fraction(2, 7).mul(new Fraction(3, 13)).toString(), '6/91');
  assert.throws(() => new Fraction(1, 0));
});
