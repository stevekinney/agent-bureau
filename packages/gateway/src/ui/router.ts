export interface Route {
  pattern: string;
  name: string;
}

export const routes: Route[] = [
  { pattern: '/dashboard', name: 'dashboard' },
  { pattern: '/runs/:id', name: 'run-detail' },
  { pattern: '/reviews', name: 'reviews' },
  { pattern: '/usage', name: 'usage' },
  { pattern: '/configuration', name: 'configuration' },
  { pattern: '/chat', name: 'chat' },
  { pattern: '/evaluations', name: 'evaluations' },
];

export interface MatchResult {
  name: string;
  params: Record<string, string>;
}

export function matchRoute(pathname: string): MatchResult | undefined {
  for (const route of routes) {
    const match = matchPattern(route.pattern, pathname);
    if (match) {
      return { name: route.name, params: match };
    }
  }
  return undefined;
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);

  if (patternParts.length !== pathParts.length) return undefined;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]!;
    const value = pathParts[i]!;

    if (part.startsWith(':')) {
      params[part.slice(1)] = value;
    } else if (part !== value) {
      return undefined;
    }
  }

  return params;
}
