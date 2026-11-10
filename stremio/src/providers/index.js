import * as vidcore from "./vidcore.js";
import * as chillflix from "./chillflix.js";
import * as nekowatch from "./nekowatch.js";
import { config } from "../config.js";

export const registry = { vidcore, chillflix, nekowatch };

/** Proveedores activos, en el orden declarado por la variable PROVIDERS. */
export function activeProviders() {
  return config.providers.map((key) => registry[key]).filter(Boolean);
}

export { vidcore, chillflix, nekowatch };
