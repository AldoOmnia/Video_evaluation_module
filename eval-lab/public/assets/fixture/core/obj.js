/**
 * Wavefront OBJ writer.
 *
 * NX imports OBJ as a faceted (convergent) body. OBJ carries no unit, and NX
 * assumes the units of the work part, which for this team is millimetres — so
 * the mesh is written in mm and the header says so.
 *
 * @param {Float32Array} positions  xyz in metres
 * @param {Uint32Array}  indices    triangles
 * @param {object}       [info]     { name, lines: string[] } extra header comments
 * @returns {Blob|string} Blob in the browser, string in Node
 */
export function writeOBJ(positions, indices, info = {}) {
  const parts = [];
  parts.push(`# ${info.name ?? "camera-support"}\n# units: millimetres\n# frame: scan frame, Z up\n`);
  for (const line of info.lines ?? []) parts.push(`# ${line}\n`);
  parts.push(`o ${(info.name ?? "camera_support").replace(/\s+/g, "_")}\n`);

  // Build in chunks: a single string for a million vertices is slow to grow.
  let chunk = [];
  const flush = () => { parts.push(chunk.join("")); chunk = []; };
  for (let i = 0; i < positions.length; i += 3) {
    chunk.push(`v ${(positions[i] * 1000).toFixed(3)} ${(positions[i + 1] * 1000).toFixed(3)} ${(positions[i + 2] * 1000).toFixed(3)}\n`);
    if (chunk.length >= 20000) flush();
  }
  for (let i = 0; i < indices.length; i += 3) {
    chunk.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}\n`);
    if (chunk.length >= 20000) flush();
  }
  flush();
  return typeof Blob !== "undefined" && info.asString !== true ? new Blob(parts, { type: "model/obj" }) : parts.join("");
}
