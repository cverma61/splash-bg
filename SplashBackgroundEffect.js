"use strict";

// =============================================
// Utility Functions
// =============================================
const scaleByPixelRatio = (input) => {
    const pixelRatio = window.devicePixelRatio || 1;
    return Math.floor(input * pixelRatio);
};

// =============================================
// DOM Elements and Configuration
// =============================================
const canvas = document.querySelector(".splash-canvas");
const homePageBody = document.querySelector("body");
const mainWrapper = document.querySelector("#main");
const modeChangeButton = document.querySelector(".theme-button");

// Simulation configuration
const config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 4,
    VELOCITY_DISSIPATION: 2.87,
    PRESSURE: 0.43,
    PRESSURE_ITERATIONS: 20,
    CURL: 0,
    SPLAT_RADIUS: 0.28,
    SPLAT_FORCE: 5000,
    SHADING: true,
    COLORFUL: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0.961, g: 0.957, b: 0.976 },
    TRANSPARENT: false,
    BLOOM: true,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.1,
    BLOOM_THRESHOLD: 0.6,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: true,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 0.7
};

// =============================================
// WebGL Context and Setup
// =============================================
let gl, ext;
const { gl: webgl, ext: extensions } = getWebGLContext(canvas);
gl = webgl;
ext = extensions;

// Initialize canvas
resizeCanvas();

// =============================================
// Pointer Management
// =============================================
function PointerPrototype() {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [30, 0, 300];
}

let pointers = [];
let splatStack = [];
pointers.push(new PointerPrototype());

// =============================================
// Shader Programs
// =============================================
const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main() {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;

    void main() {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

class Material {
    constructor(vertexShader, fragmentShaderSource) {
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = [];
        this.activeProgram = null;
        this.uniforms = [];
    }

    setKeywords(keywords) {
        let hash = 0;
        for (let i = 0; i < keywords.length; i++) {
            hash += hashCode(keywords[i]);
        }
        
        let program = this.programs[hash];
        if (program == null) {
            let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
            program = createProgram(this.vertexShader, fragmentShader);
            this.programs[hash] = program;
        }

        if (program != this.activeProgram) {
            this.uniforms = getUniforms(program);
            this.activeProgram = program;
        }
    }

    bind() {
        gl.useProgram(this.activeProgram);
    }
}

// =============================================
// Framebuffer Management
// =============================================
let dye, velocity, divergence, curl, pressure, bloom, sunrays, sunraysTemp;
let bloomFramebuffers = [];
let ditheringTexture = createTextureAsync("LDR_LLL1_0.png");

// =============================================
// Simulation Logic
// =============================================
function update() {
    const deltaTime = calcDeltaTime();
    if (resizeCanvas()) {
        initFramebuffers();
    }
    updateColors(deltaTime);
    applyInputs();
    if (!config.PAUSED) {
        step(deltaTime);
    }
    render(null);
    requestAnimationFrame(update);
}

// =============================================
// Event Handlers
// =============================================
homePageBody.addEventListener("mouseover", (e) => {
    let posX = scaleByPixelRatio(e.clientX);
    let posY = scaleByPixelRatio(e.clientY);
    let pointer = pointers.find(p => p.id === -1);
    
    if (pointer == null) {
        pointer = new PointerPrototype();
    }
    
    updatePointerDownData(pointer, -1, posX, posY);
});

// =============================================
// Utility Functions
// =============================================
function getWebGLContext(canvas) {
    const r = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
    let t = canvas.getContext("webgl2", r);
    const n = !!t;
    let i, o;
    n || (t = canvas.getContext("webgl", r) || canvas.getContext("experimental-webgl", r)),
    n ? (t.getExtension("EXT_color_buffer_float"), o = t.getExtension("OES_texture_float_linear")) : (i = t.getExtension("OES_texture_half_float"), o = t.getExtension("OES_texture_half_float_linear")),
    t.clearColor(1, 1, 1, 1);
    const a = n ? t.HALF_FLOAT : i.HALF_FLOAT_OES;
    let l, u, c;
    return n ? (l = getSupportedFormat(t, t.RGBA16F, t.RGBA, a), u = getSupportedFormat(t, t.RG16F, t.RG, a), c = getSupportedFormat(t, t.R16F, t.RED, a)) : (l = getSupportedFormat(t, t.RGBA, t.RGBA, a), u = getSupportedFormat(t, t.RGBA, t.RGBA, a), c = getSupportedFormat(t, t.RGBA, t.RGBA, a)),
    { gl: t, ext: { formatRGBA: l, formatRG: u, formatR: c, halfFloatTexType: a, supportLinearFiltering: o } }
}

function resizeCanvas() {
    let e = scaleByPixelRatio(canvas.clientWidth);
    let r = scaleByPixelRatio(canvas.clientHeight);
    return (canvas.width != e || canvas.height != r) && (canvas.width = e, canvas.height = r, true);
}

function generateColor() {
    let e = HSVtoRGB(.5, .96, .08);
    return e = { r: 197 / 255, g: 252 / 255, b: 252 / 255 },
    e.r *= .15,
    e.g *= .15,
    e.b *= .15,
    e
}

function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
        switch (internalFormat) {
            case gl.R16F:
                return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
            case gl.RG16F:
                return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default:
                return null;
        }
    }
    return { internalFormat, format };
}

function supportRenderTextureFormat(gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    
    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    
    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status === gl.FRAMEBUFFER_COMPLETE;
}

function isMobile() {
    return /Mobi|Android/i.test(navigator.userAgent);
}

function captureScreenshot() {
    let resolution = getResolution(config.CAPTURE_RESOLUTION);
    let fbo = createFBO(resolution.width, resolution.height, ext.formatRGBA.internalFormat, ext.formatRGBA.format, ext.halfFloatTexType, gl.NEAREST);
    render(fbo);
    
    let texture = framebufferToTexture(fbo);
    texture = normalizeTexture(texture, fbo.width, fbo.height);
    let dataURL = textureToCanvas(texture, fbo.width, fbo.height).toDataURL();
    
    downloadURI("fluid.png", dataURL);
    URL.revokeObjectURL(dataURL);
}

function framebufferToTexture(fbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    let size = fbo.width * fbo.height * 4;
    let pixels = new Float32Array(size);
    gl.readPixels(0, 0, fbo.width, fbo.height, gl.RGBA, gl.FLOAT, pixels);
    return pixels;
}

function normalizeTexture(texture, width, height) {
    let result = new Uint8Array(texture.length);
    let id = 0;
    
    for (let i = height - 1; i >= 0; i--) {
        for (let j = 0; j < width; j++) {
            let nid = i * width * 4 + j * 4;
            result[nid + 0] = 255 * clamp01(texture[id + 0]);
            result[nid + 1] = 255 * clamp01(texture[id + 1]);
            result[nid + 2] = 255 * clamp01(texture[id + 2]);
            result[nid + 3] = 255 * clamp01(texture[id + 3]);
            id += 4;
        }
    }
    
    return result;
}

function clamp01(value) {
    return Math.min(Math.max(value, 0), 1);
}

function textureToCanvas(texture, width, height) {
    let canvas = document.createElement("canvas");
    let ctx = canvas.getContext("2d");
    canvas.width = width;
    canvas.height = height;
    
    let imageData = ctx.createImageData(width, height);
    imageData.data.set(texture);
    ctx.putImageData(imageData, 0, 0);
    
    return canvas;
}

function downloadURI(filename, uri) {
    let link = document.createElement("a");
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// =============================================
// Simulation Functions
// =============================================
function step(deltaTime) {
    gl.disable(gl.BLEND);
    
    // Curl
    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);
    
    // Vorticity
    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, deltaTime);
    blit(velocity.write);
    velocity.swap();
    
    // Divergence
    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);
    
    // Pressure
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();
    
    // Pressure solve
    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
    }
    
    // Gradient subtract
    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();
    
    // Advection
    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering) {
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    }
    
    // Velocity advection
    let velocityRead = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityRead);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityRead);
    gl.uniform1f(advectionProgram.uniforms.dt, deltaTime);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();
    
    // Dye advection
    if (!ext.supportLinearFiltering) {
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    }
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
}

// =============================================
// Rendering Functions
// =============================================
function render(target) {
    if (config.BLOOM) {
        applyBloom(dye.read, bloom);
    }
    
    if (config.SUNRAYS) {
        applySunrays(dye.read, dye.write, sunrays);
        blur(sunrays, sunraysTemp, 1);
    }
    
    if (target != null && config.TRANSPARENT) {
        gl.disable(gl.BLEND);
    } else {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
    }
    
    if (!config.TRANSPARENT) {
        drawColor(target, normalizeColor(config.BACK_COLOR));
    }
    
    if (target == null && config.TRANSPARENT) {
        drawCheckerboard(target);
    }
    
    drawDisplay(target);
}

// =============================================
// Event Handlers
// =============================================
homePageBody.addEventListener("mousemove", (e) => {
    let pointer = pointers[0];
    if (pointer.down) {
        updatePointerMoveData(pointer, scaleByPixelRatio(e.clientX), scaleByPixelRatio(e.clientY));
    }
});

window.addEventListener("mouseup", () => {
    updatePointerUpData(pointers[0]);
});

homePageBody.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    
    while (touches.length >= pointers.length) {
        pointers.push(new PointerPrototype());
    }
    
    for (let i = 0; i < touches.length; i++) {
        let posX = scaleByPixelRatio(touches[i].pageX);
        let posY = scaleByPixelRatio(touches[i].pageY);
        updatePointerDownData(pointers[i + 1], touches[i].identifier, posX, posY);
    }
});

homePageBody.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    
    for (let i = 0; i < touches.length; i++) {
        let pointer = pointers[i + 1];
        if (pointer.down) {
            updatePointerMoveData(pointer, scaleByPixelRatio(touches[i].pageX), scaleByPixelRatio(touches[i].pageY));
        }
    }
}, false);

window.addEventListener("touchend", (e) => {
    const touches = e.changedTouches;
    
    for (let i = 0; i < touches.length; i++) {
        let pointer = pointers.find(p => p.id === touches[i].identifier);
        if (pointer != null) {
            updatePointerUpData(pointer);
        }
    }
});

// Initialize and start simulation
update();
