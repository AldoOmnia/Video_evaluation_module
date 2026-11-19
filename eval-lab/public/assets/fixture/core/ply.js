/**
 * PLY point-cloud reader.
 *
 * Handles what scanning apps actually export: ASCII and binary (either byte
 * order), any property order and type, optional colour, and Gaussian-splat
 * files where colour is stored as spherical-harmonic coefficients. Faces and
 * other elements are ignored — only the vertices are needed.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{positions: Float32Array, colors: Uint8Array|null, count: number, comments: string[], format: string, splat: boolean}}
 */
const TYPES = {
  char: [1, "getInt8"], int8: [1, "getInt8"], uchar: [1, "getUint8"], uint8: [1, "getUint8"],
  short: [2, "getInt16"], int16: [2, "getInt16"], ushort: [2, "getUint16"], uint16: [2, "getUint16"],
  int: [4, "getInt32"], int32: [4, "getInt32"], uint: [4, "getUint32"], uint32: [4, "getUint32"],
  float: [4, "getFloat32"], float32: [4, "getFloat32"], double: [8, "getFloat64"], float64: [8, "getFloat64"],
};

export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  // The header is ASCII and ends at "end_header\n"; scanning suffices.
  const probe = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endAt = probe.indexOf("end_header");
  if (!probe.startsWith("ply") || endAt < 0) throw new Error("not a PLY file");
  const bodyStart = probe.indexOf("\n", endAt) + 1;
  const lines = probe.slice(0, endAt).split(/\r?\n/);

  let format = "";
  const comments = [];
  const elements = [];
  for (const line of lines) {
    const tok = line.trim().split(/\s+/);
    if (tok[0] === "format") format = tok[1];
    else if (tok[0] === "comment") comments.push(line.trim().slice(8));
    else if (tok[0] === "element") elements.push({ name: tok[1], count: Number(tok[2]), props: [] });
    else if (tok[0] === "property" && elements.length) {
      const el = elements[elements.length - 1];
      if (tok[1] === "list") el.props.push({ name: tok[4], list: true, countType: tok[2], type: tok[3] });
      else el.props.push({ name: tok[2], type: tok[1] });
    }
  }
  const vi = elements.findIndex((e) => e.name === "vertex");
  if (vi < 0) throw new Error("PLY has no vertex element");
  const vertex = elements[vi];
  const n = vertex.count;
  const find = (...names) => vertex.props.findIndex((p) => names.includes(p.name));
  const ix = find("x"), iy = find("y"), iz = find("z");
  if (ix < 0 || iy < 0 || iz < 0) throw new Error("PLY vertices have no x/y/z");
  const ir = find("red", "r", "diffuse_red"), ig = find("green", "g", "diffuse_green"), ib = find("blue", "b", "diffuse_blue");
  const sh = [find("f_dc_0"), find("f_dc_1"), find("f_dc_2")];
  const hasRGB = ir >= 0 && ig >= 0 && ib >= 0;
  const hasSH = !hasRGB && sh.every((i) => i >= 0);

  const positions = new Float32Array(n * 3);
  const colors = hasRGB || hasSH ? new Uint8Array(n * 3) : null;
  // Colour may be 0–255 integers or 0–1 floats.
  const colourScale = hasRGB && /float|double/.test(vertex.props[ir].type) ? 255 : 1;
  const SH_C0 = 0.28209479177387814;
  const store = (i, row) => {
    positions[i * 3] = row[ix]; positions[i * 3 + 1] = row[iy]; positions[i * 3 + 2] = row[iz];
    if (hasRGB) {
      colors[i * 3] = row[ir] * colourScale; colors[i * 3 + 1] = row[ig] * colourScale; colors[i * 3 + 2] = row[ib] * colourScale;
    } else if (hasSH) {
      for (let c = 0; c < 3; c++) colors[i * 3 + c] = Math.max(0, Math.min(255, (0.5 + SH_C0 * row[sh[c]]) * 255));
    }
  };

  if (format === "ascii") {
    const text = new TextDecoder("latin1").decode(bytes.subarray(bodyStart));
    let at = 0;
    const skipLines = (count) => { for (let i = 0; i < count; i++) at = text.indexOf("\n", at) + 1; };
    for (let e = 0; e < vi; e++) skipLines(elements[e].count);
    const row = new Float64Array(vertex.props.length);
    for (let i = 0; i < n; i++) {
      let end = text.indexOf("\n", at);
      if (end < 0) end = text.length;
      // Hand-rolled split: a million-line file spends most of its time here.
      let col = 0, s = at;
      for (let c = at; c <= end && col < row.length; c++) {
        const ch = c === end ? 32 : text.charCodeAt(c);
        if (ch === 32 || ch === 9 || ch === 13) {
          if (c > s) row[col++] = Number(text.slice(s, c));
          s = c + 1;
        }
      }
      if (col < row.length) throw new Error(`PLY vertex ${i} is short`);
      store(i, row);
      at = end + 1;
    }
  } else if (format === "binary_little_endian" || format === "binary_big_endian") {
    const little = format === "binary_little_endian";
    const view = new DataView(buffer);
    let at = bodyStart;
    for (let e = 0; e < vi; e++) {
      const el = elements[e];
      if (el.props.some((p) => p.list)) throw new Error(`PLY element "${el.name}" before the vertices has list properties`);
      at += el.count * el.props.reduce((s, p) => s + TYPES[p.type][0], 0);
    }
    const layout = [];
    let stride = 0;
    for (const p of vertex.props) {
      if (p.list) throw new Error("PLY vertex list properties are not supported");
      const t = TYPES[p.type];
      if (!t) throw new Error(`unknown PLY type ${p.type}`);
      layout.push({ offset: stride, get: t[1] });
      stride += t[0];
    }
    if (at + n * stride > buffer.byteLength) throw new Error("PLY file is truncated");
    const used = [ix, iy, iz, ...(hasRGB ? [ir, ig, ib] : hasSH ? sh : [])];
    const row = new Float64Array(vertex.props.length);
    for (let i = 0; i < n; i++) {
      const base = at + i * stride;
      for (const c of used) row[c] = view[layout[c].get](base + layout[c].offset, little);
      store(i, row);
    }
  } else {
    throw new Error(`unsupported PLY format "${format}"`);
  }

  // A Gaussian splat carries its colour as spherical harmonics and a rotation
  // per point; callers need to know because of the axis convention it implies.
  const splat = sh.every((i) => i >= 0) && find("rot_0") >= 0;
  return { positions, colors, count: n, comments, format, splat };
}
