// The plugin UI can't read package.json (Figma loads ui.html as a string), so it carries its own copy of the version.
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")).version;
const ui = read("plugin/ui.html").match(/const VERSION = "([^"]+)"/)?.[1];
if (ui !== pkg) {
  console.error(`version mismatch: package.json ${pkg}, plugin/ui.html ${ui ?? "missing"}`);
  process.exit(1);
}
