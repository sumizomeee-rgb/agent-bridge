/** Indices refer only to the last displayed list, never a newly reordered list. */
export class NumberedChoiceError extends Error {}
export class NumberedChoices<T> {
  private readonly views = new Map<string, string>();
  remember(scope: string, choices: T[]): void { this.views.set(scope, JSON.stringify(choices)); }
  select(scope: string, index: number, choices: T[]): T {
    if (this.views.get(scope) !== JSON.stringify(choices)) {
      this.views.delete(scope);
      throw new NumberedChoiceError('编号清单未查看或已变化；请重新查看清单后再选择。');
    }
    if (!Number.isSafeInteger(index) || index < 1 || index > choices.length) throw new NumberedChoiceError('编号超出清单范围，请查看清单。');
    return choices[index - 1]!;
  }
}
