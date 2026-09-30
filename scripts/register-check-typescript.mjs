// Only the maintenance checks use this loader. Vite remains the application
// compiler, and the loader works before Node enabled native TS type stripping.
import { register } from 'node:module';
register('./check-typescript-loader.mjs', import.meta.url);
