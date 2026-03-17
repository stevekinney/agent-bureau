export interface NormalizedError {
  code?: string;
  message: string;
  stack?: string;
}

export function normalizeError(
  error: unknown,
  override?: Partial<NormalizedError>,
): NormalizedError {
  const base: NormalizedError = {
    message: 'Unknown error',
  };
  if (error instanceof Error) {
    base.message = error.message;
    if (error.stack) {
      base.stack = error.stack;
    }
    // Some environments set name to useful codes
    if (error.name && error.name !== 'Error') base.code = error.name;
  } else if (typeof error === 'string') {
    base.message = error;
  } else {
    try {
      base.message = JSON.stringify(error);
    } catch {
      base.message = String(error);
    }
  }
  return { ...base, ...override };
}

export function errorString(err: NormalizedError): string {
  return err.code ? `${err.code}: ${err.message}` : err.message;
}
