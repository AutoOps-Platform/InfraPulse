import baseConfig from './.config/webpack/webpack.config.ts';
import type { Env } from './.config/webpack/webpack.config.ts';

// Official scaffold extension point. Its loader's POSIX-only module-entry regex
// otherwise misses Windows paths, dropping Grafana's dynamic plugin/subpath URL.
export default async (env: Env) => {
  const config = await baseConfig(env);
  const entryRule = config.module?.rules?.[0];
  if (!entryRule || typeof entryRule !== 'object' || !('test' in entryRule)) {
    throw new Error('Review updated create-plugin module entry loader configuration');
  }
  entryRule.test = /src[\\/](?:.*[\\/])?module\.tsx?$/;
  return config;
};
