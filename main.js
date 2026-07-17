import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { initBackground } from './three-bg.js';
import gsap from 'gsap';

initBackground();

// ---------------------------------------------
// DOM references
// ---------------------------------------------
const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

const titleScreen = document.getElementById('title-screen');
const instructionsScreen = document.getElementById('instructions-screen');
const liveScreen = document.getElementById('live-screen');

// ---------------------------------------------
// Config constants
// ---------------------------------------------
const CAPTURE_INTERVAL = 100;
const BUFFER_LIFESPAN = 3000;
const HOLD_DURATION = 600;
const CLONE_MODE_DURATION = 6000;
const CLONE_DELAYS = [300, 600, 900];
const STILLNESS_THRESHOLD = 15;
const STILLNESS_DURATION = 800;
const RASENGAN_MAX_RADIUS = 85;
const BOLT_REGEN_INTERVAL = 70;

// ---------------------------------------------
// State
// ---------------------------------------------
let handLandmarker;
let lastCaptureTime = 0;
const frameBuffer = [];

let currentGesture = 'Unknown';
let gestureStartTime = null;
let confirmedGesture = null;

let cloneModeActive = false;
let cloneModeEndTime = 0;

let palmStillStartTime = null;
let palmStillPosition = null;

let rasenganActive = false;
let rasenganParticles = [];
let rasenganCenter = { x: 0, y: 0 };
let rasenganScale = 0;

let chidoriActive = false;
let chidoriBolts = [];
let lastBoltRegenTime = 0;
let flashIntensity = 0;

// ---------------------------------------------
// Screen transitions
// ---------------------------------------------
document.querySelectorAll('.jutsu-card').forEach((card) => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const rotateX = ((y - centerY) / centerY) * -6;
    const rotateY = ((x - centerX) / centerX) * 6;

    card.style.transform = `perspective(600px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.03)`;
  });

  card.addEventListener('mouseleave', () => {
    card.style.transform = 'perspective(600px) rotateX(0) rotateY(0) scale(1)';
  });
});

function switchScreen(fromScreen, toScreen) {
  gsap.to(fromScreen, {
    opacity: 0,
    scale: 0.95,
    duration: 0.4,
    ease: 'power2.in',
    onComplete: () => {
      fromScreen.classList.remove('active');
      toScreen.classList.add('active');
      gsap.fromTo(
        toScreen,
        { opacity: 0, scale: 1.05 },
        { opacity: 1, scale: 1, duration: 0.5, ease: 'power2.out' }
      );

      if (toScreen.id === 'instructions-screen') {
        gsap.from('.jutsu-card', {
          opacity: 0,
          x: -40,
          duration: 0.6,
          stagger: 0.15,
          ease: 'power2.out',
          delay: 0.2,
        });
      }
    },
  });
}

document.getElementById('start-btn').addEventListener('click', () => {
  switchScreen(titleScreen, instructionsScreen);
});

document.getElementById('enter-btn').addEventListener('click', async () => {
  switchScreen(instructionsScreen, liveScreen);
  await init();
});

// ---------------------------------------------
// Setup: model + webcam
// ---------------------------------------------
async function setupHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    numHands: 2
  });
}

async function setupWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      resolve();
    };
  });
}

// ---------------------------------------------
// Frame buffer (for Shadow Clone)
// ---------------------------------------------
async function captureFrame(now) {
  if (now - lastCaptureTime < CAPTURE_INTERVAL) return;
  lastCaptureTime = now;

  const bitmap = await createImageBitmap(video);
  frameBuffer.push({ time: now, bitmap });

  while (frameBuffer.length && now - frameBuffer[0].time > BUFFER_LIFESPAN) {
    const old = frameBuffer.shift();
    old.bitmap.close();
  }
}

function findClosestFrame(targetTime) {
  let closest = null;
  let smallestDiff = Infinity;

  for (const frame of frameBuffer) {
    const diff = Math.abs(frame.time - targetTime);
    if (diff < smallestDiff) {
      smallestDiff = diff;
      closest = frame;
    }
  }

  return closest;
}

function getCropRegion(handLandmark) {
  const anchorX = handLandmark[0].x * canvas.width;
  const anchorY = handLandmark[0].y * canvas.height;

  const cropWidth = 260;
  const cropHeight = 400;

  const cropX = Math.max(0, Math.min(canvas.width - cropWidth, anchorX - cropWidth / 2));
  const cropY = Math.max(0, Math.min(canvas.height - cropHeight, anchorY - cropHeight * 0.7));

  return { cropX, cropY, cropWidth, cropHeight };
}

function drawClones(now, latestHandLandmark) {
  const offsets = [-220, 220, -420];

  CLONE_DELAYS.forEach((delay, i) => {
    const targetTime = now - delay;
    const frame = findClosestFrame(targetTime);
    if (!frame || !latestHandLandmark) return;

    const { cropX, cropY, cropWidth, cropHeight } = getCropRegion(latestHandLandmark);
    const destX = cropX + offsets[i];

    ctx.save();
    ctx.shadowColor = 'rgba(80, 160, 255, 0.9)';
    ctx.shadowBlur = 25;
    ctx.globalAlpha = 0.85;

    ctx.drawImage(
      frame.bitmap,
      cropX, cropY, cropWidth, cropHeight,
      destX, cropY, cropWidth, cropHeight
    );

    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#4da6ff';
    ctx.fillRect(destX, cropY, cropWidth, cropHeight);

    ctx.restore();
  });
}

// ---------------------------------------------
// Gesture classification
// ---------------------------------------------
function getExtendedFingers(landmarks) {
  const fingers = {
    index: landmarks[8].y < landmarks[6].y,
    middle: landmarks[12].y < landmarks[10].y,
    ring: landmarks[16].y < landmarks[14].y,
    pinky: landmarks[20].y < landmarks[18].y,
  };

  const thumbExtended = Math.abs(landmarks[4].x - landmarks[0].x) > Math.abs(landmarks[3].x - landmarks[0].x);
  fingers.thumb = thumbExtended;

  return fingers;
}

function getHandScale(landmarks) {
  const dx = landmarks[9].x - landmarks[0].x;
  const dy = landmarks[9].y - landmarks[0].y;
  return Math.hypot(dx * canvas.width, dy * canvas.height);
}

function isClawShape(landmarks) {
  const fingers = getExtendedFingers(landmarks);
  const extendedCount = Object.values(fingers).filter(Boolean).length;
  if (extendedCount < 4) return false;

  const scale = getHandScale(landmarks);
  const indexTip = landmarks[8];
  const pinkyTip = landmarks[20];

  const spread = Math.hypot(
    (indexTip.x - pinkyTip.x) * canvas.width,
    (indexTip.y - pinkyTip.y) * canvas.height
  );

  return spread / scale > 1.35;
}

function classifyGesture(landmarks) {
  const fingers = getExtendedFingers(landmarks);
  const extendedCount = Object.values(fingers).filter(Boolean).length;

  if (extendedCount === 0) return 'Fist';
  if (extendedCount >= 4 && isClawShape(landmarks)) return 'Claw';
  if (extendedCount >= 4) return 'Open Palm';

  if (fingers.index && fingers.middle && !fingers.ring && !fingers.pinky) {
    return 'Tiger Seal';
  }

  return 'Unknown';
}

function updateGestureStability(gesture) {
  const now = performance.now();

  if (gesture !== currentGesture) {
    currentGesture = gesture;
    gestureStartTime = now;
    confirmedGesture = null;
    return null;
  }

  const heldFor = now - gestureStartTime;

  if (heldFor >= HOLD_DURATION && confirmedGesture !== gesture) {
    confirmedGesture = gesture;
    return gesture;
  }

  return null;
}

function onGestureConfirmed(gesture) {
  const label = document.getElementById('gesture-label');
  label.style.color = '#00ff88';
  setTimeout(() => {
    label.style.color = '#ff7a00';
  }, 300);

  if (gesture === 'Tiger Seal') {
    cloneModeActive = true;
    cloneModeEndTime = performance.now() + CLONE_MODE_DURATION;
  }
}

function displayGesture(text) {
  const label = document.getElementById('gesture-label');
  label.textContent = text;
}

function drawHand(landmarks) {
  ctx.fillStyle = '#ff7a00';
  for (const point of landmarks) {
    const x = point.x * canvas.width;
    const y = point.y * canvas.height;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// ---------------------------------------------
// Rasengan
// ---------------------------------------------
function checkPalmStillness(landmarks, now) {
  const palmX = landmarks[9].x * canvas.width;
  const palmY = landmarks[9].y * canvas.height;

  if (!palmStillPosition) {
    palmStillPosition = { x: palmX, y: palmY };
    palmStillStartTime = now;
    return false;
  }

  const distance = Math.hypot(palmX - palmStillPosition.x, palmY - palmStillPosition.y);

  if (distance > STILLNESS_THRESHOLD) {
    palmStillPosition = { x: palmX, y: palmY };
    palmStillStartTime = now;
    return false;
  }

  return (now - palmStillStartTime) >= STILLNESS_DURATION;
}

function spawnRasenganParticles() {
  rasenganParticles = [];
  const rings = [
    { count: 30, radius: 30, speed: 0.09 },
    { count: 35, radius: 55, speed: -0.06 },
    { count: 40, radius: 78, speed: 0.045 },
  ];

  rings.forEach((ring) => {
    for (let i = 0; i < ring.count; i++) {
      rasenganParticles.push({
        angle: (Math.PI * 2 * i) / ring.count,
        baseRadius: ring.radius,
        speed: ring.speed,
        size: Math.random() * 2.5 + 1.5,
        wobble: Math.random() * 6,
        hue: Math.random() < 0.6 ? '#4da6ff' : '#ffffff',
      });
    }
  });
  rasenganScale = 0;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function updateAndDrawRasengan(handLandmarks, now) {
  rasenganCenter.x = handLandmarks[9].x * canvas.width;
  rasenganCenter.y = handLandmarks[9].y * canvas.height;

  if (rasenganScale < 1) {
    rasenganScale = Math.min(1, rasenganScale + 0.06);
  }

  const scale = easeOutCubic(rasenganScale);
  const radius = RASENGAN_MAX_RADIUS * scale;

  ctx.save();

  const outerGlow = ctx.createRadialGradient(
    rasenganCenter.x, rasenganCenter.y, radius * 0.3,
    rasenganCenter.x, rasenganCenter.y, radius * 1.8
  );
  outerGlow.addColorStop(0, 'rgba(77, 166, 255, 0.35)');
  outerGlow.addColorStop(1, 'rgba(77, 166, 255, 0)');
  ctx.fillStyle = outerGlow;
  ctx.beginPath();
  ctx.arc(rasenganCenter.x, rasenganCenter.y, radius * 1.8, 0, Math.PI * 2);
  ctx.fill();

  const core = ctx.createRadialGradient(
    rasenganCenter.x, rasenganCenter.y, 0,
    rasenganCenter.x, rasenganCenter.y, radius
  );
  core.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  core.addColorStop(0.35, 'rgba(150, 210, 255, 0.85)');
  core.addColorStop(0.7, 'rgba(60, 140, 255, 0.55)');
  core.addColorStop(1, 'rgba(30, 90, 200, 0.15)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(rasenganCenter.x, rasenganCenter.y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = 'lighter';

  const streakCount = 4;
  for (let i = 0; i < streakCount; i++) {
    const streakAngle = (now * 0.0015) + (i * (Math.PI * 2 / streakCount));
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(180, 220, 255, 0.5)';
    ctx.lineWidth = 3;
    for (let a = 0; a < Math.PI * 1.3; a += 0.1) {
      const r = (radius * 0.9) * (a / (Math.PI * 1.3));
      const x = rasenganCenter.x + Math.cos(streakAngle + a * 2) * r;
      const y = rasenganCenter.y + Math.sin(streakAngle + a * 2) * r;
      if (a === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  rasenganParticles.forEach((p) => {
    p.angle += p.speed;
    const wobbleOffset = Math.sin(now * 0.005 + p.angle) * p.wobble;
    const r = (p.baseRadius + wobbleOffset) * scale;
    const x = rasenganCenter.x + Math.cos(p.angle) * r;
    const y = rasenganCenter.y + Math.sin(p.angle) * r;

    ctx.beginPath();
    ctx.arc(x, y, p.size * scale, 0, Math.PI * 2);
    ctx.fillStyle = p.hue;
    ctx.shadowColor = '#4da6ff';
    ctx.shadowBlur = 10;
    ctx.fill();
  });

  ctx.restore();
}

// ---------------------------------------------
// Chidori
// ---------------------------------------------

// Midpoint-displacement jagged line — THIS was the missing piece
function generateBolt(x1, y1, x2, y2, displace, depth) {
  if (depth === 0) {
    return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  }

  const midX = (x1 + x2) / 2 + (Math.random() - 0.5) * displace;
  const midY = (y1 + y2) / 2 + (Math.random() - 0.5) * displace;

  const left = generateBolt(x1, y1, midX, midY, displace / 2, depth - 1);
  const right = generateBolt(midX, midY, x2, y2, displace / 2, depth - 1);

  return [...left, ...right.slice(1)];
}

function generateBranchingBolt(x1, y1, angle, length, displace, depth, maxDepth) {
  const endX = x1 + Math.cos(angle) * length;
  const endY = y1 + Math.sin(angle) * length;

  const points = generateBolt(x1, y1, endX, endY, displace, 4);
  const segments = [{ points, depth }];

  if (depth < maxDepth) {
    const branchCount = depth === 0 ? 2 : 1;
    for (let i = 0; i < branchCount; i++) {
      if (Math.random() > 0.55 + depth * 0.15) continue;

      const branchPoint = points[Math.floor(points.length * (0.3 + Math.random() * 0.4))];
      const branchAngle = angle + (Math.random() - 0.5) * 1.3;
      const branchLength = length * (0.45 + Math.random() * 0.2);

      const childSegments = generateBranchingBolt(
        branchPoint.x, branchPoint.y,
        branchAngle, branchLength,
        displace * 0.5, depth + 1, maxDepth
      );
      segments.push(...childSegments);
    }
  }

  return segments;
}

function regenerateChidoriBolts(handLandmarks) {
  const scale = getHandScale(handLandmarks);
  const tipIndexes = [4, 8, 12, 16, 20];
  const allSegments = [];

  tipIndexes.forEach((idx) => {
    const originX = handLandmarks[idx].x * canvas.width;
    const originY = handLandmarks[idx].y * canvas.height;
    const angle = Math.random() * Math.PI * 2;
    const length = scale * (0.9 + Math.random() * 0.7);

    const segments = generateBranchingBolt(originX, originY, angle, length, scale * 0.35, 0, 2);
    allSegments.push(...segments);
  });

  chidoriBolts = allSegments;
}

function drawChidori(handLandmarks, now) {
  if (now - lastBoltRegenTime > BOLT_REGEN_INTERVAL) {
    regenerateChidoriBolts(handLandmarks);
    lastBoltRegenTime = now;
    flashIntensity = Math.random() < 0.25 ? (0.5 + Math.random() * 0.5) : 0.15;
  }

  ctx.save();

  const shakeX = (Math.random() - 0.5) * 3;
  const shakeY = (Math.random() - 0.5) * 3;
  ctx.translate(shakeX, shakeY);

  ctx.globalCompositeOperation = 'lighter';

  chidoriBolts.forEach((segment) => {
    const baseWidth = Math.max(0.6, 3.5 - segment.depth * 1.2);

    ctx.beginPath();
    ctx.strokeStyle = `rgba(130, 190, 255, ${0.5 - segment.depth * 0.1})`;
    ctx.lineWidth = baseWidth + 4;
    ctx.shadowColor = '#4da6ff';
    ctx.shadowBlur = 18;
    segment.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = baseWidth * 0.5;
    ctx.shadowBlur = 0;
    segment.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  });

  ctx.restore();

  if (flashIntensity > 0.2) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(150, 200, 255, ${flashIntensity * 0.12})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

// ---------------------------------------------
// Main detection loop
// ---------------------------------------------
function detectLoop() {
  const now = performance.now();
  const results = handLandmarker.detectForVideo(video, now);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  captureFrame(now);

  if (cloneModeActive) {
    if (now > cloneModeEndTime) {
      cloneModeActive = false;
    } else if (results.landmarks && results.landmarks.length > 0) {
      drawClones(now, results.landmarks[0]);
    }
  }

  if (results.landmarks && results.landmarks.length > 0) {
    const hand = results.landmarks[0];
    drawHand(hand);

    const gesture = classifyGesture(hand);
    displayGesture(gesture);

    const newlyConfirmed = updateGestureStability(gesture);
    if (newlyConfirmed) {
      onGestureConfirmed(newlyConfirmed);
    }

    chidoriActive = gesture === 'Claw';
    if (chidoriActive) {
      drawChidori(hand, now);
    }

    if (gesture === 'Open Palm') {
      const isStill = checkPalmStillness(hand, now);
      if (isStill && !rasenganActive) {
        rasenganActive = true;
        spawnRasenganParticles();
      }
    } else {
      rasenganActive = false;
      palmStillPosition = null;
    }

    if (rasenganActive) {
      updateAndDrawRasengan(hand, now);
    }
  } else {
    displayGesture('No hand detected');
    updateGestureStability('Unknown');
    rasenganActive = false;
    palmStillPosition = null;
  }

  requestAnimationFrame(detectLoop);
}

// ---------------------------------------------
// Boot
// ---------------------------------------------
async function init() {
  await setupHandLandmarker();
  await setupWebcam();
  detectLoop();
}