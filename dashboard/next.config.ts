import type { NextConfig } from 'next';

const config: NextConfig = {
  // The data layer lives in the root package as TypeScript source.
  transpilePackages: ['gatecheck'],
  // Native module: load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ['better-sqlite3'],
};

export default config;
