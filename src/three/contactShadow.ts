/**
 * Soft contact shadow: the scene is rendered from below into a depth-darkness target,
 * blurred twice and laid on the ground (after the three.js "contact shadows" technique).
 */
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  OrthographicCamera,
  PlaneGeometry,
  ShaderMaterial,
  WebGLRenderTarget,
  type Object3D,
  type Scene,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

export class ContactShadow {
  readonly group = new Group();
  private readonly rt: WebGLRenderTarget;
  private readonly rtBlur: WebGLRenderTarget;
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly plane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly blurPlane: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly depthMat = new MeshDepthMaterial();
  private readonly hBlur = new ShaderMaterial(HorizontalBlurShader);
  private readonly vBlur = new ShaderMaterial(VerticalBlurShader);
  private readonly darkness = { value: 1.25 };
  private readonly size: number;
  blur = 2.2;

  constructor(size = 512) {
    this.size = size;
    this.rt = new WebGLRenderTarget(size, size);
    this.rt.texture.generateMipmaps = false;
    this.rtBlur = new WebGLRenderTarget(size, size);
    this.rtBlur.texture.generateMipmaps = false;
    const geo = new PlaneGeometry(1, 1).rotateX(Math.PI / 2);
    this.plane = new Mesh(geo, new MeshBasicMaterial({ map: this.rt.texture, opacity: 0.85, transparent: true, depthWrite: false }));
    this.plane.renderOrder = 1;
    // The render target is seen from below, so flip it back.
    this.plane.scale.y = -1;
    this.group.add(this.plane);
    this.blurPlane = new Mesh(new PlaneGeometry(1, 1).rotateX(Math.PI / 2), this.hBlur);
    this.blurPlane.visible = false;
    this.group.add(this.blurPlane);
    this.cam.rotation.x = Math.PI / 2;
    this.group.add(this.cam);
    const darkness = this.darkness;
    this.depthMat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.darkness = darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
      )}`;
    };
    this.depthMat.depthTest = false;
    this.depthMat.depthWrite = false;
    this.hBlur.depthTest = false;
    this.vBlur.depthTest = false;
  }

  /** Ground rectangle (scene units) centred at (x, z), catching shadows from objects up to `height`. */
  setArea(x: number, z: number, width: number, depth: number, height: number): void {
    this.group.position.set(x, 0.0015, z);
    this.plane.scale.set(width, -1, depth);
    this.blurPlane.scale.set(width, 1, depth);
    this.cam.left = -width / 2;
    this.cam.right = width / 2;
    this.cam.top = depth / 2;
    this.cam.bottom = -depth / 2;
    this.cam.near = 0;
    this.cam.far = Math.max(0.05, height);
    this.cam.updateProjectionMatrix();
  }

  set opacity(v: number) {
    this.plane.material.opacity = v;
  }

  private blurPass(renderer: WebGLRenderer, amount: number): void {
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(this.rtBlur);
    renderer.render(this.blurPlane, this.cam);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.blurPlane, this.cam);
    this.blurPlane.visible = false;
  }

  /** Re-render the shadow; `hide` lists objects that must not cast it (ground, helpers). */
  render(renderer: WebGLRenderer, scene: Scene, hide: Object3D[]): void {
    const background = scene.background;
    scene.background = null;
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    this.plane.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const clearAlpha = renderer.getClearAlpha();
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearAlpha(0);
    scene.overrideMaterial = this.depthMat;
    // three caches geometry uploads per `info.render.frame`, which it advances before the
    // shadow pass; bump it so vertices re-posed since the last frame are uploaded now.
    renderer.info.render.frame++;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.cam);
    scene.overrideMaterial = null;
    this.blurPass(renderer, this.blur);
    this.blurPass(renderer, this.blur * 0.4);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearAlpha(clearAlpha);
    renderer.shadowMap.autoUpdate = autoShadow;
    hide.forEach((o, i) => { o.visible = vis[i]; });
    this.plane.visible = true;
    scene.background = background;
  }

  dispose(): void {
    this.rt.dispose();
    this.rtBlur.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.blurPlane.geometry.dispose();
    this.depthMat.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
  }
}
