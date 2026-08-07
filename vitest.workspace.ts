import { defineWorkspace } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Sync rule (binding, docs/design/T-001.md §1.4): this alias map and `paths`
 * in tsconfig.base.json must stay entry-for-entry identical. Both files are
 * T-001-owned and frozen after publish.
 */
const alias = {
  '@core': r('packages/core/src/index.ts'),
  '@flag-engine': r('packages/flag-engine/src/index.ts'),
  '@adapters/valuation': r('packages/adapters/valuation/src/index.ts'),
  '@adapters/nhtsa': r('packages/adapters/nhtsa/src/index.ts'),
  '@adapters/vehicle-history': r('packages/adapters/vehicle-history/src/index.ts'),
  '@adapters/credit-prequal': r('packages/adapters/credit-prequal/src/index.ts'),
  '@offer-extraction': r('packages/offer-extraction/src/index.ts'),
  '@receipt': r('packages/receipt/src/index.ts'),
};

export default defineWorkspace([
  {
    test: {
      name: 'workspace',
      include: [
        'packages/**/src/**/*.test.ts',
        'packages/**/test/**/*.test.ts',
        'services/**/src/**/*.test.ts',
        'services/**/test/**/*.test.ts',
      ],
      environment: 'node',
    },
    resolve: { alias },
  },
]);
