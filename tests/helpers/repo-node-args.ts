/**
 * Arguments that let a child `node` process load this repository's TypeScript
 * sources on any supported Node build — including distribution Node builds
 * compiled without bundled TypeScript type-stripping support, where a bare
 * `.ts` import dies with ERR_UNKNOWN_FILE_EXTENSION (and
 * `--experimental-strip-types` dies with ERR_NO_TYPESCRIPT). The parent test
 * process gets the same treatment from `pnpm test` (`node --import tsx --test`);
 * fixtures that spawn fresh Node workers must opt in explicitly. `tsx` is a
 * devDependency resolved from the project cwd the fixtures spawn with.
 */
export const repoNodeArgs = ['--import', 'tsx'] as const
