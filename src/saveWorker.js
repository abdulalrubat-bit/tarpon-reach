/* The save thread.
 *
 * Serialising a universe and running AES over it is a few milliseconds of
 * straight-line CPU. A few milliseconds on the main thread is four dropped
 * frames, and autosave fires during play — which means it fires during the
 * fight, which is precisely when a stutter is unforgivable. So it happens
 * here, on its own core, and the game does not wait for the answer.
 *
 * This file must never import anything from the game. It receives a plain
 * object, returns a string, and knows nothing else — which is also why
 * ShipState is flat data with no methods: a state with behaviour attached
 * cannot be structured-cloned to this thread at all.
 */
/* global CryptoJS, importScripts */
importScripts('../vendor/crypto-js.min.js');

/* The key is in the source, and anyone determined enough to open devtools can
 * read it. That is not what this is for. It stops a save file being edited in
 * a text editor to grant a few million credits, which is the tampering that
 * actually happens; it is obfuscation with a good algorithm behind it, not
 * security, and calling it security would be a lie the next person maintaining
 * this would believe. A single-player game with no server has nothing better
 * available — the device holds both the lock and the key.
 */
const KEY = 'se:tarpon-reach:v1:6f2a91c4';

self.onmessage = function (e) {
  const msg = e.data || {};
  try {
    if (msg.type === 'pack') {
      const json = JSON.stringify(msg.payload);
      const cipher = CryptoJS.AES.encrypt(json, KEY).toString();
      self.postMessage({ type: 'packed', id: msg.id, blob: cipher, bytes: json.length });
    } else if (msg.type === 'unpack') {
      const bytes = CryptoJS.AES.decrypt(msg.blob, KEY);
      const json = bytes.toString(CryptoJS.enc.Utf8);
      if (!json) throw new Error('save did not decrypt — wrong key or corrupt file');
      self.postMessage({ type: 'unpacked', id: msg.id, payload: JSON.parse(json) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
};
