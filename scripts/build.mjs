import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { transform } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
const assets = [
  "index.html",
  "mentions-legales.html",
  "confidentialite.html",
  "CNAME",
  "landing.css",
  "style.css",
  "map-demo.css",
  "lea-call.css",
  "lea.js",
  "map-demo.js",
  "lea-call.js",
  "chat-content.js",
  "brand",
  "fonts",
  "images",
  "vendor",
  "audio",
  "video",
];

// Only public assets enter dist; Functions, secrets, migrations and tests stay out.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) {
  await cp(path.join(root, asset), path.join(output, asset), {
    recursive: true,
  });
  const extension = path.extname(asset);
  if (extension === ".js" || extension === ".css") {
    const result = await transform(
      await readFile(path.join(root, asset), "utf8"),
      {
        loader: extension === ".js" ? "js" : "css",
        minify: true,
        charset: "utf8",
        ...(extension === ".js" ? { target: "es2022" } : {}),
      },
    );
    await writeFile(path.join(output, asset), result.code);
  }
}
await writeFile(
  path.join(output, "_routes.json"),
  JSON.stringify(
    {
      version: 1,
      include: ["/api/recap"],
      exclude: [],
    },
    null,
    2,
  ),
);
console.log(
  "Public site built in dist. Only /api/recap runs a Pages Function.",
);
