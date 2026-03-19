export class ElicitationDeniedError extends Error {
  override name = 'ElicitationDeniedError';
}

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}
