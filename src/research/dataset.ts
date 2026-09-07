import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type Frame, validateFrame } from "../engine/model.js";

export interface Manifest {
  schema: 1;
  source: string;
  license: string;
  collectedAt: string;
  sha256: string;
  coverage: {
    from: string;
    to: string;
    markets: string[];
    frames: number;
    maxGapMs: number;
  };
  kind: "synthetic" | "snapshots" | "events" | "prices";
  limitations: string[];
  observations?: {file:string;sha256:string;policy:string};
  sourceChecksum?: string;
  mappingChecksum?: string;
}
export const checksum = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function writeDataset(
  path: string,
  frames: Frame[],
  info: Pick<Manifest, "source" | "license" | "kind" | "limitations"> &
    Partial<Pick<Manifest, "sourceChecksum" | "mappingChecksum" | "observations">>,
): Manifest {
  if (!frames.length) throw new Error("No hay libros válidos para guardar");
  frames.forEach(validateFrame);
  frames.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const content = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
  let maxGapMs = 0;
  const last = new Map<string, number>();
  for (const f of frames) {
    if (last.has(f.marketId))
      maxGapMs = Math.max(maxGapMs, f.timestamp - last.get(f.marketId)!);
    last.set(f.marketId, f.timestamp);
  }
  const manifest: Manifest = {
    schema: 1,
    ...info,
    collectedAt: new Date().toISOString(),
    sha256: checksum(content),
    coverage: {
      from: new Date(frames[0].timestamp).toISOString(),
      to: new Date(frames.at(-1)!.timestamp).toISOString(),
      markets: [...new Set(frames.map((f) => f.marketId))],
      frames: frames.length,
      maxGapMs,
    },
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  writeFileSync(
    `${path}.manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
export function readDataset(path: string): {
  frames: Frame[];
  manifest: Manifest;
} {
  const raw = readFileSync(path),
    manifest = JSON.parse(
      readFileSync(`${path}.manifest.json`, "utf8"),
    ) as Manifest;
  if (
    manifest.schema !== 1 ||
    manifest.sha256 !== checksum(raw) ||
    !manifest.source ||
    !manifest.license ||
    !Array.isArray(manifest.limitations)
  )
    throw new Error("Procedencia o checksum inválido");
  if (manifest.observations) {
    const o=manifest.observations;
    if (typeof o.file !== 'string' || !o.file || basename(o.file)!==o.file || !/^[a-f0-9]{64}$/.test(o.sha256) || !o.policy || checksum(readFileSync(resolve(dirname(path),o.file)))!==o.sha256)
      throw new Error('Procedencia o checksum de observaciones inválido');
  }
  const frames = raw
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => validateFrame(JSON.parse(line)));
  const ids = new Set<string>();
  for (let i = 0; i < frames.length; i++) {
    if (
      ids.has(frames[i].id) ||
      (i && frames[i].timestamp < frames[i - 1].timestamp)
    )
      throw new Error("Datos duplicados o fuera de orden temporal");
    ids.add(frames[i].id);
    if (
      frames[i].yes.timestamp > frames[i].timestamp ||
      frames[i].no.timestamp > frames[i].timestamp
    )
      throw new Error("Libro contiene información futura");
  }
  if (manifest.coverage.frames !== frames.length)
    throw new Error("Cobertura inconsistente");
  return { frames, manifest };
}
