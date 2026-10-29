/** Display normalization only: keep the denial and all surrounding restrictions intact. */
export function controllerWorkerReport(report: string): string {
  return report.replace(/\bblocked[ \t]+by[ \t]+policy\b/gi, '');
}

export function mentionsPolicyDenial(report: string): boolean {
  return /\bblocked[ \t]+by[ \t]+policy\b/i.test(report);
}
