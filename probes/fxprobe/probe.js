const report = (name, fn) => {
  try { console.log(`PROBE js ${name} ok=true value=${String(fn())}`); }
  catch (e) { console.log(`PROBE js ${name} ok=false value=${e && e.message}`); }
};
report('typeof lsmp', () => typeof lsmp);
report('lsmp.keys', () => Object.keys(lsmp).sort().join(','));
report('vector', () => [typeof lsmp.Vector3, typeof lsmp.vec3, typeof globalThis.Vector3].join(' '));
lsmp.onCall('probe:multi', () => 'from-js');
