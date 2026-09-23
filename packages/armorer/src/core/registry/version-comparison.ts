export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return 0;
  return (
    compareCoreSemver(parsedA, parsedB) ||
    comparePrereleaseState(parsedA.prerelease, parsedB.prerelease)
  );
}

type ParsedSemver = { major: number; minor: number; patch: number; prerelease?: string };

function compareCoreSemver(a: ParsedSemver, b: ParsedSemver): number {
  return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
}

function comparePrereleaseState(a: string | undefined, b: string | undefined): number {
  if (!a && b) return -1;
  if (a && !b) return 1;
  if (!a || !b) return 0;
  return comparePrerelease(a, b);
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
  };
}

export function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const diff = comparePrereleasePart(aParts[i], bParts[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function comparePrereleasePart(aPart: string | undefined, bPart: string | undefined): number {
  if (aPart === undefined) return -1;
  if (bPart === undefined) return 1;
  const numeric = compareNumericPrereleasePart(aPart, bPart);
  return numeric ?? bPart.localeCompare(aPart);
}

function compareNumericPrereleasePart(aPart: string, bPart: string): number | undefined {
  const aNum = Number(aPart);
  const bNum = Number(bPart);
  const aIsNum = !Number.isNaN(aNum) && aPart.trim() !== '';
  const bIsNum = !Number.isNaN(bNum) && bPart.trim() !== '';
  if (aIsNum && bIsNum) return aNum === bNum ? 0 : bNum - aNum;
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return aPart === bPart ? 0 : undefined;
}
