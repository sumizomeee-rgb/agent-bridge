/** Display normalization only: keep the denial and all surrounding restrictions intact. */
export function controllerWorkerReport(report: string): string {
  return report.replace(/\bblocked[ \t]+by[ \t]+policy\b/gi, '本次工具调用被拒绝');
}

export function mentionsPolicyDenial(report: string): boolean {
  return /\bblocked[ \t]+by[ \t]+policy\b/i.test(report);
}
