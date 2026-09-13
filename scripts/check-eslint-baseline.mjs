import { readFileSync } from 'node:fs';

const reportPath = process.argv[2];
const maxErrors = Number(process.argv[3]);
const maxWarnings = Number(process.argv[4]);

if (!reportPath || !Number.isInteger(maxErrors) || !Number.isInteger(maxWarnings)) {
  console.error(
    'Usage: node scripts/check-eslint-baseline.mjs REPORT MAX_ERRORS MAX_WARNINGS',
  );
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const totals = report.reduce(
  (result, file) => ({
    errors: result.errors + file.errorCount,
    warnings: result.warnings + file.warningCount,
    fatalErrors: result.fatalErrors + file.fatalErrorCount,
  }),
  { errors: 0, warnings: 0, fatalErrors: 0 },
);

console.log(
  `ESLint debt: ${totals.errors} errors, ${totals.warnings} warnings (baseline: ${maxErrors}/${maxWarnings})`,
);

if (
  totals.fatalErrors > 0 ||
  totals.errors > maxErrors ||
  totals.warnings > maxWarnings
) {
  console.error('ESLint debt increased or ESLint reported a fatal error.');
  process.exit(1);
}
