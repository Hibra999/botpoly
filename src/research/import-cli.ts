import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDataset } from "./dataset.js";
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    mapping: { type: "string" },
    out: { type: "string" },
    python: { type: "string", default: "python3" },
  },
});
if (!values.input || !values.mapping || !values.out)
  throw new Error(
    "Uso: pnpm data:import --input archivo.parquet --mapping metadata.json --out data/pmxt.jsonl [--python .venv/bin/python]",
  );
const script = fileURLToPath(
  new URL("../../scripts/research/import_pmxt.py", import.meta.url),
);
const result = spawnSync(
  values.python!,
  [
    script,
    "--input",
    values.input,
    "--mapping",
    values.mapping,
    "--out",
    values.out,
  ],
  { stdio: "inherit", shell: false },
);
if (result.error || result.status !== 0)
  throw new Error(
    "Importación fallida. Instala pyarrow en el entorno Python indicado y revisa esquema y metadatos.",
  );
const data = readDataset(values.out);
console.log(
  `Verificadas ${data.frames.length} observaciones con checksum y procedencia.`,
);
