import base from './.config/eslint.config.mjs';
export default [...base, { ignores: ['dist/**', 'node_modules/**', '.config/**'] }];
