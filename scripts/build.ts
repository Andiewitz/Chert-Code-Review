import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  target: "bun",
  plugins: [solidPlugin],
  compile: {
    outfile: "./dist/chert",
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const exe = result.outputs[0]?.path ?? "dist/chert";
console.log(`Built ${exe}`);
