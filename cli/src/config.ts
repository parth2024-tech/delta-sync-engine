import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DIR  = ".deltasync";
const FILE = join(DIR, "config.json");

export interface Config {
  serverUrl: string;
  apiKey:    string;
}

export function configExists() {
  return existsSync(FILE);
}

export function readConfig(): Config {
  if (!existsSync(FILE)) throw new Error("Not initialised. Run: deltasync init");
  return JSON.parse(readFileSync(FILE, "utf8")) as Config;
}

export function writeConfig(cfg: Config) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
