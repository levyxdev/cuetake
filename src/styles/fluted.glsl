// Fluted glass: soft light in the page's brand color seen through glass ribs, over near black.
// Parameters: count (ribs across the short side), strength (how far a rib bends the light, as a
// fraction of the short side), angle (rib tilt in degrees). Set uBrand to light it in another color.

vec3 hueShift(vec3 c, float turn) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  vec3 hsv = vec3(fract(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)) + turn), d / (q.x + 1e-10), q.x);
  return hsv.z * mix(vec3(1.0), clamp(abs(mod(hsv.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0), hsv.y);
}
float blob(vec2 uv, vec2 c, float r) { return exp(-dot(uv - c, uv - c) / (r * r)); }
// Light placed where the margins around the window show; uv is 0–1 across the short side, centered.
vec3 light(vec2 uv) {
  return uBrand * 0.06
    + uBrand * blob(uv, vec2(0.15, 0.95), 0.42)
    + hueShift(uBrand, 0.1) * blob(uv, vec2(0.92, 0.08), 0.38) * 0.9
    + hueShift(uBrand, -0.11) * blob(uv, vec2(0.85, 0.9), 0.3) * 0.7
    + hueShift(uBrand, 0.04) * blob(uv, vec2(0.05, 0.15), 0.25) * 0.5;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 px = pixel(), center = uResolution * 0.5;
  float side = min(uResolution.x, uResolution.y), a = radians(angle);
  vec2 across = vec2(cos(a), sin(a));
  float w = side / count, u = fract(dot(px - center, across) / w);
  vec2 bent = px + across * (u - 0.5) * strength * side;
  vec3 c = light((bent - center) / side + 0.5);
  c *= 0.78 + 0.34 * pow(u, 1.6);                  // each rib darkens toward one edge
  c += 0.05 * smoothstep(0.9, 1.0, u);             // and catches a highlight on the other
  c += (hash(px) - 0.5) * 0.05;                    // grain keeps H.264 from banding the light
  color = vec4(c, 1.0);
}
