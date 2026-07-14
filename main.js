import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

let handLandmarker;

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


function detectLoop() {
  const results = handLandmarker.detectForVideo(video, performance.now());

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (results.landmarks && results.landmarks.length > 0) {
    for (const hand of results.landmarks) {
      drawHand(hand);

      const gesture = classifyGesture(hand);
      displayGesture(gesture);
    }
  } else {
    displayGesture('No hand detected');
  }

  requestAnimationFrame(detectLoop);
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