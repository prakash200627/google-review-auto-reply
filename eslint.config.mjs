import { createRequire } from "module";

const require = createRequire(import.meta.url);
const nextConfig = require("eslint-config-next");

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...(Array.isArray(nextConfig) ? nextConfig : [nextConfig]),
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
