import fs from "node:fs";
import path from "node:path";

// The installer (scripts/install-ubuntu.sh) and the split-deployment Dockerfile
// stage noVNC into two different, hardcoded locations, so there is no single
// shared noVNC root to pin the target to. SAMEWINDOW_NOVNC_ROOTS lets tests add
// extra roots without weakening the defaults; production never sets it.
const DEFAULT_NOVNC_ROOTS = ["/var/lib/samewindow/novnc-web", "/opt/novnc-web"];

function allowedRoots() {
  const extra = (process.env.SAMEWINDOW_NOVNC_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  return [...DEFAULT_NOVNC_ROOTS.map((root) => path.resolve(root)), ...extra];
}

function realpathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function resolveNovncTarget(requestedArg) {
  const requested = path.resolve(requestedArg ?? path.join(DEFAULT_NOVNC_ROOTS[0], "vnc.html"));
  if (path.basename(requested) !== "vnc.html") {
    throw new Error(`Refusing to patch non-vnc.html target: ${requested}`);
  }

  // Resolve symlinks on both the target and each candidate root, then require
  // the target's real parent directory to be exactly a real root - not merely
  // nested under one, and not merely equal after independently resolving
  // "<root>/vnc.html" (which would trivially match even if vnc.html itself is
  // a symlink pointing outside the root).
  const realTarget = fs.realpathSync(requested);
  const realTargetDir = path.dirname(realTarget);
  for (const root of allowedRoots()) {
    const realRoot = realpathOrNull(root);
    if (realRoot !== null && realTargetDir === realRoot) {
      return { target: requested, root: realRoot };
    }
  }
  throw new Error(
    `Refusing to patch ${requested}: does not resolve to vnc.html directly inside an allowed noVNC root (${allowedRoots().join(", ")})`,
  );
}

function assertInsideRoot(file, root) {
  const resolved = fs.realpathSync(file);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to patch ${file}: escapes allowed root ${root}`);
  }
  return resolved;
}

const { target, root } = resolveNovncTarget(process.argv[2]);
const marker = '<script src="/user-cursor.js"></script>';
const source = fs.readFileSync(target, "utf8");
let patched = source;
let changed = false;

if (!patched.includes(marker)) {
  if (!patched.includes("</body>")) {
    throw new Error(`Cannot find </body> in ${target}`);
  }
  patched = patched.replace("</body>", `  ${marker}\n  </body>`);
  changed = true;
}
const versionedUi = 'src="app/ui.js?samewindow-quality-4-compression-5"';
const nextHtml = patched.replace(/src="app\/ui\.js(?:\?[^\"]*)?"/, versionedUi);
if (nextHtml !== patched) {
  patched = nextHtml;
  changed = true;
}

if (changed) fs.writeFileSync(target, patched, "utf8");

const rfbTarget = path.join(path.dirname(target), "core", "rfb.js");
assertInsideRoot(rfbTarget, root);
const rfbSource = fs.readFileSync(rfbTarget, "utf8");
const rfbPatched = rfbSource
  .replace(/pseudoEncodingQualityLevel0 \+ \d/, "pseudoEncodingQualityLevel0 + 4")
  .replace(/pseudoEncodingCompressLevel0 \+ \d/, "pseudoEncodingCompressLevel0 + 5");
if (rfbPatched === rfbSource) {
  console.log("noVNC quality 4 / compression 5 already active");
} else {
  fs.writeFileSync(rfbTarget, rfbPatched, "utf8");
  console.log(`Patched ${rfbTarget} for quality 4 / compression 5`);
}

const uiTarget = path.join(path.dirname(target), "app", "ui.js");
assertInsideRoot(uiTarget, root);
const uiSource = fs.readFileSync(uiTarget, "utf8");
const uiPatched = uiSource.replace(
  /from "\.\.\/core\/rfb\.js(?:\?[^\"]*)?"/,
  'from "../core/rfb.js?samewindow-quality-4-compression-5"',
);
if (uiPatched !== uiSource) fs.writeFileSync(uiTarget, uiPatched, "utf8");

console.log(changed ? `Patched ${target}` : "noVNC telemetry script already present");
