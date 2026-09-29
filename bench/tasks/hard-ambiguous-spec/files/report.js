// Renders the monthly report. Fields:
//   revenue, cost, delta  — money in USD cents
//   growth                — quarter-over-quarter ratio, e.g. 1.073 means +7.3%
export function renderReport(r) {
  return `revenue: ${r.revenue}\ncost: ${r.cost}\ndelta: ${r.revenue - r.cost}\ngrowth: ${r.growth}`;
}
