const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const PARTICLE_COUNT = 2000;
const GLITCH_START_MS = 28000;
const GLITCH_DURATION_MS = 2000;
const GLITCH_SCALE_STEP = 1.5;

let cw = window.innerWidth;
let ch = window.innerHeight;
let dpr = window.devicePixelRatio || 1;
// Off-screen so the eye starts open
const mouse = { x: -9999, y: -9999 };
let lastMouseMove = -Infinity;
let wanderAngle = Math.random() * Math.PI * 2;
let wanderUntil = 0;
let pupilPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let closeAmount = 0;
let particles = [];
let lastFrameTime = 0;
let elapsedMs = 0;
let glitchScale = 1;
let glitching = false;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.addEventListener('mousemove', e => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  lastMouseMove = performance.now();
});
window.addEventListener('resize', resize);

function resize() {
  dpr = window.devicePixelRatio || 1;
  cw = window.innerWidth;
  ch = window.innerHeight;
  canvas.width = Math.floor(cw * dpr);
  canvas.height = Math.floor(ch * dpr);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  pupilPos.x = cw / 2;
  pupilPos.y = ch / 2;
  if (reducedMotion) {
    drawStatic();
  }
}

class Particle {
  constructor() {
    this.reset();
  }

  reset() {
    const spawnRadius = Math.random() * (cw * 0.4) + cw * 0.15;
    const angle = Math.random() * Math.PI * 2;

    this.x = cw / 2 + Math.cos(angle) * spawnRadius;
    this.y = ch / 2 + Math.sin(angle) * spawnRadius;

    const tangentAngle = angle + Math.PI / 2;
    const tangentialSpeed = 0.8 + Math.random() * 0.4;
    this.vx = Math.cos(tangentAngle) * tangentialSpeed;
    this.vy = Math.sin(tangentAngle) * tangentialSpeed;

    this.alpha = 0.4 + Math.random() * 0.6;
    this.size = 0.8 + Math.random() * 1;
    this.life = 0;
  }

  update(frameDelta) {
    const cx = cw / 2;
    const cy = ch / 2;
    let dx = cx - this.x;
    let dy = cy - this.y;
    let dist = Math.hypot(dx, dy) || 1;

    let gravity = 0.008;
    this.vx += (dx / dist) * gravity * frameDelta;
    this.vy += (dy / dist) * gravity * frameDelta;

    // Damping and inward drift keep the orbit from escaping
    let damping = 1 - Math.min(0.05 / dist, 0.04);
    this.vx *= Math.pow(damping, 2 * frameDelta);
    this.vy *= Math.pow(damping, 2 * frameDelta);

    if (dist < cw / 5) {
      this.vx *= Math.pow(0.999, 2 * frameDelta);
      this.vy *= Math.pow(0.995, 2 * frameDelta);
    }

    this.x += this.vx * frameDelta;
    this.y += this.vy * frameDelta;

    this.life += frameDelta;
    if (this.life > 4750) {
      this.reset();
    }
  }

  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${this.alpha})`;
    ctx.fill();
  }
}

function isMouseOverEye() {
  const dx = mouse.x - cw / 2;
  const dy = mouse.y - ch / 2;
  return dx * dx + dy * dy <= 40 * 40;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function pupilTarget(now) {
  const cx = cw / 2;
  const cy = ch / 2;
  if (now - lastMouseMove < 3000) {
    return { x: mouse.x, y: mouse.y };
  }
  if (now > wanderUntil) {
    wanderAngle = Math.random() * Math.PI * 2;
    wanderUntil = now + 1200 + Math.random() * 1600;
  }
  return {
    x: cx + Math.cos(wanderAngle) * 5,
    y: cy + Math.sin(wanderAngle) * 5
  };
}

function drawEye(eased) {
  const cx = cw / 2;
  const cy = ch / 2;
  const pulse = 1 + Math.sin(Date.now() / 900) * 0.05;

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120 * pulse);
  glow.addColorStop(0, `rgba(255,255,255,${0.5 - eased * 0.35})`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, 120 * pulse, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 40, 0, Math.PI * 2);
  ctx.fillStyle = "black";
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.5, 1);
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.fillStyle = "white";
  ctx.fill();
  ctx.restore();

  const dx = pupilPos.x - cx;
  const dy = pupilPos.y - cy;
  const dist = Math.min(Math.hypot(dx, dy), 9);
  const angle = Math.atan2(dy, dx);
  const pupilX = cx + Math.cos(angle) * dist;
  const pupilY = cy + Math.sin(angle) * dist;

  ctx.beginPath();
  ctx.arc(pupilX, pupilY, 8, 0, Math.PI * 2);
  ctx.fillStyle = "black";
  ctx.fill();

  if (eased > 0) {
    const drop = 26 * eased;
    const bow = 3 * eased;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.5, 1);
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "black";
    ctx.beginPath();
    ctx.moveTo(-20, -20);
    ctx.lineTo(-20, -12 + drop);
    ctx.quadraticCurveTo(0, -12 + drop + bow, 20, -12 + drop);
    ctx.lineTo(20, -20);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-20, 20);
    ctx.lineTo(-20, 12 - drop);
    ctx.quadraticCurveTo(0, 12 - drop - bow, 20, 12 - drop);
    ctx.lineTo(20, 20);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = `rgba(255,255,255,${eased})`;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, 11.5, Math.PI * 0.1, Math.PI * 0.9);
    ctx.stroke();
    ctx.restore();
  }
}

function drawGlitchSlices() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const slices = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < slices; i++) {
    const y = Math.random() * canvas.height;
    const h = 20 + Math.random() * 60;
    const dx = (Math.random() - 0.5) * 80 * dpr;
    ctx.drawImage(canvas, 0, y, canvas.width, h, dx, y, canvas.width, h);
  }
}

function drawStatic() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, cw, ch);
  particles.forEach(p => p.draw());
  drawEye(0);
}

function animate(timestamp) {
  if (!lastFrameTime) {
    lastFrameTime = timestamp;
  }
  // Clamp huge deltas after tab switches
  const deltaMs = Math.min(timestamp - lastFrameTime, 100);
  const frameDelta = deltaMs / 16.6667;
  lastFrameTime = timestamp;
  elapsedMs += deltaMs;

  if (!glitching && elapsedMs >= GLITCH_START_MS) {
    glitching = true;
    particles.forEach(p => p.reset());
  }
  if (glitching) {
    glitchScale *= GLITCH_SCALE_STEP;
  }
  ctx.setTransform(dpr * glitchScale, 0, 0, dpr, 0, 0);

  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(0, 0, cw, ch);

  particles.forEach(p => {
    p.update(frameDelta);
    p.draw();
  });

  const hovering = isMouseOverEye();
  closeAmount += (hovering ? 0.08 : -0.08) * frameDelta;
  closeAmount = Math.min(Math.max(closeAmount, 0), 1);

  const target = pupilTarget(timestamp);
  const glide = Math.min(1, 0.15 * frameDelta);
  pupilPos.x += (target.x - pupilPos.x) * glide;
  pupilPos.y += (target.y - pupilPos.y) * glide;

  drawEye(easeInOut(closeAmount));

  if (glitching) {
    drawGlitchSlices();
    if (elapsedMs >= GLITCH_START_MS + GLITCH_DURATION_MS) {
      window.location.href = "/";
      return;
    }
  }

  requestAnimationFrame(animate);
}

particles = Array.from({ length: PARTICLE_COUNT }, () => new Particle());
resize();

if (!reducedMotion) {
  requestAnimationFrame(animate);
}
