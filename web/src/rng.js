/* Seeded randomness.
 *
 * Every asteroid position, faction patrol and station name in this game comes
 * out of here rather than out of Math.random(). Two reasons, and the second is
 * the one that matters: a seeded universe can be regenerated from twelve bytes
 * in the save file instead of stored, and a bug in a 10,000-rock belt can be
 * reproduced by typing the seed back in.
 */
(function (SE) {
  'use strict';

  // mulberry32 — small, fast, good enough for scenery, and the same three
  // lines on every platform. Not for anything that needs to resist guessing.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Hash a string into a 32-bit seed, so a sector can be seeded by its own id
  // and stay identical no matter what order sectors were generated in.
  function hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function Rng(seed) {
    const next = mulberry32(typeof seed === 'string' ? hash(seed) : (seed | 0));
    return {
      next,
      float: (lo, hi) => lo + next() * (hi - lo),
      int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
      pick: arr => arr[Math.floor(next() * arr.length)],
      chance: p => next() < p,
      // Uniform point on a sphere. The naive version (random angles) clumps at
      // the poles, which in a belt reads as two visible knots of rock.
      onSphere: function (r) {
        const u = next() * 2 - 1, th = next() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        return { x: r * s * Math.cos(th), y: r * u, z: r * s * Math.sin(th) };
      }
    };
  }

  SE.Rng = Rng;
  SE.hashSeed = hash;
})(window.SE = window.SE || {});
