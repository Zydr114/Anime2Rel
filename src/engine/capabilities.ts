import type * as THREE from 'three/webgpu'

export interface GpuCapabilities {
  backend: 'webgpu' | 'webgl2'
  maxTextureSize: number
  shaderF16: boolean
  adapter: string
}

interface BackendInternals {
  isWebGPUBackend?: boolean
  device?: GPUDevice
  gl?: WebGL2RenderingContext
}

export async function detectCapabilities(renderer: THREE.WebGPURenderer): Promise<GpuCapabilities> {
  const backend = renderer.backend as unknown as BackendInternals
  if (backend.isWebGPUBackend && backend.device) {
    let adapter = 'WebGPU'
    try {
      const a = await navigator.gpu.requestAdapter()
      if (a?.info) adapter = [a.info.vendor, a.info.architecture, a.info.description].filter(Boolean).join(' / ') || adapter
    } catch {
      // 适配器信息只用于展示，读取失败不影响功能
    }
    return {
      backend: 'webgpu',
      maxTextureSize: backend.device.limits.maxTextureDimension2D,
      shaderF16: backend.device.features.has('shader-f16'),
      adapter,
    }
  }
  const gl = backend.gl
  let adapter = 'WebGL2'
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (ext) adapter = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
  }
  return {
    backend: 'webgl2',
    maxTextureSize: gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 4096,
    shaderF16: false,
    adapter,
  }
}
