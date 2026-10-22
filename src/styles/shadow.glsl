// A soft drop shadow under the window and a faint light rim around it. It follows the window as the
// camera zooms and moves it. Parameters: blur and offset (1080p pixels at zoom 1), opacity and rim (0–1).

void main() {
  vec2 px = pixel();
  float k = uUnit * uZoom;
  float shadow = opacity * (1.0 - smoothstep(-blur * k, blur * k, windowDistance(px - vec2(0.0, offset * k))));
  float edge = rim * (1.0 - smoothstep(0.0, 1.5, abs(windowDistance(px))));
  color = vec4(vec3(edge), edge + shadow * (1.0 - edge));
}
