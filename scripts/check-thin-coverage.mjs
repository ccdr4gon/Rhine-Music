import test from 'node:test';
import assert from 'node:assert/strict';
import { thinCoverage } from '../src/thin-coverage.ts';

function close(actual, expected, tolerance, description) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${description}: ${actual} vs ${expected}, tolerance ${tolerance}`);
}

function continuousMass(width, radius) {
  const limit = width / 2 + radius;
  const count = 65536;
  const step = 2 * limit / count;
  let total = 0;
  for (let index = 0; index < count; index++) {
    total += thinCoverage(-limit + (index + 0.5) * step, width, radius) * step;
  }
  return total;
}

function sampledMass(width, radius, offset) {
  const limit = Math.ceil(width / 2 + radius) + 2;
  let total = 0;
  for (let pixel = -limit; pixel <= limit; pixel++) total += thinCoverage(pixel - offset, width, radius);
  return total;
}

test('integrating the filtered strip retains its actual width, including subpixel widths', () => {
  for (const radius of [0.5, 0.75, 1, 1.5, 2]) {
    for (const width of [0.001, 0.01, 0.1, 0.4, 1, 2.25, 7]) {
      close(continuousMass(width, radius), width, 2e-8 * Math.max(width, 1), `w=${width}, r=${radius}`);
    }
  }
});

test('one-pixel tent support preserves sampled mass under translation on a one-dimensional unit grid', () => {
  let maximumError = 0;
  for (const width of [0.001, 0.01, 0.1, 0.4, 1, 2.25, 7]) {
    for (let frame = 0; frame <= 256; frame++) {
      const mass = sampledMass(width, 1, frame / 256);
      maximumError = Math.max(maximumError, Math.abs(mass - width));
      close(mass, width, 2e-14, `w=${width}, offset=${frame / 256}`);
    }
  }
  console.log(`1D unit grid, r=1: maximum measured mass error ${maximumError}`);
});

test('other filter radii do not inherit the unit-grid mass guarantee', () => {
  const width = 0.1;
  for (const radius of [0.75, 1.5]) {
    const masses = Array.from({ length: 257 }, (_, index) => sampledMass(width, radius, index / 256));
    const minimum = Math.min(...masses);
    const maximum = Math.max(...masses);
    console.log(`1D unit grid, w=${width}, r=${radius}: sampled mass ${minimum} .. ${maximum}`);
    assert.ok(maximum - minimum > 0.005, 'this control must expose real translation variation');
    assert.ok(minimum > 0, 'the whole strip does not disappear between samples');
  }
});

function sampledRectangleMass(width, length, angle, offset, radius) {
  const sine = Math.sin(angle), cosine = Math.cos(angle);
  let sum = 0;
  for (let y = -54; y <= 54; y++) {
    for (let x = -54; x <= 54; x++) {
      const dx = x + 0.5 - offset, dy = y + 0.5;
      const across = dx * cosine + dy * sine;
      const along = -dx * sine + dy * cosine;
      sum += thinCoverage(across, width, radius) * thinCoverage(along, length, radius);
    }
  }
  return sum;
}

test('direction-aware support reduces diagonal phase variation without claiming exact 2D integration', () => {
  const width = 0.2, length = 100;
  const ranges = [];
  for (const degrees of [0, 15, 45, 80]) {
    const angle = degrees * Math.PI / 180;
    const radius = Math.abs(Math.sin(angle)) + Math.abs(Math.cos(angle));
    const ratios = Array.from({ length: 24 }, (_, index) => sampledRectangleMass(width, length, angle, index / 23, radius) / (width * length));
    const minimum = Math.min(...ratios), maximum = Math.max(...ratios);
    ranges.push({ degrees, minimum, maximum, variation: maximum - minimum });
    console.log(`2D finite rectangle, w=.2, L=100, angle=${degrees}, r=${radius}: mass ratio ${minimum} .. ${maximum}`);
    assert.ok(minimum > 0.98 && maximum < 1.02, 'representative orientations stay close to true area');
  }
  const diagonalUncorrected = Array.from({ length: 24 }, (_, index) => sampledRectangleMass(width, length, Math.PI / 4, index / 23, 1) / (width * length));
  const uncorrectedVariation = Math.max(...diagonalUncorrected) - Math.min(...diagonalUncorrected);
  assert.ok(ranges[2].variation < uncorrectedVariation / 10, '45-degree variation is reduced rather than hidden by a loose tolerance');
  assert.ok(ranges[1].variation > 1e-7, 'general orientations still have a nonzero sampled mass error');
  // Matching projected support does not make a single tent equal to the
  // projection of a separable 2D tent: at 45 degrees its variance is 1/3,
  // while that exact projection has variance 1/6. It is a softer approximation.
  close((Math.SQRT2 ** 2) / 6, 1 / 3, 1e-15, 'single-tent diagonal variance');
});

test('coverage is symmetric, bounded and monotone in distance and width without an opacity floor', () => {
  for (const radius of [0.5, 1, 2]) {
    for (const width of [0.00001, 0.1, 0.4, 1, 4]) {
      let previous = 1;
      for (let index = 0; index <= 256; index++) {
        const distance = index / 256 * (width / 2 + radius + 0.1);
        const coverage = thinCoverage(distance, width, radius);
        assert.ok(coverage >= 0 && coverage <= 1);
        close(coverage, thinCoverage(-distance, width, radius), 0, 'mirror');
        assert.ok(coverage <= previous + 1e-14, 'coverage falls with distance');
        previous = coverage;
      }
    }
    for (const distance of [0, 0.2, 0.5, 1, 2]) {
      let previous = 0;
      for (let index = 0; index <= 256; index++) {
        const coverage = thinCoverage(distance, index / 64, radius);
        assert.ok(coverage >= previous - 1e-14, 'coverage grows with true width');
        previous = coverage;
      }
    }
  }
  for (const width of [1e-9, 1e-6, 0.001, 0.1]) {
    close(thinCoverage(0, width), width - width * width / 4, 1e-16, 'center tent integral');
    close(thinCoverage(0.5, width), 0.5 * width, width * 1e-14, 'small strip within linear kernel');
  }
  assert.equal(thinCoverage(0, 4), 1, 'large strips retain an opaque interior');
  assert.equal(thinCoverage(2, 1), 0, 'finite filter support');
});

test('invalid widths, radii and non-finite arguments produce zero coverage', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(thinCoverage(invalid, 0.1), 0);
    assert.equal(thinCoverage(0, invalid), 0);
    assert.equal(thinCoverage(0, 0.1, invalid), 0);
  }
  for (const invalid of [0, -0, -0.1, -100]) {
    assert.equal(thinCoverage(0, invalid), 0);
    assert.equal(thinCoverage(0, 0.1, invalid), 0);
  }
});
