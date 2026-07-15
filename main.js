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
const bgCanvas = document.getElementById('particle-bg');
const bgCtx = bgCanvas.getContext('2d');
bgCanvas.width = window.innerWidth;
bgCanvas.height = window.innerHeight;

const embers = Array.from({ length: 40 }, () => ({
  x: Math.random() * bgCanvas.width,
  y: Math.random() * bgCanvas.height,
  radius: Math.random() * 2 + 1,
  speed: Math.random() * 0.5 + 0.2,
  drift: Math.random() * 0.4 - 0.2,
  opacity: Math.random() * 0.5 + 0.2
}));

function animateEmbers() {
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

  embers.forEach((ember) => {
    ember.y -= ember.speed;
    ember.x += ember.drift;

    if (ember.y < 0) {
      ember.y = bgCanvas.height;
      ember.x = Math.random() * bgCanvas.width;
    }

    bgCtx.beginPath();
    bgCtx.arc(ember.x, ember.y, ember.radius, 0, Math.PI * 2);
    bgCtx.fillStyle = `rgba(255, 122, 0, ${ember.opacity})`;
    bgCtx.fill();
  });

  requestAnimationFrame(animateEmbers);
}

animateEmbers();

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
  fromScreen.style.animation = 'none';
  toScreen.style.animation = 'none';

  fromScreen.classList.remove('active');
  toScreen.classList.add('active');

  toScreen.style.clipPath = 'circle(0% at 50% 50%)';
  toScreen.style.transition = 'clip-path 0.6s ease';

  requestAnimationFrame(() => {
    toScreen.style.clipPath = 'circle(150% at 50% 50%)';
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

document.getElementById('start-btn').addEventListener('click', () => {
  titleScreen.classList.remove('active');
  instructionsScreen.classList.add('active');
});

document.getElementById('enter-btn').addEventListener('click', async () => {
  instructionsScreen.classList.remove('active');
  liveScreen.classList.add('active');
  await init(); // only start the camera + model once the user actually enters
});


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
  if (cloneModeActive) {
  if (now > cloneModeEndTime) {
    cloneModeActive = false;
  } else if (results.landmarks && results.landmarks.length > 0) {
    drawClones(now, results.landmarks[0]);
  }
}

  captureFrame(now); // keep recording, always, regardless of clone mode

  if (cloneModeActive) {
    if (now > cloneModeEndTime) {
      cloneModeActive = false;
    } else {
      drawClones(now);
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
  } else {
    displayGesture('No hand detected');
    updateGestureStability('Unknown');
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

  if (extendedCount >= 4) return 'Open Palm';
  if (extendedCount === 0) return 'Fist';

  if (fingers.index && fingers.middle && !fingers.ring && !fingers.pinky) {
    return 'Tiger Seal';
  }

  return 'Unknown';
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

// Boot everything up
async function init() {
  await setupHandLandmarker();
  await setupWebcam();
  detectLoop();
}

