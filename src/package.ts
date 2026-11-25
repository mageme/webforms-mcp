/** The version this build is published under; test/version.test.ts keeps it equal to package.json. */
export const VERSION = '1.0.0';

/** What a host runs: the package pinned to its major, so a release never moves a store to a breaking version. */
export const PACKAGE_SPEC = `@mageme/webforms-mcp@${VERSION.split('.')[0]}`;

/** How a person starts the commands of this package, as printed in hints. */
export const RUN = `npx -y ${PACKAGE_SPEC}`;
