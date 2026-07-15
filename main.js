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

let lastCaptureTime = 0;
let handLandmarker;
let currentGesture = 'Unknown';
let gestureStartTime = null;
let confirmedGesture = null;
let cloneModeActive = false;
let cloneModeEndTime = 0;


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

function drawClones(now) {
  const offsets = [-180, 180, -360]; // horizontal pixel offsets per clone

  CLONE_DELAYS.forEach((delay, i) => {
    const targetTime = now - delay;
    const frame = findClosestFrame(targetTime);
    if (!frame) return;

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.drawImage(frame.bitmap, offsets[i], 0, canvas.width, canvas.height);
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

init();