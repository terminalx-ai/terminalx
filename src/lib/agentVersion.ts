/** Compare agent SemVer releases, ignoring build metadata; null means unknown.
 * Accept a leading v as used by release tags, but never coerce malformed versions.
 */
export function compareAgentVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (version: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
    if (!match || match[0] !== version) return null;
    const pre = match[4]?.split(".") ?? [];
    if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
    return { core: match.slice(1, 4).map(BigInt), pre };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (!left.pre.length || !right.pre.length) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const [x, y] = [left.pre[i], right.pre[i]];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
