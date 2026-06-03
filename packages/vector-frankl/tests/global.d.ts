declare global {
  interface Window {
    db: any;
    log: (message: string, level?: string) => void;
    addTestResult: (test: string, status: string, details?: string) => void;
  }
}

export {};
