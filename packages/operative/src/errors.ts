export class ElicitationDeniedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'ElicitationDeniedError';
  }
}

export class BudgetExceededError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}
