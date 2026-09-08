import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/**
 * Flat config, imported directly rather than through FlatCompat.
 *
 * eslint-config-next ships flat configs from v16, and running them through
 * `FlatCompat` makes ESLint throw "Converting circular structure to JSON"
 * before it lints a single file.
 */
const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
];

export default eslintConfig;
