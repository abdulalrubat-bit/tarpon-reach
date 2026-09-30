/* Physics start-up.
 *
 * The single-file build inlined Ammo's WebAssembly as base64 so it could run
 * as one HTML page. Unpacked, the same bytes live in vendor/ammo/ (verified
 * identical) and enable3d's loader fetches them, which is what the game did
 * before the rebuild and what keeps the offline shell cacheable file by file.
 */
(function (SE) {
  'use strict';
  SE.portablePhysics = function (ready) {
    window.ENABLE3D.PhysicsLoader('vendor/ammo', ready);
  };
})(window.SE = window.SE || {});
