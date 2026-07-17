import { initBackground } from './three-bg.js';
import gsap from 'gsap';

initBackground();



import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');
const frameBuffer = [];
const CAPTURE_INTERVAL = 100; // capture a snapshot every 100ms
const BUFFER_LIFESPAN = 3000; // discard snapshots older than 3 seconds
const HOLD_DURATION = 600; // milliseconds
const CLONE_MODE_DURATION = 6000; // effect lasts 6 seconds
const CLONE_DELAYS = [300, 600, 900]; // ms behind real-time, one per clone



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

      // If entering instructions screen, stagger the jutsu cards in
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




let lastCaptureTime = 0;
let handLandmarker;
let currentGesture = 'Unknown';
let gestureStartTime = null;
let confirmedGesture = null;
let cloneModeActive = false;
let cloneModeEndTime = 0;
const titleScreen = document.getElementById('title-screen');
const instructionsScreen = document.getElementById('instructions-screen');
const liveScreen = document.getElementById('live-screen');




async function captureFrame(now) {
  if (now - lastCaptureTime < CAPTURE_INTERVAL) return;
  lastCaptureTime = now;

  const bitmap = await createImageBitmap(video);
  frameBuffer.push({ time: now, bitmap });

  // Clean up old frames so memory doesn't grow forever
  while (frameBuffer.length && now - frameBuffer[0].time > BUFFER_LIFESPAN) {
    const old = frameBuffer.shift();
    old.bitmap.close(); // releases the image from memory
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
  // Use the wrist position (landmark 0) as an anchor for where the "person" roughly is
  const anchorX = handLandmark[0].x * canvas.width;
  const anchorY = handLandmark[0].y * canvas.height;

  const cropWidth = 260;
  const cropHeight = 400;

  // Center the crop box around the hand, biased upward (torso is above the hand)
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

    // Soft chakra-blue glow around the clone
    ctx.shadowColor = 'rgba(80, 160, 255, 0.9)';
    ctx.shadowBlur = 25;
    ctx.globalAlpha = 0.85;

    ctx.drawImage(
      frame.bitmap,
      cropX, cropY, cropWidth, cropHeight,   // source crop region
      destX, cropY, cropWidth, cropHeight    // destination position
    );

    // Blue tint overlay to sell the "chakra clone" look
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#4da6ff';
    ctx.fillRect(destX, cropY, cropWidth, cropHeight);

    ctx.restore();
  });
}
// Load the hand detection model
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

// Turn on the webcam
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



function updateGestureStability(gesture) {
  const now = performance.now();

  if (gesture !== currentGesture) {
    // gesture changed — reset the timer
    currentGesture = gesture;
    gestureStartTime = now;
    confirmedGesture = null;
    return null;
  }

  // same gesture as last frame — check how long it's been held
  const heldFor = now - gestureStartTime;

  if (heldFor >= HOLD_DURATION && confirmedGesture !== gesture) {
    confirmedGesture = gesture;
    return gesture; // newly confirmed!
  }

  return null; // still holding, not confirmed yet
}

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

    if (gesture === 'Claw') {
      chidoriActive = true;
     } else {
       chidoriActive = false;
    }  

if (chidoriActive) {
  drawChidori(hand, now);
}

    // Rasengan: separate check, based on stillness of an open palm
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


function getExtendedFingers(landmarks) {
  const fingers = {
    index: landmarks[8].y < landmarks[6].y,
    middle: landmarks[12].y < landmarks[10].y,
    ring: landmarks[16].y < landmarks[14].y,
    pinky: landmarks[20].y < landmarks[18].y,
  };

  // Thumb is different — check x distance from palm instead of y
  // (works reasonably for a mirrored front-facing camera)
  const thumbExtended = Math.abs(landmarks[4].x - landmarks[0].x) > Math.abs(landmarks[3].x - landmarks[0].x);
  fingers.thumb = thumbExtended;

  return fingers;
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

let palmStillStartTime = null;
let palmStillPosition = null;
const STILLNESS_THRESHOLD = 15; // pixels of allowed movement
const STILLNESS_DURATION = 800; // ms of holding still to trigger

function checkPalmStillness(landmarks, now) {
  const palmX = landmarks[9].x * canvas.width; // middle knuckle, a stable palm-center point
  const palmY = landmarks[9].y * canvas.height;

  if (!palmStillPosition) {
    palmStillPosition = { x: palmX, y: palmY };
    palmStillStartTime = now;
    return false;
  }

  const distance = Math.hypot(palmX - palmStillPosition.x, palmY - palmStillPosition.y);

  if (distance > STILLNESS_THRESHOLD) {
    // moved too much, reset the timer
    palmStillPosition = { x: palmX, y: palmY };
    palmStillStartTime = now;
    return false;
  }

  return (now - palmStillStartTime) >= STILLNESS_DURATION;
}

let rasenganActive = false;
let rasenganParticles = [];
let rasenganCenter = { x: 0, y: 0 };
let rasenganScale = 0; // animates 0 -> 1 on activation
const RASENGAN_MAX_RADIUS = 85; // much bigger than before

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

function updateAndDrawRasengan(handLandmarks, now) {
  rasenganCenter.x = handLandmarks[9].x * canvas.width;
  rasenganCenter.y = handLandmarks[9].y * canvas.height;

  // Grow the orb smoothly to full size
  if (rasenganScale < 1) {
    rasenganScale = Math.min(1, rasenganScale + 0.06);
  }

  const scale = easeOutCubic(rasenganScale);
  const radius = RASENGAN_MAX_RADIUS * scale;

  ctx.save();

  // ---- Outer soft glow (large, faint, extends past the sphere) ----
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

  // ---- Core sphere gradient (bright white center, blue mid, dark edge) ----
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

  // ---- Additive blending for everything drawn after this point ----
  ctx.globalCompositeOperation = 'lighter';

  // ---- Rotating spiral streaks (the visible "swirl" texture) ----
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

  // ---- Orbiting particles, additive ----
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

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
// Draw dots on each landmark, just to see it working
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

// CHIDORI //
function getHandScale(landmarks) {
  // distance from wrist to middle knuckle — a stable per-person, per-distance size reference
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

  // spread relative to hand size — scale-invariant, works whether hand is close or far from camera
  return spread / scale > 1.35;
}

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

let chidoriActive = false;
let chidoriBolts = [];
let lastBoltRegenTime = 0;
const BOLT_REGEN_INTERVAL = 70; // ms — how often bolts refresh, creates the "crackle" flicker

function regenerateChidoriBolts(handLandmarks) {
  const scale = getHandScale(handLandmarks);
  const tipIndexes = [4, 8, 12, 16, 20]; // thumb + all fingertips as bolt origins
  const bolts = [];

  tipIndexes.forEach((idx) => {
    const originX = handLandmarks[idx].x * canvas.width;
    const originY = handLandmarks[idx].y * canvas.height;

    // Each origin shoots 1-2 bolts outward in a random direction
    const boltCount = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < boltCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const length = scale * (0.8 + Math.random() * 0.9);
      const endX = originX + Math.cos(angle) * length;
      const endY = originY + Math.sin(angle) * length;

      const points = generateBolt(originX, originY, endX, endY, scale * 0.4, 4);
      bolts.push({ points, width: Math.random() * 2 + 1.5 });

      // Small branch fork off a random point along the main bolt
      if (Math.random() < 0.6) {
        const forkStart = points[Math.floor(points.length / 2)];
        const forkAngle = angle + (Math.random() - 0.5) * 1.5;
        const forkLength = length * 0.4;
        const forkEnd = {
          x: forkStart.x + Math.cos(forkAngle) * forkLength,
          y: forkStart.y + Math.sin(forkAngle) * forkLength,
        };
        const forkPoints = generateBolt(forkStart.x, forkStart.y, forkEnd.x, forkEnd.y, scale * 0.2, 2);
        bolts.push({ points: forkPoints, width: 1 });
      }
    }
  });

  chidoriBolts = bolts;
}

function drawChidori(handLandmarks, now) {
  if (now - lastBoltRegenTime > BOLT_REGEN_INTERVAL) {
    regenerateChidoriBolts(handLandmarks);
    lastBoltRegenTime = now;
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  chidoriBolts.forEach((bolt) => {
    // Outer glow pass
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.5)';
    ctx.lineWidth = bolt.width + 4;
    ctx.shadowColor = '#4da6ff';
    ctx.shadowBlur = 15;
    bolt.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // Sharp white core pass
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = bolt.width * 0.5;
    ctx.shadowBlur = 0;
    bolt.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  });

  ctx.restore();
}
// Boot everything up
async function init() {
  await setupHandLandmarker();
  await setupWebcam();
  detectLoop();
}

