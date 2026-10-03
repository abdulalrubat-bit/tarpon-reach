// Tiny assertions with readable failure messages.
export function ok(value, message) { if (!value) throw new Error(message || 'expected a true value'); }
export function eq(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message || 'not equal'}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
